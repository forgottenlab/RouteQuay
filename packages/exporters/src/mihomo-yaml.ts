import {
  mihomoGroupName,
  mihomoProxyName,
  renderVlessRealityUri,
  type ClientConnectionSpec,
  type ExportFormat
} from "./client-connection.ts";
import { renderSingBoxProfile } from "./sing-box-json.ts";

function quoteYaml(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

function proxyLines(spec: ClientConnectionSpec): string[] {
  const lines = [
    `    name: ${quoteYaml(mihomoProxyName(spec))}`,
    `    type: "vless"`,
    `    server: ${quoteYaml(spec.server)}`,
    `    port: ${spec.port}`,
    `    uuid: ${quoteYaml(spec.uuid)}`,
    `    network: "tcp"`,
    `    tls: true`
  ];
  if (spec.flow) lines.push(`    flow: ${quoteYaml(spec.flow)}`);
  lines.push(
    `    servername: ${quoteYaml(spec.serverName)}`,
    `    client-fingerprint: "chrome"`,
    `    encryption: "none"`,
    `    reality-opts:`,
    `      public-key: ${quoteYaml(spec.publicKey)}`,
    `      short-id: ${quoteYaml(spec.shortId)}`,
    `      support-x25519mlkem768: true`
  );
  const [first, ...rest] = lines;
  return [`  - ${first.trimStart()}`, ...rest];
}

/**
 * udp and packet-encoding are omitted. Mihomo's omitted udp value is false.
 * The installer inbound is VLESS + REALITY + Vision over TCP and does not set
 * packetEncoding, so this file does not claim UDP and does not write xudp.
 */
export function renderMihomoProvider(spec: ClientConnectionSpec): string {
  return [
    "# RouteQuay mihomo-provider：仅包含 proxies 列表，不含 URI。未声明 UDP。",
    "proxies:",
    ...proxyLines(spec),
    ""
  ].join("\n");
}

export function renderMihomoProfile(spec: ClientConnectionSpec): string {
  const proxy = mihomoProxyName(spec);
  const group = mihomoGroupName(spec);
  return [
    "# RouteQuay mihomo-profile：一个节点、一个 select 组、一条 MATCH。不开启 TUN，不改系统 DNS。",
    "mode: \"rule\"",
    "proxies:",
    ...proxyLines(spec),
    "proxy-groups:",
    `  - name: ${quoteYaml(group)}`,
    "    type: \"select\"",
    "    proxies:",
    `      - ${quoteYaml(proxy)}`,
    "rules:",
    `  - ${quoteYaml(`MATCH,${group}`)}`,
    ""
  ].join("\n");
}

export function renderClientExport(format: ExportFormat, spec: ClientConnectionSpec): string {
  if (format === "v2rayn") return `${renderVlessRealityUri(spec)}\n`;
  if (format === "mihomo-provider") return renderMihomoProvider(spec);
  if (format === "mihomo-profile") return renderMihomoProfile(spec);
  if (format === "sing-box") return renderSingBoxProfile(spec);
  throw new Error("EXPORT_FORMAT_UNSUPPORTED");
}
