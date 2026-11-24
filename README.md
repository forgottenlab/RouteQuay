# 🧭 RouteQuay

> Simple infrastructure. Clear control.
>
> 简化基础设施操作，让连接与管理更加清晰。

[English](README.md) | [简体中文](README.zh-CN.md)

**Release status:** Public early-stage Core-first source snapshot. Versioned installers and GitHub Releases are not yet available.

RouteQuay is a lightweight network access and server management toolkit. It is a local-first toolkit for explicit, inspectable network-access and server operations. Its **first supported scope is the Xray CLI**, not a full VPN, overlay network, or web administration platform.

## ✨ Why RouteQuay?

Several mature networking and Xray management projects already exist. RouteQuay does not aim to replace them or compete on the number of features. It focuses on a smaller task: deploying or adopting an Xray instance over SSH, checking its state, and exporting a usable client configuration with safety checks and predictable behavior.

**Principles:** real problems first · explain before executing · safe by default · local-first · test before release.

## 🚀 Current CLI scope

| Capability | Current state |
|---|---|
| First-time Xray installation on tested Linux systems | Verified in integration tests |
| Adopt an existing Xray installation without replacing it | Verified in integration tests |
| Read-only deployment planning and node status | Implemented and tested |
| Export a VLESS/REALITY client link for v2rayN | Verified end-to-end |
| Export a local VLESS QR PNG (`vless-qr`) | Offline decode in unit tests; 2026-11-21 v2rayN GUI image import succeeded on the two recorded nodes. 2026-11-23: Shadowrocket imported the same clipboard `vless://` URI used for v2rayN paste, and scanned the offline VLESS QR. Import only; no traffic or egress result |
| Export Mihomo YAML (`mihomo-provider` or `mihomo-profile`) | 2026-11-21: on Ubuntu 24.04 and Debian 13 with Xray 26.11.9, Mihomo 1.19.33 required unquoted `support-x25519mlkem768: true`. 2026-11-23: FlClash 0.9.4 imported the official `mihomo-profile` YAML by file import, and delay tests succeeded on both acceptance nodes. Import the official export, not an edited test copy. Not every version pair |
| Export a local sing-box JSON profile (`sing-box`) | 2026-11-23: the official exported JSON passed sing-box 1.14.4 `sing-box check -c`. The REALITY handshake to Xray 26.11.9 failed with `reality verification failed`. Official 1.14.4 strips `X25519MLKEM768` from the REALITY ClientHello. On the same path, Mihomo 1.19.33 with official `reality-opts.support-x25519mlkem768: true` succeeded. Do not weaken server REALITY, change `minClientVer`, or add unofficial sing-box JSON fields |
| Bring client files back to this machine (`pull`) | After a successful install or adoption, and whenever `pull` is run later. Writes a VLESS URI file, a QR PNG, Mihomo YAML, and sing-box JSON into the operator's private directory. The terminal prints paths only. There is no subscription URL |
| Explicitly update a server endpoint while preserving SSH host identity | Implemented and tested |
| SSH identity checks, transaction recovery, local state protection | Implemented; see limitations |
| Web management UI and broader network management | Experimental; **not part of the first stable scope** |

**Tested deployment targets:** Ubuntu 24.04 LTS and Debian 13, with Xray v26.11.9 used in the recorded real-machine tests. This is **not** a claim of support for every Linux distribution, hosting provider, transport, or client.

The primary command is `routequay`. `vpncp` remains a compatibility entry for the same program. Source files may still use the earlier name.

## 📦 Installation and prerequisites

Use Node.js 22.19.0 or newer and npm. This snapshot runs TypeScript directly with Node; `build` performs type checking and creates no bundle. From the checkout:

```powershell
npm ci
npm run build
npm run check
.\routequay.cmd --help
```

`.\vpncp.cmd` remains available and runs the same program. A current-user install that does not require staying in this checkout is described in [Windows install](docs/INSTALL.md). `routequay init-config` creates the operator config when it is missing and prints only that path. Versioned GitHub Releases are not published yet.

For the validated Windows-based operator workflow, prerequisites include an available OpenSSH client, a configured SSH host alias, working key-based access and known host-key verification. The remote Linux host must meet the tool's supported environment and privilege checks.

