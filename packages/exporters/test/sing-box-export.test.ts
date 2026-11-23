import test from "node:test";
import assert from "node:assert/strict";

import {
  clientConnectionSpec,
  mihomoGroupName,
  mihomoProxyName,
  validateClientExportFields,
  type ClientConnectionSpec
} from "../src/client-connection.ts";
import { renderClientExport } from "../src/mihomo-yaml.ts";
import { renderSingBoxProfile } from "../src/sing-box-json.ts";

const uuid = "11111111-1111-4111-8111-111111111111";
const publicKey = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN12";

function fields(overrides: Record<string, unknown> = {}) {
  return validateClientExportFields({
    network: "raw",
    flow: "xtls-rprx-vision",
    serverNames: ["www.example.org"],
    shortIds: ["abcdef12"],
    decryption: "none",
    ...overrides
  });
}

function spec(overrides: Partial<ClientConnectionSpec> = {}): ClientConnectionSpec {
  const validated = fields();
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error("fixture");
  return clientConnectionSpec({
    nodeId: "node-a",
    clientRef: "inbound-1-client-1",
    server: "203.0.113.10",
    port: 8443,
    uuid,
    publicKey,
    ...validated,
    ...overrides
  });
}

function profileOf(connection: ClientConnectionSpec) {
  const text = renderSingBoxProfile(connection);
  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.includes("vless://"), false);
  return JSON.parse(text) as {
    outbounds: Array<Record<string, unknown>>;
    route: { final: string };
    inbounds?: unknown;
    dns?: unknown;
  };
}

test("sing-box profile uses the official VLESS REALITY fields once", () => {
  const connection = spec();
  const text = renderClientExport("sing-box", connection);
  assert.equal(text, renderSingBoxProfile(connection));
  const profile = JSON.parse(text);
  const outboundTag = mihomoProxyName(connection);
  const selectorTag = mihomoGroupName(connection);
  assert.deepEqual(profile, {
    outbounds: [
      {
        type: "vless",
        tag: outboundTag,
        server: "203.0.113.10",
        server_port: 8443,
        uuid,
        flow: "xtls-rprx-vision",
        network: "tcp",
        packet_encoding: "",
        tls: {
          enabled: true,
          server_name: "www.example.org",
          utls: { enabled: true, fingerprint: "chrome" },
          reality: { enabled: true, public_key: publicKey, short_id: "abcdef12" }
        }
      },
      {
        type: "selector",
        tag: selectorTag,
        outbounds: [outboundTag],
        default: outboundTag
      }
    ],
    route: { final: selectorTag }
  });
  assert.equal(profile.outbounds.filter((item: { type: string }) => item.type === "vless").length, 1);
  assert.equal(profile.outbounds.filter((item: { type: string }) => item.type === "selector").length, 1);
  assert.notEqual(outboundTag, selectorTag);
  for (const absent of [
    "support-x25519mlkem768",
    "curve_preferences",
    "inbounds",
    "dns",
    "tun",
    "insecure",
    "multiplex",
    "transport",
    "packetaddr",
    "xudp",
    "encryption",
    "reality-opts",
    "vless://"
  ]) assert.equal(text.includes(absent), false, absent);
});

test("IPv6 server is a plain JSON string, and empty shortId with absent flow stays official", () => {
  const ipv6 = profileOf(spec({ server: "2001:db8::10" }));
  assert.equal(ipv6.outbounds[0].server, "2001:db8::10");
  assert.equal(JSON.stringify(ipv6).includes("[2001:db8::10]"), false);
  const validated = fields({ shortIds: [""], flow: undefined, decryption: undefined, network: "tcp" });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const profile = profileOf(spec({ shortId: validated.shortId, flow: validated.flow, server: "192.0.2.10" }));
  const outbound = profile.outbounds[0];
  assert.equal(outbound.server, "192.0.2.10");
  assert.equal(Object.hasOwn(outbound, "flow"), false);
  const reality = (outbound.tls as { reality: { short_id: string } }).reality;
  assert.equal(reality.short_id, "");
  assert.equal(outbound.network, "tcp");
  assert.equal(outbound.packet_encoding, "");
});
