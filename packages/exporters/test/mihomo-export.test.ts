import test from "node:test";
import assert from "node:assert/strict";

import {
  clientConnectionSpec,
  mihomoGroupName,
  mihomoProxyName,
  renderVlessRealityUri,
  validateClientExportFields,
  type ClientConnectionSpec
} from "../src/client-connection.ts";
import { renderClientExport, renderMihomoProfile, renderMihomoProvider } from "../src/mihomo-yaml.ts";

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

test("raw network, vision flow and decryption none map once for URI and YAML", () => {
  const validated = fields();
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(validated.network, "tcp");
  assert.equal(validated.flow, "xtls-rprx-vision");
  assert.equal(validated.encryption, "none");
  const connection = spec();
  const uri = renderVlessRealityUri(connection);
  assert.equal(uri, `vless://${uuid}@203.0.113.10:8443?encryption=none&security=reality&sni=www.example.org&fp=chrome&pbk=${publicKey}&sid=abcdef12&type=tcp&flow=xtls-rprx-vision#node-a`);
  const provider = renderMihomoProvider(connection);
  const profile = renderMihomoProfile(connection);
  assert.equal(provider.startsWith("# RouteQuay mihomo-provider"), true);
  assert.match(provider, /^# .+\nproxies:\n/);
  assert.equal(provider.includes("proxy-groups:"), false);
  assert.equal(provider.includes("\nrules:"), false);
  assert.equal(provider.includes("vless://"), false);
  assert.equal(profile.includes(provider.split("\n").slice(1).join("\n").trimEnd()), true);
  for (const yaml of [provider, profile]) {
    assert.match(yaml, /type: "vless"/);
    assert.match(yaml, /server: "203\.0\.113\.10"/);
    assert.match(yaml, /port: 8443/);
    assert.match(yaml, new RegExp(`uuid: "${uuid}"`));
    assert.match(yaml, /network: "tcp"/);
    assert.match(yaml, /tls: true/);
    assert.match(yaml, /flow: "xtls-rprx-vision"/);
    assert.match(yaml, /servername: "www\.example\.org"/);
    assert.match(yaml, /client-fingerprint: "chrome"/);
    assert.match(yaml, /encryption: "none"/);
    assert.match(yaml, new RegExp(`public-key: "${publicKey}"`));
    assert.match(yaml, /short-id: "abcdef12"/);
    assert.match(yaml, /support-x25519mlkem768: true/);
    assert.equal(yaml.includes("cipher:"), false);
    assert.equal(yaml.includes("alterId:"), false);
    assert.equal(yaml.includes("packet-encoding:"), false);
    assert.equal(/(^|\n)\s*udp\s*:/.test(yaml), false);
    assert.equal(/(^|\n)tun\s*:/.test(yaml), false);
    assert.equal(/(^|\n)dns\s*:/.test(yaml), false);
  }
  assert.match(profile, /mode: "rule"/);
  assert.match(profile, /type: "select"/);
  assert.match(profile, /rules:\n {2}- "MATCH,rq-node-a-inbound-1-client-1-select"/);
  assert.equal(profile.split("\n").filter((line) => line.includes("type: \"vless\"")).length, 1);
  assert.equal(profile.split("\n").filter((line) => line.includes("type: \"select\"")).length, 1);
});

test("IPv6 hosts are bracketed in the URI and quoted in YAML", () => {
  const connection = spec({ server: "2001:db8::10" });
  assert.match(renderVlessRealityUri(connection), /@\[2001:db8::10\]:8443\?/);
  assert.match(renderMihomoProvider(connection), /server: "2001:db8::10"/);
  assert.equal(renderMihomoProvider(connection).includes("[2001:db8::10]"), false);
});

test("empty shortId stays in the URI and YAML, and absent flow is omitted", () => {
  const validated = fields({ shortIds: [""], flow: undefined, decryption: undefined, network: "tcp" });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const connection = spec({ shortId: validated.shortId, flow: validated.flow, server: "192.0.2.10" });
  const uri = new URL(renderVlessRealityUri(connection));
  assert.equal(uri.searchParams.get("sid"), "");
  assert.equal(uri.searchParams.has("flow"), false);
  assert.equal(uri.searchParams.get("encryption"), "none");
  assert.equal(uri.searchParams.get("type"), "tcp");
  const yaml = renderMihomoProfile(connection);
  assert.match(yaml, /short-id: ""/);
  assert.equal(yaml.includes("flow:"), false);
  assert.match(yaml, /encryption: "none"/);
});

test("proxy and group names are unique and derived from the node id", () => {
  const first = spec();
  const second = spec({ nodeId: "node-b", clientRef: "inbound-1-client-2" });
  assert.equal(mihomoProxyName(first), "rq-node-a-inbound-1-client-1");
  assert.equal(mihomoGroupName(first), "rq-node-a-inbound-1-client-1-select");
  assert.notEqual(mihomoProxyName(first), mihomoGroupName(first));
  assert.notEqual(mihomoProxyName(first), mihomoProxyName(second));
  assert.equal(mihomoProxyName(first).includes("node-a"), true);
  assert.equal(mihomoGroupName(second).includes("node-b"), true);
});

test("unsupported reality, flow, decryption and network values are refused", () => {
  const ambiguous = fields({ serverNames: ["a.example.org", "b.example.org"] });
  const invalid = fields({ shortIds: ["zz"] });
  const emptyNames = fields({ serverNames: [] });
  const flow = fields({ flow: "xtls-rprx-vision-udp443" });
  const decryption = fields({ decryption: "mlkem768x25519plus.example" });
  const network = fields({ network: "ws" });
  for (const failure of [ambiguous, invalid, emptyNames, flow, decryption, network]) assert.equal(failure.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.code, "REALITY_PARAMETERS_AMBIGUOUS");
  if (!invalid.ok) assert.equal(invalid.code, "REALITY_PARAMETERS_INVALID");
  if (!flow.ok) assert.equal(flow.code, "FLOW_UNSUPPORTED");
  if (!decryption.ok) assert.equal(decryption.code, "DECRYPTION_UNSUPPORTED");
  if (!network.ok) assert.equal(network.code, "NETWORK_UNSUPPORTED");
});

test("provider and profile documents share one proxy and do not mix in a URI", () => {
  const connection = spec({ server: "198.51.100.20" });
  const provider = renderClientExport("mihomo-provider", connection);
  const profile = renderClientExport("mihomo-profile", connection);
  const uri = renderClientExport("v2rayn", connection);
  assert.equal(provider.includes(mihomoProxyName(connection)), true);
  assert.equal(profile.includes(provider.split("\n").slice(1).join("\n").trimEnd()), true);
  assert.equal(uri.startsWith("vless://"), true);
  assert.equal(uri.endsWith("\n"), true);
  assert.equal(provider.includes("vless://"), false);
  assert.equal(profile.includes("vless://"), false);
});
