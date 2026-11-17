import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

import type { RedactedConfigDiagnostic } from "../../core/src/config-shape.ts";

export type RealExportSummary = {
  schemaVersion: "real-export-summary-v1";
  exportFormat: "shadowrocket-vless-reality";
  generatedCount: number;
  skippedCount: number;
  outputFile?: string;
  summaryFile?: string;
  readinessFile?: string;
  containsRealSecret: boolean;
  printedToConsole: false;
  rawSecretValuesEmitted: false;
  exportsGitignored: boolean;
  diagnostics: RedactedConfigDiagnostic[];
};

export type ExportReadinessReport = {
  schemaVersion: "export-readiness-v1";
  exportFormat: "shadowrocket-vless-reality";
  ready: false;
  generatedCount: 0;
  skippedCount: number;
  linksFileCreated: false;
  containsRealSecret: false;
  printedToConsole: false;
  rawSecretValuesEmitted: false;
  diagnostics: RedactedConfigDiagnostic[];
};

export type ShadowrocketExportLocalConfig = {
  serverAddress?: string;
  remotePublicHost?: string;
  exportHost?: string;
  publicKey?: string;
  fingerprint?: string;
  sniMode: "use-first-server-name" | "explicit";
  serverName?: string;
  allowUseServerNamesFromConfig: boolean;
  remarksPrefix?: string;
  includeFlow: boolean;
};

export type ShadowrocketExportLocalConfigLoadResult = {
  exists: boolean;
  config?: ShadowrocketExportLocalConfig;
  diagnostics: RedactedConfigDiagnostic[];
};

export type RealExportResult = {
  status: "generated" | "not-ready" | "refused";
  summary: RealExportSummary;
  readinessReport?: ExportReadinessReport;
};

export type ShadowrocketRealExportOptions = {
  allowRealLocalExport: boolean;
  exportsGitignored: boolean;
  timestamp: string;
  outputDirectory?: string;
  exportLocalConfigPresent?: boolean;
  exportLocalConfig?: ShadowrocketExportLocalConfig;
  diagnostics?: RedactedConfigDiagnostic[];
};

type ExportableClient = {
  displayName: string;
  id?: string;
  flow?: string;
};

type InboundExportContext = {
  inboundIndex: number;
  protocol: string;
  network: string;
  security: string;
  port?: number;
  serverAddress?: string;
  serverName?: string;
  shortId?: string;
  privateKey?: string;
  publicKey?: string;
  fingerprint?: string;
  includeFlow: boolean;
  clients: ExportableClient[];
};

const exportRoot = "exports/shadowrocket";
const linkScheme = "vless" + "://";
const defaultExportLocalConfigPath = "secrets/shadowrocket-export.local.json";

export function hasRealExportConfirmation(env: Record<string, string | undefined>, argv: readonly string[]): boolean {
  return env.ALLOW_REAL_LOCAL_EXPORT === "true" || argv.includes("--allow-real-local-export");
}

export function loadShadowrocketExportLocalConfig(
  configPath = defaultExportLocalConfigPath
): ShadowrocketExportLocalConfigLoadResult {
  if (!existsSync(configPath)) {
    return {
      exists: false,
      diagnostics: [
        {
          severity: "warning",
          code: "EXPORT_LOCAL_CONFIG_MISSING",
          message: "Shadowrocket export local config was not found."
        }
      ]
    };
  }

  try {
    return {
      exists: true,
      config: parseShadowrocketExportLocalConfig(JSON.parse(readFileSync(configPath, "utf8"))),
      diagnostics: []
    };
  } catch {
    return {
      exists: true,
      diagnostics: [
        {
          severity: "error",
          code: "EXPORT_LOCAL_CONFIG_INVALID",
          message: "Shadowrocket export local config could not be parsed."
        }
      ]
    };
  }
}

