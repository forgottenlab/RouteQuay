import test from "node:test";
import assert from "node:assert/strict";
import jsQRImport from "jsqr";
import { PNG } from "pngjs";

import {
  clientConnectionSpec,
  renderVlessRealityUri,
  validateClientExportFields
} from "../src/client-connection.ts";
import { renderVlessQrPng } from "../src/vless-qr.ts";

const uuid = "11111111-1111-4111-8111-111111111111";
const publicKey = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN12";

function spec() {
  const validated = validateClientExportFields({
    network: "raw",
    flow: "xtls-rprx-vision",
    serverNames: ["www.example.org"],
    shortIds: ["abcdef12"],
    decryption: "none"
  });
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error("fixture");
  return clientConnectionSpec({
    nodeId: "node-a",
    clientRef: "inbound-1-client-1",
    server: "203.0.113.10",
    port: 8443,
    uuid,
    publicKey,
    network: validated.network,
    flow: validated.flow,
    serverName: validated.serverName,
    shortId: validated.shortId,
    encryption: validated.encryption
  });
}

type JsQr = (
  data: Uint8ClampedArray,
  width: number,
  height: number
) => { data: string } | null;
const jsQR = jsQRImport as unknown as JsQr;

function decodeQrPng(buffer: Buffer): string {
  const png = PNG.sync.read(buffer);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(decoded, "QR decode failed");
  return decoded.data;
}

test("vless-qr PNG decodes to the same bytes as the v2rayn URI", () => {
  const connection = spec();
  const uri = renderVlessRealityUri(connection).replace(/\n$/, "");
  const png = renderVlessQrPng(connection);
  assert.equal(
    png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    true
  );
  assert.equal(decodeQrPng(png), uri);
});

test("regenerating the QR with the same spec is byte-identical", () => {
  const connection = spec();
  const first = renderVlessQrPng(connection);
  const second = renderVlessQrPng(connection);
  assert.equal(first.equals(second), true);
});