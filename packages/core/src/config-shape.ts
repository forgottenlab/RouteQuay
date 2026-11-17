export type RedactedConfigDiagnostic = {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
};

export type ClientShapeSummary = {
  index: number;
  idPresent: boolean;
  emailPresent: boolean;
  flowPresent: boolean;
};

export type RealityShapeSummary = {
  realityEnabled: boolean;
  serverNamesCount: number;
  shortIdsCount: number;
  privateKeyPresent: boolean;
  destPresent: boolean;
};

export type InboundShapeSummary = {
  index: number;
  protocol: string;
  listenScope: "public" | "loopback" | "interface" | "unspecified" | "unknown";
  portPresent: boolean;
  port?: number;
  network: string;
  security: string;
  clientCount: number;
  clients: ClientShapeSummary[];
  reality: RealityShapeSummary;
};

export type RoutingShapeSummary = {
  routingPresent: boolean;
  ruleCount: number;
};

export type ConfigShapeSummary = {
  schemaVersion: "config-shape-summary-v1";
  inboundCount: number;
  inbounds: InboundShapeSummary[];
  outboundCount: number;
  routingPresent: boolean;
  routing: RoutingShapeSummary;
  configFileSize?: number;
  configModifiedTime?: string;
  contentReadForShapeOnly: true;
  rawSecretValuesEmitted: false;
  diagnostics: RedactedConfigDiagnostic[];
};

type ConfigShapeMetadata = {
  configFileSize?: number;
  configModifiedTime?: string;
};

export function summarizeXrayConfigShape(input: unknown, metadata: ConfigShapeMetadata = {}): ConfigShapeSummary {
  const config = unwrapXrayConfig(input);
  const diagnostics: RedactedConfigDiagnostic[] = [];

  if (!isRecord(config)) {
    return {
      schemaVersion: "config-shape-summary-v1",
      inboundCount: 0,
      inbounds: [],
      outboundCount: 0,
      routingPresent: false,
      routing: { routingPresent: false, ruleCount: 0 },
      configFileSize: metadata.configFileSize,
      configModifiedTime: metadata.configModifiedTime,
      contentReadForShapeOnly: true,
      rawSecretValuesEmitted: false,
      diagnostics: [
        {
          severity: "error",
          code: "CONFIG_NOT_OBJECT",
          message: "Config root is not an object; no secret values were emitted."
        }
      ]
    };
  }

  const inbounds = arrayValue(config.inbounds);
  const outbounds = arrayValue(config.outbounds);
  const routing = isRecord(config.routing) ? config.routing : undefined;

  if (inbounds.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "NO_INBOUNDS",
      message: "No inbound entries were found in the config shape."
    });
  }

  return {
    schemaVersion: "config-shape-summary-v1",
    inboundCount: inbounds.length,
    inbounds: inbounds.map((inbound, index) => summarizeInbound(inbound, index)),
    outboundCount: outbounds.length,
    routingPresent: routing !== undefined,
    routing: {
      routingPresent: routing !== undefined,
      ruleCount: routing ? arrayValue(routing.rules).length : 0
    },
    configFileSize: metadata.configFileSize,
    configModifiedTime: metadata.configModifiedTime,
    contentReadForShapeOnly: true,
    rawSecretValuesEmitted: false,
    diagnostics
  };
}

function unwrapXrayConfig(input: unknown): unknown {
  if (isRecord(input) && isRecord(input.xray)) {
    return input.xray;
  }

  return input;
}

function summarizeInbound(input: unknown, index: number): InboundShapeSummary {
  const inbound = isRecord(input) ? input : {};
  const streamSettings = isRecord(inbound.streamSettings) ? inbound.streamSettings : {};
  const settings = isRecord(inbound.settings) ? inbound.settings : {};
  const clients = arrayValue(settings.clients);
  const realitySettings = isRecord(streamSettings.realitySettings) ? streamSettings.realitySettings : {};
  const security = stringValue(streamSettings.security, "unspecified");

  return {
    index,
    protocol: stringValue(inbound.protocol, "unknown"),
    listenScope: summarizeListenScope(inbound.listen),
    portPresent: typeof inbound.port === "number",
    port: typeof inbound.port === "number" ? inbound.port : undefined,
    network: stringValue(streamSettings.network, "unspecified"),
    security,
    clientCount: clients.length,
    clients: clients.map((client, clientIndex) => summarizeClient(client, clientIndex)),
    reality: {
      realityEnabled: security.toLowerCase() === "reality",
      serverNamesCount: arrayValue(realitySettings.serverNames).length,
      shortIdsCount: arrayValue(realitySettings.shortIds).length,
      privateKeyPresent: hasNonEmptyString(realitySettings.privateKey),
      destPresent: hasNonEmptyString(realitySettings.dest)
    }
  };
}

function summarizeClient(input: unknown, index: number): ClientShapeSummary {
  const client = isRecord(input) ? input : {};

  return {
    index,
    idPresent: hasNonEmptyString(client.id),
    emailPresent: hasNonEmptyString(client.email),
    flowPresent: hasNonEmptyString(client.flow)
  };
}

function summarizeListenScope(value: unknown): InboundShapeSummary["listenScope"] {
  if (typeof value !== "string" || value.length === 0) {
    return "unspecified";
  }
  if (value === "0.0.0.0" || value === "::" || value === "[::]") {
    return "public";
  }
  if (value.startsWith("127.") || value === "localhost" || value === "::1" || value === "[::1]") {
    return "loopback";
  }
  if (value.includes(".")) {
    return "interface";
  }
  return "unknown";
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