export function parseShadowrocketExportLocalConfig(input: unknown): ShadowrocketExportLocalConfig {
  const value = isRecord(input) ? input : {};
  const sniMode = stringValue(value.sniMode);
  const serverAddress = normalizeExportHost(
    stringValue(value.remotePublicHost),
    stringValue(value.exportHost),
    stringValue(value.serverAddress),
    stringValue(process.env.VPN_EXPORT_HOST)
  );

  return {
    serverAddress,
    remotePublicHost: serverAddress,
    exportHost: serverAddress,
    publicKey: stringValue(value.publicKey),
    fingerprint: stringValue(value.fingerprint),
    sniMode: sniMode === "explicit" ? "explicit" : "use-first-server-name",
    serverName: stringValue(value.serverName),
    allowUseServerNamesFromConfig: value.allowUseServerNamesFromConfig === true,
    remarksPrefix: stringValue(value.remarksPrefix),
    includeFlow: value.includeFlow !== false
  };
}

export function runShadowrocketRealExport(input: unknown, options: ShadowrocketRealExportOptions): RealExportResult {
  const outputDirectory = options.outputDirectory ?? exportRoot;
  const diagnostics: RedactedConfigDiagnostic[] = [...(options.diagnostics ?? [])];

  if (!options.allowRealLocalExport) {
    diagnostics.push({
      severity: "error",
      code: "REAL_LOCAL_EXPORT_NOT_CONFIRMED",
      message: "Real local export requires an explicit allow flag."
    });
    return refusedSummary(options, outputDirectory, diagnostics);
  }

  if (!options.exportsGitignored) {
    diagnostics.push({
      severity: "error",
      code: "EXPORTS_NOT_GITIGNORED",
      message: "Real export refused because exports/ is not covered by .gitignore."
    });
    return refusedSummary(options, outputDirectory, diagnostics);
  }

  assertOutputDirectoryAllowed(outputDirectory);

  const contexts = collectInboundExportContexts(input, options.exportLocalConfig);
  const totalClientCount = contexts.reduce((count, context) => count + context.clients.length, 0);

  if (options.exportLocalConfigPresent !== true || !options.exportLocalConfig) {
    diagnostics.push({
      severity: "error",
      code: "EXPORT_LOCAL_CONFIG_MISSING",
      message: "Shadowrocket export local config is required before real links can be generated."
    });
    return writeReadinessReport(options, outputDirectory, totalClientCount, diagnostics);
  }

  const localConfig = options.exportLocalConfig;
  const linkLines: string[] = [];
  let skippedCount = 0;

  contexts.forEach((context) => {
    context.clients.forEach((client) => {
      const missing = missingFields(context, client);

      if (context.privateKey && context.publicKey && context.privateKey === context.publicKey) {
        missing.push("publicKey");
        diagnostics.push({
          severity: "error",
          code: "PUBLIC_KEY_MATCHES_PRIVATE_KEY",
          message: `${client.displayName} was skipped because the public key matched the server private key.`
        });
      }

      if (missing.length > 0) {
        skippedCount += 1;
        diagnostics.push({
          severity: "warning",
          code: "CLIENT_EXPORT_FIELDS_MISSING",
          message: `${client.displayName} was skipped because required fields were missing: ${missing.join(", ")}.`
        });
        return;
      }

      linkLines.push(createShadowrocketLink(context, client, localConfig));
    });
  });

  if (linkLines.length === 0) {
    return writeReadinessReport(options, outputDirectory, skippedCount, diagnostics);
  }

  return writeGeneratedExport(options, outputDirectory, linkLines, skippedCount, diagnostics);
}

export function createConsoleSafeExportSummary(result: RealExportResult) {
  return {
    status: result.status,
    generatedCount: result.summary.generatedCount,
    skippedCount: result.summary.skippedCount,
    linksFile: result.summary.outputFile ?? null,
    summaryFile: result.summary.summaryFile ?? null,
    readinessFile: result.summary.readinessFile ?? null,
    containsRealSecret: result.summary.containsRealSecret,
    printedToConsole: result.summary.printedToConsole,
    rawSecretValuesEmitted: result.summary.rawSecretValuesEmitted,
    exportsGitignored: result.summary.exportsGitignored,
    diagnostics: result.summary.diagnostics
  };
}

