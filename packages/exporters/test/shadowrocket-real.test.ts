import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { containsSensitivePattern } from "../../core/src/redaction.ts";
import {
  createConsoleSafeExportSummary,
  hasRealExportConfirmation,
  loadShadowrocketExportLocalConfig,
  runShadowrocketRealExport
} from "../src/shadowrocket-real.ts";

test("real Shadowrocket export requires explicit confirmation", () => {
  assert.equal(hasRealExportConfirmation({}, []), false);
  assert.equal(hasRealExportConfirmation({ ALLOW_REAL_LOCAL_EXPORT: "true" }, []), true);
  assert.equal(hasRealExportConfirmation({}, ["--allow-real-local-export"]), true);

  const result = runShadowrocketRealExport(fakeReadyConfig(), {
    allowRealLocalExport: false,
    exportsGitignored: true,
    timestamp: "20260528T000000Z",
    outputDirectory: "exports/shadowrocket/test-stage21-refused"
  });

  assert.equal(result.status, "refused");
  assert.equal(result.summary.generatedCount, 0);
  assert.equal(result.summary.containsRealSecret, false);
  assert.equal(result.summary.printedToConsole, false);
  assert.equal(result.summary.rawSecretValuesEmitted, false);
});

test("real Shadowrocket export writes fake links only under exports shadowrocket and keeps summary safe", () => {
  const result = runShadowrocketRealExport(fakeReadyConfig(), {
    allowRealLocalExport: true,
    exportsGitignored: true,
    timestamp: "20260528T000001Z",
    outputDirectory: "exports/shadowrocket/test-stage21-generated",
    exportLocalConfigPresent: true,
    exportLocalConfig: fakeExportLocalConfig()
  });
  const consoleSummary = JSON.stringify(createConsoleSafeExportSummary(result), null, 2);

  assert.equal(result.status, "generated");
  assert.equal(result.summary.generatedCount, 2);
  assert.equal(result.summary.skippedCount, 0);
  assert.equal(result.summary.containsRealSecret, true);
  assert.equal(result.summary.printedToConsole, false);
  assert.equal(result.summary.rawSecretValuesEmitted, false);
  assert.equal(toPortablePath(result.summary.outputFile).startsWith("exports/shadowrocket/"), true);
  assert.equal(toPortablePath(result.summary.summaryFile).startsWith("exports/shadowrocket/"), true);
  assert.equal(existsSync(result.summary.outputFile ?? ""), true);
  assert.equal(existsSync(result.summary.summaryFile ?? ""), true);
  assert.equal(containsSensitivePattern(consoleSummary), false);
  assert.equal(consoleSummary.includes("vless" + "://"), false);

  const summaryText = readFileSync(result.summary.summaryFile ?? "", "utf8");
  assert.equal(containsSensitivePattern(summaryText), false);
  assert.equal(summaryText.includes("vless" + "://"), false);

  const linkText = readFileSync(result.summary.outputFile ?? "", "utf8");
  assert.equal(linkText.includes("vless" + "://"), true);
  assert.equal(linkText.split(/\r?\n/).filter(Boolean).length, 2);
});

test("real Shadowrocket export rejects output outside exports shadowrocket", () => {
  let threw = false;
  try {
    runShadowrocketRealExport(fakeReadyConfig(), {
      allowRealLocalExport: true,
      exportsGitignored: true,
      timestamp: "20260528T000002Z",
      outputDirectory: "exports/not-shadowrocket",
      exportLocalConfigPresent: true,
      exportLocalConfig: fakeExportLocalConfig()
    });
  } catch {
    threw = true;
  }

  assert.equal(threw, true);
});

test("real Shadowrocket export fails closed when public key is missing", () => {
  const result = runShadowrocketRealExport(fakeMissingPublicKeyConfig(), {
    allowRealLocalExport: true,
    exportsGitignored: true,
    timestamp: "20260528T000003Z",
    outputDirectory: "exports/shadowrocket/test-stage21-readiness",
    exportLocalConfigPresent: true,
    exportLocalConfig: fakeExportLocalConfig({ publicKey: "" })
  });
  const reportText = readFileSync(result.summary.readinessFile ?? "", "utf8");

  assert.equal(result.status, "not-ready");
  assert.equal(result.summary.generatedCount, 0);
  assert.equal(result.summary.containsRealSecret, false);
  assert.equal(result.summary.outputFile, undefined);
  assert.equal(existsSync(result.summary.readinessFile ?? ""), true);
  assert.match(reportText, /MISSING|CLIENT_EXPORT_FIELDS_MISSING/);
  assert.equal(containsSensitivePattern(reportText), false);
  assert.equal(reportText.includes("vless" + "://"), false);
});

