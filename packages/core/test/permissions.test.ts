import test from "node:test";
import assert from "node:assert/strict";

import {
  canMoveSecretFiles,
  canRunDeploy,
  canRunRemoteReadonly,
  canRunRemoteValidate,
  defaultPermissionFlags
} from "../src/models.ts";

test("permission flags fail closed by default", () => {
  const flags = defaultPermissionFlags();

  assert.equal(canRunRemoteReadonly(flags), false);
  assert.equal(canRunRemoteValidate(flags), false);
  assert.equal(canRunDeploy(flags), false);
  assert.equal(canMoveSecretFiles(flags), false);
});

test("missing partial flags also fail closed", () => {
  assert.equal(canRunRemoteReadonly(), false);
  assert.equal(canRunRemoteValidate({ allowRemoteReadonly: true }), false);
  assert.equal(canRunDeploy({ allowRemoteValidate: true }), false);
  assert.equal(canMoveSecretFiles({ allowDeploy: true }), false);
});