function refusedSummary(
  options: ShadowrocketRealExportOptions,
  outputDirectory: string,
  diagnostics: RedactedConfigDiagnostic[]
): RealExportResult {
  assertOutputDirectoryAllowed(outputDirectory);
  return {
    status: "refused",
    summary: {
      schemaVersion: "real-export-summary-v1",
      exportFormat: "shadowrocket-vless-reality",
      generatedCount: 0,
      skippedCount: 0,
      containsRealSecret: false,
      printedToConsole: false,
      rawSecretValuesEmitted: false,
      exportsGitignored: options.exportsGitignored,
      diagnostics
    }
  };
}

function writeReadinessReport(
  options: ShadowrocketRealExportOptions,
  outputDirectory: string,
  skippedCount: number,
  diagnostics: RedactedConfigDiagnostic[]
): RealExportResult {
  const readinessFile = join(outputDirectory, `export-readiness-${options.timestamp}.json`);
  const report: ExportReadinessReport = {
    schemaVersion: "export-readiness-v1",
    exportFormat: "shadowrocket-vless-reality",
    ready: false,
    generatedCount: 0,
    skippedCount,
    linksFileCreated: false,
    containsRealSecret: false,
    printedToConsole: false,
    rawSecretValuesEmitted: false,
    diagnostics
  };

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(readinessFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return {
    status: "not-ready",
    summary: {
      schemaVersion: "real-export-summary-v1",
      exportFormat: "shadowrocket-vless-reality",
      generatedCount: 0,
      skippedCount,
      readinessFile,
      containsRealSecret: false,
      printedToConsole: false,
      rawSecretValuesEmitted: false,
      exportsGitignored: options.exportsGitignored,
      diagnostics
    },
    readinessReport: report
  };
}

function writeGeneratedExport(
  options: ShadowrocketRealExportOptions,
  outputDirectory: string,
  linkLines: string[],
  skippedCount: number,
  diagnostics: RedactedConfigDiagnostic[]
): RealExportResult {
  const linksFile = join(outputDirectory, `shadowrocket-links-${options.timestamp}.txt`);
  const summaryFile = join(outputDirectory, `shadowrocket-summary-${options.timestamp}.json`);
  const summary: RealExportSummary = {
    schemaVersion: "real-export-summary-v1",
    exportFormat: "shadowrocket-vless-reality",
    generatedCount: linkLines.length,
    skippedCount,
    outputFile: linksFile,
    summaryFile,
    containsRealSecret: true,
    printedToConsole: false,
    rawSecretValuesEmitted: false,
    exportsGitignored: options.exportsGitignored,
    diagnostics
  };

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(linksFile, `${linkLines.join("\n")}\n`, "utf8");
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  return {
    status: "generated",
    summary
  };
}

export function createShadowrocketLink(
  context: InboundExportContext,
  client: ExportableClient,
  localConfig: ShadowrocketExportLocalConfig
): string {
  const query = new URLSearchParams();
  query.set("encryption", "none");
  query.set("security", "reality");
  query.set("sni", required(context.serverName));
  query.set("fp", required(context.fingerprint));
  query.set("pbk", required(context.publicKey));
  query.set("sid", context.shortId ?? "");
  query.set("type", context.network);
  if (localConfig.includeFlow) {
    query.set("flow", required(client.flow));
  }

  return `${linkScheme}${encodeURIComponent(required(client.id))}@${formatAddress(required(context.serverAddress))}:${context.port}?${query.toString()}#${encodeURIComponent(displayName(localConfig, client))}`;
}

function collectInboundExportContexts(
  input: unknown,
  localConfig: ShadowrocketExportLocalConfig | undefined
): InboundExportContext[] {
  const root = isRecord(input) ? input : {};
  const config = isRecord(root.xray) ? root.xray : root;

  return arrayValue(config.inbounds).map((inbound, inboundIndex): InboundExportContext => {
    const inboundRecord = isRecord(inbound) ? inbound : {};
    const settings = isRecord(inboundRecord.settings) ? inboundRecord.settings : {};
    const streamSettings = isRecord(inboundRecord.streamSettings) ? inboundRecord.streamSettings : {};
    const realitySettings = isRecord(streamSettings.realitySettings) ? streamSettings.realitySettings : {};
    const clients = arrayValue(settings.clients).map((client, clientIndex) => {
      const clientRecord = isRecord(client) ? client : {};
      return {
        displayName: `Client #${clientIndex + 1}`,
        id: stringValue(clientRecord.id),
        flow: stringValue(clientRecord.flow)
      };
    });

    return {
      inboundIndex,
      protocol: stringValue(inboundRecord.protocol) ?? "unknown",
      network: stringValue(streamSettings.network) ?? "tcp",
      security: stringValue(streamSettings.security) ?? "unspecified",
      port: numberValue(inboundRecord.port),
      serverAddress: localConfig?.serverAddress,
      serverName: serverNameForExport(localConfig, realitySettings),
      shortId: firstString(firstArrayString(realitySettings.shortIds), stringValue(realitySettings.shortId)),
      privateKey: stringValue(realitySettings.privateKey),
      publicKey: localConfig?.publicKey,
      fingerprint: localConfig?.fingerprint,
      includeFlow: localConfig?.includeFlow !== false,
      clients
    };
  });
}

function missingFields(context: InboundExportContext, client: ExportableClient): string[] {
  const missing: string[] = [];

  if (context.protocol !== "vless") {
    missing.push("protocol=vless");
  }
  if (context.security !== "reality") {
    missing.push("security=reality");
  }
  if (!context.port) {
    missing.push("port");
  }
  if (!context.serverAddress || looksLikeMockExportHost(context.serverAddress)) {
    missing.push("serverAddress");
  }
  if (!context.serverName) {
    missing.push("serverName");
  }
  if (!context.shortId) {
    missing.push("shortId");
  }
  if (!context.publicKey) {
    missing.push("publicKey");
  }
  if (!context.fingerprint) {
    missing.push("fingerprint");
  }
  if (!client.id) {
    missing.push("uuid");
  }
  if (context.includeFlow && !client.flow) {
    missing.push("flow");
  }

  return [...new Set(missing)];
}

function assertOutputDirectoryAllowed(outputDirectory: string): void {
  const base = resolve(exportRoot);
  const target = resolve(outputDirectory);
  const location = relative(base, target);

  if (location.startsWith("..") || resolve(target) === resolve("exports")) {
    throw new Error("Real export output directory must be inside exports/shadowrocket.");
  }
}

function serverNameForExport(
  localConfig: ShadowrocketExportLocalConfig | undefined,
  realitySettings: Record<string, unknown>
): string | undefined {
  if (!localConfig) {
    return undefined;
  }
  if (localConfig.sniMode === "explicit") {
    return localConfig.serverName;
  }
  if (localConfig.allowUseServerNamesFromConfig) {
    return firstArrayString(realitySettings.serverNames);
  }
  return undefined;
}

function displayName(localConfig: ShadowrocketExportLocalConfig, client: ExportableClient): string {
  return localConfig.remarksPrefix ? `${localConfig.remarksPrefix} ${client.displayName}` : client.displayName;
}

function formatAddress(address: string): string {
  return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}

function required(value: string | undefined): string {
  if (!value) {
    throw new Error("Required export value was missing after readiness checks.");
  }
  return value;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}

function firstArrayString(value: unknown): string | undefined {
  return arrayValue(value).find((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeExportHost(...values: Array<string | undefined>): string | undefined {
  const selected = values.find((value) => value !== undefined && value.trim().length > 0);
  if (!selected || looksLikeMockExportHost(selected)) {
    return undefined;
  }
  return selected.trim();
}

function looksLikeMockExportHost(value: string): boolean {
  return /(^|\.)mock\.example\.com$/i.test(value.trim()) || /\b(mock|example|fallback)\b/i.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
