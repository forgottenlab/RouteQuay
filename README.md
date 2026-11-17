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
| Explicitly update a server endpoint while preserving SSH host identity | Implemented and tested |
| SSH identity checks, transaction recovery, local state protection | Implemented; see limitations |
| Web management UI and broader network management | Experimental; **not part of the first stable scope** |

**Tested deployment targets:** Ubuntu 24.04 LTS and Debian 13, with Xray v26.11.9 used in the recorded real-machine tests. This is **not** a claim of support for every Linux distribution, hosting provider, transport, or client.

The CLI commands currently retain the development-era name `vpncp` while the public brand is being prepared as **RouteQuay**. A command rename is not a requirement for the first release.

## 📦 Installation and prerequisites

Use Node.js 22.19.0 or newer and npm. This snapshot runs TypeScript directly with Node; `build` performs type checking and creates no bundle. From the checkout:

```powershell
npm ci
npm run build
npm run check
.\vpncp.cmd --help
```

For the validated Windows-based operator workflow, prerequisites include an available OpenSSH client, a configured SSH host alias, working key-based access and known host-key verification. The remote Linux host must meet the tool's supported environment and privilege checks.

The validated management environment is Windows with PowerShell and OpenSSH. Remote first-install targets are Debian 13 and Ubuntu 24.04 on x86_64; aarch64 selection has local coverage only. A remote clean host needs systemd, root or non-interactive sudo, Python 3, curl, OpenSSL and the existing tools checked by the installer. Missing tools stop the operation; packages are not auto-installed.

## 🖥️ CLI quick reference

Run commands from the project checkout using PowerShell. `example-node` is an SSH host alias configured by the operator; it is not a default server.

```powershell
# Inspect the intended setup operation without making changes.
.\vpncp.cmd setup example-node --plan

# Inspect an already configured node.
.\vpncp.cmd status example-node

# Export a client URI to a protected local file; do not paste it into an issue.
.\vpncp.cmd export example-node --to v2rayn
```

After reviewing a clean-host plan, `vpncp setup example-node --apply` explicitly approves installation. An existing host may instead be adopted. Read the planned operation and backup/restore information before approving changes.

When an existing server's public address legitimately changes, the CLI also provides an explicitly authorized operation:

```powershell
# Documentation-only address from the RFC 5737 example range.
.\vpncp.cmd endpoint example-node --host 203.0.113.10
```

This does **not** authorize a new SSH server identity. Strict host-key validation must continue to succeed. Do not use the example IP as a real destination.

## 🧪 Testing

Local checks in this independent snapshot:

```powershell
npm run typecheck
npm run test:unit
npm run test:safety
```

Run `npm run check` for allowlist and privacy-pattern checks plus all selected core, exporter, SSH, CLI and smoke tests. This is a scoped suite, not the old full application suite. Real-machine acceptance for Ubuntu 24.04 and Debian 13 was separately performed and recorded; passing mocked tests does not itself prove a new deployment.

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