The validated management environment is Windows with PowerShell and OpenSSH. Remote first-install targets are Debian 13 and Ubuntu 24.04 on x86_64; aarch64 selection has local coverage only. A remote clean host needs systemd, root or non-interactive sudo, Python 3, curl, OpenSSL and the existing tools checked by the installer. Missing tools stop the operation; packages are not auto-installed.

## 🖥️ CLI quick reference

Run commands from the project checkout using PowerShell, or from any new terminal after the Windows install adds `routequay` to the current-user PATH. `example-node` is an SSH host alias configured by the operator; it is not a default server. `vpncp` accepts the same arguments.

```powershell
# Inspect the intended setup operation without making changes.
.\routequay.cmd setup example-node --plan

# Inspect an already configured node.
.\routequay.cmd status example-node

# Export a client URI to a protected local file; do not paste it into an issue.
.\routequay.cmd export example-node --to v2rayn
.\routequay.cmd export example-node --to vless-qr

# Mihomo / Clash Meta: a proxies list, or a minimal profile file.
.\routequay.cmd export example-node --to mihomo-provider
.\routequay.cmd export example-node --to mihomo-profile

# sing-box: one local JSON file. Import that file; there is no subscription URL.
.\routequay.cmd export example-node --to sing-box

# Write all five current files into the local private directory. The terminal prints paths only.
.\routequay.cmd pull example-node
```

After reviewing a clean-host plan, `routequay setup example-node --apply` explicitly approves installation. An existing host may instead be adopted. Read the planned operation and backup/restore information before approving changes.

When an existing server's public address legitimately changes, the CLI also provides an explicitly authorized operation:

```powershell
# Documentation-only address from the RFC 5737 example range.
.\routequay.cmd endpoint example-node --host 203.0.113.10
```

This does **not** authorize a new SSH server identity. Strict host-key validation must continue to succeed. Do not use the example IP as a real destination.

## Client export

`routequay export <node> --to <format>` writes one private file and prints the path only. It does not print the URI, YAML, JSON, UUID, REALITY public key, or short ID. `--out` chooses another file path. The same bytes are left in place; different bytes are refused with `OUTPUT_EXISTS`.

`routequay pull <node>` uses those same exporters to write the VLESS URI (`.vless.txt`), the VLESS QR PNG, the Mihomo provider, the Mihomo profile, and the sing-box JSON together on this machine. A successful first install does this automatically, as does adoption of an existing instance when the saved state changes. An unchanged setup leaves the files alone. The terminal and `--json` print the directory and paths only.

