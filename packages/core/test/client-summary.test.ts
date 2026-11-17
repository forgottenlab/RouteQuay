import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { summarizeXrayClients } from "../src/client-summary.ts";
import { containsSensitivePattern } from "../src/redaction.ts";

test("summarizes local clients without emitting raw identity fields", () => {
  const example = JSON.parse(readFileSync("examples/config.example.json", "utf8"));
  const summary = summarizeXrayClients(example);
  const output = JSON.stringify(summary);

  assert.equal(summary.schemaVersion, "client-inventory-summary-v1");
  assert.equal(summary.clientCount, 1);
  assert.equal(summary.clients[0]?.clientIndex, 0);
  assert.equal(summary.clients[0]?.displayName, "Client #1");
  assert.equal(summary.clients[0]?.idPresent, true);
  assert.equal(summary.clients[0]?.emailPresent, true);
  assert.equal(summary.clients[0]?.flowPresent, true);
  assert.equal(summary.clients[0]?.flowTypePresent, true);
  assert.equal(summary.clients[0]?.inboundIndex, 0);
  assert.equal(summary.clients[0]?.protocol, "vless");
  assert.equal(summary.clients[0]?.security, "reality");
  assert.equal(summary.clients[0]?.enabledAssumed, true);
  assert.equal(summary.contentReadForSummaryOnly, true);
  assert.equal(summary.rawSecretValuesEmitted, false);
  assert.equal(containsSensitivePattern(output), false);
  assert.equal(output.includes("example-client-alpha-id"), false);
  assert.equal(output.includes("alpha@example.invalid"), false);
  assert.equal(output.includes("EXAMPLE_REDACTED_PRIVATE_KEY_DO_NOT_USE"), false);
  assert.equal(output.includes("not-a-real-short-id"), false);
  assert.equal(output.includes("www.example.com"), false);
  assert.equal(/vless:\/\//i.test(output), false);
  assert.equal(/"privateKey"\s*:/i.test(output), false);
  assert.equal(/"shortIds"\s*:/i.test(output), false);
});