test("real Shadowrocket export does not use server private key as public key", () => {
  const result = runShadowrocketRealExport(fakePublicEqualsPrivateConfig(), {
    allowRealLocalExport: true,
    exportsGitignored: true,
    timestamp: "20260528T000004Z",
    outputDirectory: "exports/shadowrocket/test-stage21-private-not-public",
    exportLocalConfigPresent: true,
    exportLocalConfig: fakeExportLocalConfig({ publicKey: "fake-server-private-key" })
  });

  assert.equal(result.status, "not-ready");
  assert.equal(result.summary.generatedCount, 0);
  assert.equal(result.summary.diagnostics.some((diagnostic) => diagnostic.code === "PUBLIC_KEY_MATCHES_PRIVATE_KEY"), true);
  assert.equal(result.summary.outputFile, undefined);
});

test("real Shadowrocket export fails closed when local export config is missing", () => {
  const result = runShadowrocketRealExport(fakeReadyConfig(), {
    allowRealLocalExport: true,
    exportsGitignored: true,
    timestamp: "20260528T000005Z",
    outputDirectory: "exports/shadowrocket/test-stage215-missing-local-config",
    exportLocalConfigPresent: false
  });

  assert.equal(result.status, "not-ready");
  assert.equal(result.summary.generatedCount, 0);
  assert.equal(result.summary.skippedCount, 2);
  assert.equal(result.summary.diagnostics.some((diagnostic) => diagnostic.code === "EXPORT_LOCAL_CONFIG_MISSING"), true);
  assert.equal(result.summary.outputFile, undefined);
});

test("real Shadowrocket export refuses mock export host instead of generating links", () => {
  const result = runShadowrocketRealExport(fakeReadyConfig(), {
    allowRealLocalExport: true,
    exportsGitignored: true,
    timestamp: "20260528T000006Z",
    outputDirectory: "exports/shadowrocket/test-stage215-mock-host",
    exportLocalConfigPresent: true,
    exportLocalConfig: fakeExportLocalConfig({ serverAddress: "mock.example.com" })
  });
  const output = JSON.stringify(createConsoleSafeExportSummary(result), null, 2);

  assert.equal(result.status, "not-ready");
  assert.equal(result.summary.generatedCount, 0);
  assert.equal(result.summary.outputFile, undefined);
  assert.equal(/vless:\/\//i.test(output), false);
  assert.equal(containsSensitivePattern(output), false);
});

test("local Shadowrocket export config loader reports missing config without secret output", () => {
  const result = loadShadowrocketExportLocalConfig("secrets/does-not-exist-shadowrocket-export.local.json");
  const output = JSON.stringify(result, null, 2);

  assert.equal(result.exists, false);
  assert.equal(result.config, undefined);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "EXPORT_LOCAL_CONFIG_MISSING"), true);
  assert.equal(containsSensitivePattern(output), false);
  assert.equal(output.includes("vless" + "://"), false);
});

function fakeReadyConfig() {
  return {
    inbounds: [
      {
        port: 443,
        protocol: "vless",
        settings: {
          clients: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              email: "client-one@example.invalid",
              flow: "xtls-rprx-vision"
            },
            {
              id: "00000000-0000-4000-8000-000000000002",
              email: "client-two@example.invalid",
              flow: "xtls-rprx-vision"
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          security: "reality",
          realitySettings: {
            serverNames: ["example.invalid"],
            shortIds: ["abcd1234"],
            privateKey: "fake-server-private-key"
          }
        }
      }
    ]
  };
}

function toPortablePath(value: string | undefined): string {
  return value?.replace(/\\/g, "/") ?? "";
}

function fakeMissingPublicKeyConfig() {
  return fakeReadyConfig();
}

function fakePublicEqualsPrivateConfig() {
  return fakeReadyConfig();
}

function fakeExportLocalConfig(overrides = {}) {
  return {
    serverAddress: "203.0.113.10",
    publicKey: "fake-client-public-key",
    fingerprint: "chrome",
    sniMode: "use-first-server-name" as const,
    allowUseServerNamesFromConfig: true,
    remarksPrefix: "fake-vpn",
    includeFlow: true,
    ...overrides
  };
}