The default directory is `local/private/cli-nodes/<node>/` under the private data directory. An uninstalled checkout still uses `local/private` inside the repository. An installed copy uses `%USERPROFILE%\.routequay\`, or `--data-dir` / `ROUTEQUAY_DATA_DIR`. Old checkout data is not migrated.

`pull` overwrites the canonical files in that directory: identical bytes stay in place and permissions are tightened again; different bytes are replaced. Symbolic links are refused. If permissions cannot be tightened, the command fails instead of leaving credentials in a looser file. `pull --out` must be an existing directory, and that directory is tightened to the current user. Copies made with `export --out` are not modified by `pull`. `endpoint` does not change existing files; run `pull` when the current files should use the new address. More than one client requires `--client <ref>`.

| `--to` | Default file | When to use it |
|---|---|---|
| `v2rayn` | `<ref>.vless.txt` | A client imports a VLESS URI. This remains the default when `--to` is omitted. |
| `vless-qr` | `<ref>.vless.png` | Offline PNG QR for the same VLESS URI as `v2rayn`. No network API; scan import does not add Mihomo YAML fields. |
| `mihomo-provider` | `<ref>.mihomo-provider.yaml` | A Mihomo / Clash Meta profile already exists. The file is only a `proxies:` list, not a URI or base64 document. |
| `mihomo-profile` | `<ref>.mihomo-profile.yaml` | FlClash or Mihomo needs a first file: one proxy, one `select` group, and a final `MATCH` rule. |
| `sing-box` | `<ref>.sing-box.json` | A local sing-box configuration: one VLESS outbound, one `selector`, and `route.final`. No inbound, TUN, or DNS. |

Proxy and group names are `rq-<nodeId>-<clientRef>` and `rq-<nodeId>-<clientRef>-select`, so they do not collide in one file. Server `network: raw` is exported as `tcp`, matching the URI. `flow` is written only for `xtls-rprx-vision`. `encryption: none` is written only when the inbound decryption is omitted or `none`, which is also the URI's `encryption=none`. Mihomo treats that value as no extra VLESS encryption. `reality-opts` also sets `support-x25519mlkem768: true` (boolean, unquoted) for Xray 26.11.9 ML-KEM. In the 2026-11-21 record, isolated Mihomo 1.19.33 on both tested VPS hosts required this field before REALITY HTTPS succeeded. FlClash 0.9.4 (embedded Mihomo 1.19.34) imported test profiles that already contained the field that day. On 2026-11-23, FlClash 0.9.4 imported the official `mihomo-profile` by file import, and delay tests succeeded on both acceptance nodes. Import the official export, not an edited test copy. Not every Mihomo/Xray pairing is guaranteed. `udp` and `packet-encoding` are omitted: the installer does not set packet encoding, and omitted `udp` is Mihomo's false default. The profile does not enable TUN, does not change system DNS, and is not a full routing ruleset.

FlClash 0.9.0 and later can parse share links, including `vless://`. Its core calls Mihomo `ConvertsV2Ray`, and upstream has a VLESS REALITY round-trip test. Parsing a link is not a completed handshake with RouteQuay's pinned Xray 26.11.9, and a link has no groups or rules. YAML is the recommended FlClash path for that reason.

Mihomo's TLS/REALITY documentation says it will not consider compatibility with xray-core v26.7.11 or newer. RouteQuay installs only 26.11.9 and does not set `minClientVer`. In that Xray version the default `minClientVer=26.3.27` assignment is commented out, and the bundled REALITY library skips the version check when `MinClientVer` is nil. This export does not change `minClientVer` and does not weaken REALITY. A limited check on 2026-11-21 (Asia/Shanghai) for Mihomo 1.19.33 and FlClash 0.9.4 on the two tested VPS hosts, and the 2026-11-23 client acceptance retest, are recorded in the testing notes. The retest showed that FlClash 0.9.4 can import the official `mihomo-profile` by file import. The same day, Shadowrocket imported the same clipboard `vless://` URI used for v2rayN paste and scanned the offline VLESS QR; Shadowrocket is import-only in that record. These records do not extend to every Mihomo/Xray pair and do not treat a scanned VLESS QR as a carrier of the Mihomo YAML ML-KEM field. The 2026-11-21 notes do not turn the official files' isolated HTTPS run into a new status-code and egress matrix.

### sing-box

`--to sing-box` writes `<ref>.sing-box.json`. Import that file locally: `sing-box check -c <file>`, `sing-box run -c <file>`, or a client's import-from-file action. The command prints the path only. There is no hosted subscription URL.

