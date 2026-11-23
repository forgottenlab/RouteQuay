import { mihomoGroupName, mihomoProxyName, type ClientConnectionSpec } from "./client-connection.ts";

/**
 * Official sing-box client profile for one VLESS + REALITY outbound.
 *
 * Schema is the v1.14.4 structs VLESSOutboundOptions, OutboundTLSOptions,
 * OutboundUTLSOptions and OutboundRealityOptions (tag v1.14.4, 2026-10-24,
 * the newest stable release as of 2026-11-23), which match the outbound VLESS
 * and TLS pages at sing-box.sagernet.org. The testing branch on 2026-11-19
 * still has the same three REALITY client fields.
 *
 * uTLS must be enabled: v1.14.4 common/tls/reality_client.go rejects a REALITY
 * client without it. packet_encoding is the empty string because a missing
 * value turns xudp on in protocol/vless/outbound.go. network tcp does not
 * enable UDP. curve_preferences is a Go TLS option, not a REALITY switch, and
 * is omitted. v1.14.4 removes X25519MLKEM768 inside the REALITY client; testing
 * commit 39501357a5 (2026-11-14) stops doing that and adds no JSON field.
 */
type SingBoxProfile = {
  outbounds: [
    {
      type: "vless";
      tag: string;
      server: string;
      server_port: number;
      uuid: string;
      flow?: "xtls-rprx-vision";
      network: "tcp";
      packet_encoding: "";
      tls: {
        enabled: true;
        server_name: string;
        utls: { enabled: true; fingerprint: "chrome" };
        reality: { enabled: true; public_key: string; short_id: string };
      };
    },
    {
      type: "selector";
      tag: string;
      outbounds: [string];
      default: string;
    }
  ];
  route: { final: string };
};

export function renderSingBoxProfile(spec: ClientConnectionSpec): string {
  const outboundTag = mihomoProxyName(spec);
  const selectorTag = mihomoGroupName(spec);
  const profile: SingBoxProfile = {
    outbounds: [
      {
        type: "vless",
        tag: outboundTag,
        server: spec.server,
        server_port: spec.port,
        uuid: spec.uuid,
        flow: spec.flow,
        network: "tcp",
        packet_encoding: "",
        tls: {
          enabled: true,
          server_name: spec.serverName,
          utls: {
            enabled: true,
            fingerprint: "chrome"
          },
          reality: {
            enabled: true,
            public_key: spec.publicKey,
            short_id: spec.shortId
          }
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
  };
  return `${JSON.stringify(profile, null, 2)}\n`;
}
