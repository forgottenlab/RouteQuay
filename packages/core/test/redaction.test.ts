import test from "node:test";
import assert from "node:assert/strict";

import { containsSensitivePattern, findSensitivePatterns, redactSensitiveText } from "../src/redaction.ts";

test("redacts UUIDs and VLESS import links", () => {
  const input = "client=123e4567-e89b-12d3-a456-426614174000 link=vless://demo@example.invalid:443?flow=xtls-rprx-vision";
  const redacted = redactSensitiveText(input);

  assert.equal(containsSensitivePattern(input), true);
  assert.match(redacted, /\[REDACTED_UUID\]/);
  assert.match(redacted, /\[REDACTED_VLESS_URI\]/);
  assert.equal(containsSensitivePattern(redacted), false);
});

test("redacts privateKey, shortIds, and token fields", () => {
  const input = '{"privateKey":"example-private-value","shortIds":["abcd1234"],"token":"example-token"}';
  const redacted = redactSensitiveText(input);

  assert.match(redacted, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(redacted, /\[REDACTED_SHORT_IDS\]/);
  assert.match(redacted, /\[REDACTED_TOKEN\]/);
  assert.deepEqual(findSensitivePatterns(redacted), []);
});

test("redacts bearer tokens and PEM private key blocks", () => {
  const input = [
    "Authorization: Bearer abc.def.ghi",
    "-----BEGIN PRIVATE KEY-----",
    "not-real-test-key",
    "-----END PRIVATE KEY-----"
  ].join("\n");
  const redacted = redactSensitiveText(input);

  assert.match(redacted, /Bearer \[REDACTED_TOKEN\]/);
  assert.match(redacted, /\[REDACTED_PEM_PRIVATE_KEY\]/);
});