The schema is the official outbound VLESS and TLS documents ([VLESS](https://sing-box.sagernet.org/configuration/outbound/vless/), [TLS](https://sing-box.sagernet.org/configuration/shared/tls/)) as implemented by sing-box **1.14.4** (published 2026-10-24, the newest stable release as of 2026-11-23). The same three REALITY client fields are still the whole `OutboundRealityOptions` struct on the `testing` branch as of 2026-11-19. The file contains:

- one `vless` outbound tagged `rq-<nodeId>-<clientRef>`
- one `selector` tagged `rq-<nodeId>-<clientRef>-select`, with that outbound as its only choice and its `default`
- `route.final` set to the selector

`server` and `server_port` come from the saved endpoint and inbound port. An IPv6 server is a plain address string, without brackets. `uuid` is the client id. `flow` is written only for `xtls-rprx-vision`. `network` is `tcp` when the inbound network is `tcp` or `raw`. `packet_encoding` is `""` because sing-box 1.14.4 treats a missing value as `xudp` (`protocol/vless/outbound.go`). `tls.enabled` is true. `tls.server_name` is the single REALITY server name. `tls.utls.enabled` is true and `tls.utls.fingerprint` is `chrome`, because the 1.14.4 REALITY client refuses to start unless uTLS is enabled. `tls.reality` is `enabled`, `public_key`, and `short_id` only. An empty short ID stays `""`.

`curve_preferences` is a Go TLS option added in sing-box 1.13.0. Its allowed values include `X25519MLKEM768`, and the documented order is ignored. REALITY in sing-box goes through uTLS, so this export does not write `curve_preferences` and does not copy Mihomo's `support-x25519mlkem768` into the JSON. In the 1.14.4 source, `common/tls/reality_client.go` removes `X25519MLKEM768` from the REALITY ClientHello. Commit `39501357a5` on `testing` (2026-11-14, “Stop removing X25519MLKEM768 from reality ClientHello”) keeps the fingerprint's key shares and adds no JSON field. That commit is not in the 1.14.4 release or in 1.15.0-alpha.13 (2026-10-24).

No inbound is written, so the file does not open a local proxy port. TUN and DNS are omitted, and `insecure` is not set. `minClientVer` on the server is unchanged. On 2026-11-23 the official sing-box 1.14.4 binary accepted three synthetic files with `sing-box check -c`: vision flow with a short ID, an empty short ID and no flow, and an IPv6 server. The same binary rejected a copied `support-x25519mlkem768` field as an unknown field, and rejected a REALITY outbound after `utls` was removed. That synthetic check loads JSON only and does not open a connection. The acceptance retest the same day used the official exported JSON: `sing-box check -c` passed, and the REALITY handshake to Xray 26.11.9 failed with `reality verification failed`. Official 1.14.4 strips `X25519MLKEM768` from the REALITY ClientHello. On the same path, Mihomo 1.19.33 with the official field `reality-opts.support-x25519mlkem768: true` succeeded. Do not treat weakening server REALITY, changing `minClientVer`, or adding unofficial JSON fields as a workaround. The selector can be changed through the Clash API; with one outbound, `default` already selects it.

## 🧪 Testing

Local checks in this independent snapshot:

```powershell
npm run typecheck
npm run test:unit
npm run test:safety
```

Run `npm run check` for allowlist and privacy-pattern checks plus all selected core, exporter, SSH, CLI and smoke tests. This is a scoped suite, not the old full application suite. Real-machine acceptance for Ubuntu 24.04 and Debian 13 was separately performed and recorded. The testing notes include the 2026-11-21 client check, the 2026-11-23 client acceptance retest, and their limits. Passing mocked tests does not itself prove a new deployment.

See [Testing notes](docs/TESTING.zh-CN.md) for the evidence boundary and validation checklist.

## 🔐 Safety and limitations

- **Never commit** private SSH keys, credentials, real VLESS URIs, local node state, installation journals containing sensitive information, or generated exports.
- Review a `setup --plan` result before applying changes. Do not assume the tool configures cloud firewalls or replaces existing services automatically.
- Keep SSH strict host-key verification enabled; address changes and identity changes are different events.
- Do not mix older writers that ignore the newer node-lock coordination protocol. A leftover guard/lock requires manual investigation after confirming operations are idle.
- Do not treat the current CLI as a general-purpose LAN/WAN overlay networking solution or a production-ready multi-user web panel.
- Respect local laws and your provider's terms.

## 🗺️ Roadmap

Current priorities: a verifiably clean core-first source snapshot, bilingual documentation, secure installation instructions, and a small reproducible test workflow. Other connection technologies, web management and route benchmarking are research directions, **not promised features**.

See [Roadmap (简体中文)](docs/ROADMAP.zh-CN.md).

## 🤝 Feedback and contribution

Bug reports, feature ideas, and maintenance tasks can be reported through GitHub Issues. ForgottenLab's account-level `.github` repository provides default Issue forms and a pull-request template to repositories that do not override them. English and Simplified Chinese are both welcome; submitting both is not required.

## 📜 License

RouteQuay is licensed under the [MIT License](LICENSE), Copyright (c) 2026 ForgottenLab. This repository is public; no tagged release or standalone installer is available yet. Xray is separate software under its own MPL-2.0 license and is not relicensed by this project. See [license review](docs/LICENSE-REVIEW.md).
