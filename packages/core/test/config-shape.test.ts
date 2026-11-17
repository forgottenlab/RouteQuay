import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { summarizeXrayConfigShape } from "../src/config-shape.ts";
import { containsSensitivePattern } from "../src/redaction.ts";

test("summarizes redacted example config shape without emitting raw secrets", () => {
  const example = JSON.parse(readFileSync("examples/config.example.json", "utf8"));
  const summary = summarizeXrayConfigShape(example, {
    configFileSize: 1234,
    configModifiedTime: "2026-05-28T00:00:00.000Z"
  });
  const output = JSON.stringify(summary);

  assert.equal(summary.schemaVersion, "config-shape-summary-v1");
  assert.equal(summary.inboundCount, 1);
  assert.equal(summary.outboundCount, 2);
  assert.equal(summary.inbounds[0]?.protocol, "vless");
  assert.equal(summary.inbounds[0]?.network, "tcp");
  assert.equal(summary.inbounds[0]?.security, "reality");
  assert.equal(summary.inbounds[0]?.listenScope, "public");
  assert.equal(summary.inbounds[0]?.clientCount, 1);
  assert.equal(summary.inbounds[0]?.reality.realityEnabled, true);
  assert.equal(summary.inbounds[0]?.reality.serverNamesCount, 1);
  assert.equal(summary.inbounds[0]?.reality.shortIdsCount, 1);
  assert.equal(summary.inbounds[0]?.reality.privateKeyPresent, true);
  assert.equal(summary.inbounds[0]?.reality.destPresent, true);
  assert.equal(summary.contentReadForShapeOnly, true);
  assert.equal(summary.rawSecretValuesEmitted, false);
  assert.equal(containsSensitivePattern(output), false);
  assert.equal(output.includes("EXAMPLE_REDACTED_PRIVATE_KEY_DO_NOT_USE"), false);
  assert.equal(output.includes("not-a-real-short-id"), false);
  assert.equal(output.includes("www.example.com"), false);
  assert.equal(output.includes("alpha@example.invalid"), false);
  assert.equal(/vless:\/\//i.test(output), false);
  assert.equal(/"privateKey"\s*:/i.test(output), false);
  assert.equal(/"shortIds"\s*:/i.test(output), false);
});
