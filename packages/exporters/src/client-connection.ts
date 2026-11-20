import { createShadowrocketLink } from "./shadowrocket-real.ts";

/**
 * Fields shared by the v2rayN URI and Mihomo YAML exporters.
 * Built only after the same VLESS/REALITY checks used by exportCandidates
 * and createShadowrocketLink. Renderers must not read the Xray document again.
 */
export type ClientConnectionSpec = {
  nodeId: string;
  clientRef: string;
  server: string;
  port: number;
  uuid: string;
  network: "tcp";
  flow?: "xtls-rprx-vision";
  serverName: string;
  publicKey: string;
  shortId: string;
  fingerprint: "chrome";
  encryption: "none";
  security: "reality";
  protocol: "vless";
};

export const exportFormats = ["v2rayn", "mihomo-provider", "mihomo-profile"] as const;
export type ExportFormat = (typeof exportFormats)[number];

export type ValidatedExportFields = {
  ok: true;
  network: "tcp";
  flow?: "xtls-rprx-vision";
  serverName: string;
  shortId: string;
  encryption: "none";
};

export type ExportFieldFailure = { ok: false; code: string };

export function isExportFormat(value: string | undefined): value is ExportFormat {
  return value === "v2rayn" || value === "mihomo-provider" || value === "mihomo-profile";
}

export function validateClientExportFields(input: {
  network: unknown;
  flow: unknown;
  serverNames: unknown;
  shortIds: unknown;
  decryption: unknown;
}): ValidatedExportFields | ExportFieldFailure {
  if (!Array.isArray(input.serverNames) || input.serverNames.length !== 1
    || !Array.isArray(input.shortIds) || input.shortIds.length !== 1) {
    return { ok: false, code: "REALITY_PARAMETERS_AMBIGUOUS" };
  }
  const serverName = input.serverNames[0];
  const shortId = input.shortIds[0];
  if (typeof serverName !== "string" || !/^[a-zA-Z0-9.-]+$/.test(serverName)
    || typeof shortId !== "string" || !/^(?:[a-fA-F0-9]{2}){0,8}$/.test(shortId)) {
    return { ok: false, code: "REALITY_PARAMETERS_INVALID" };
  }
  let flow: "xtls-rprx-vision" | undefined;
  if (input.flow !== undefined && input.flow !== null && input.flow !== "") {
    if (input.flow !== "xtls-rprx-vision") return { ok: false, code: "FLOW_UNSUPPORTED" };
    flow = "xtls-rprx-vision";
  }
  // URI export always writes encryption=none. Mihomo accepts "none" as no VLESS
  // encryption. An explicit other decryption value must not be relabeled none.
  if (input.decryption !== undefined && input.decryption !== null && input.decryption !== "none") {
    return { ok: false, code: "DECRYPTION_UNSUPPORTED" };
  }
  const network = input.network === undefined || input.network === null ? "tcp" : input.network;
  if (network !== "tcp" && network !== "raw") return { ok: false, code: "NETWORK_UNSUPPORTED" };
  return { ok: true, network: "tcp", flow, serverName, shortId, encryption: "none" };
}

export function clientConnectionSpec(input: {
  nodeId: string;
  clientRef: string;
  server: string;
  port: number;
  uuid: string;
  publicKey: string;
  network: "tcp";
  flow?: "xtls-rprx-vision";
  serverName: string;
  shortId: string;
  encryption: "none";
}): ClientConnectionSpec {
  return {
    nodeId: input.nodeId,
    clientRef: input.clientRef,
    server: input.server,
    port: input.port,
    uuid: input.uuid,
    network: "tcp",
    flow: input.flow,
    serverName: input.serverName,
    publicKey: input.publicKey,
    shortId: input.shortId,
    fingerprint: "chrome",
    encryption: "none",
    security: "reality",
    protocol: "vless"
  };
}

export function mihomoProxyName(spec: Pick<ClientConnectionSpec, "nodeId" | "clientRef">): string {
  return `rq-${spec.nodeId}-${spec.clientRef}`;
}

export function mihomoGroupName(spec: Pick<ClientConnectionSpec, "nodeId" | "clientRef">): string {
  return `${mihomoProxyName(spec)}-select`;
}

export function defaultExportFileName(clientRef: string, format: ExportFormat): string {
  if (format === "mihomo-provider") return `${clientRef}.mihomo-provider.yaml`;
  if (format === "mihomo-profile") return `${clientRef}.mihomo-profile.yaml`;
  return `${clientRef}.vless.txt`;
}

export function renderVlessRealityUri(spec: ClientConnectionSpec): string {
  return createShadowrocketLink({
    inboundIndex: 0,
    protocol: spec.protocol,
    network: spec.network,
    security: spec.security,
    port: spec.port,
    serverAddress: spec.server,
    serverName: spec.serverName,
    shortId: spec.shortId,
    publicKey: spec.publicKey,
    fingerprint: spec.fingerprint,
    includeFlow: spec.flow !== undefined,
    clients: []
  }, {
    displayName: spec.nodeId,
    id: spec.uuid,
    flow: spec.flow
  }, {
    sniMode: "explicit",
    allowUseServerNamesFromConfig: false,
    includeFlow: spec.flow !== undefined
  });
}
