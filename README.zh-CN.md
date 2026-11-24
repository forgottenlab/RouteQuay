# 🧭 RouteQuay

> Simple infrastructure. Clear control.
>
> 简化基础设施操作，让连接与管理更加清晰。

[English](README.md) | [简体中文](README.zh-CN.md)

**当前状态：** 已公开早期 Core-first 源码，尚未提供正式版本安装包或 GitHub Release。

RouteQuay 是轻量、快捷、安全的网络接入与服务器管理工具，以简洁部署、本地优先、默认安全和明确可控为理念。**首次发布重点是 Xray CLI**，而不是完整的 VPN、内网组网平台或 Web 管理面板。

## ✨ 为什么做 RouteQuay？

市面上已有功能成熟的网络工具和 Xray 管理项目。RouteQuay 不以功能数量为竞争目标，也不试图替代它们，而是专注于一件更小的事：通过 SSH 安全地部署或接管 Xray，检查状态，并导出可以使用的客户端配置。

**项目原则：** 真实问题优先 · 先解释再执行 · 默认更安全 · 本地优先 · 先测试再发布。

## 🚀 当前 CLI 能力

| 能力 | 状态 |
|---|---|
| 在已测试的 Linux 环境中首次安装 Xray | 已完成实机验证 |
| 接管现有 Xray 而不直接替换已有配置 | 已完成实机验证 |
| 部署只读计划与节点状态查看 | 已实现并测试 |
| 导出 v2rayN 可使用的 VLESS/REALITY 节点 | 已完成端到端验证 |
| 导出本地 VLESS 二维码 PNG（`vless-qr`） | 离线单元测试已覆盖；2026-11-21 在两台已记录节点上，v2rayN 图形界面导入官方 PNG 成功。2026-11-23：Shadowrocket 导入了与 v2rayN 粘贴相同的剪贴板 `vless://` URI，并扫码导入离线 VLESS 二维码。只记录导入，没有流量或出口结果 |
| 导出 Mihomo YAML（`mihomo-provider` 或 `mihomo-profile`） | 2026-11-21：Ubuntu 24.04 与 Debian 13、Xray 26.11.9 上，Mihomo 1.19.33 需要未加引号的 `support-x25519mlkem768: true`。2026-11-23：FlClash 0.9.4 以文件导入直接导入官方 `mihomo-profile`，两台验收节点的延迟测试成功。请导入官方导出，不要使用编辑过的测试副本。不覆盖全部版本组合 |
| 导出本地 sing-box JSON（`sing-box`） | 2026-11-23：官方导出 JSON 通过 sing-box 1.14.4 的 `sing-box check -c`。对 Xray 26.11.9 的 REALITY 握手失败（`reality verification failed`）。官方 1.14.4 会从 REALITY ClientHello 去掉 `X25519MLKEM768`。同一路径上 Mihomo 1.19.33 使用官方字段 `reality-opts.support-x25519mlkem768: true` 时成功。不要削弱服务器 REALITY、修改 `minClientVer` 或添加非官方字段 |
| 把客户端文件带回本机（`pull`） | 安装或接管成功后自动写到操作员机器的私有目录，也可以稍后执行 `pull`。包含 VLESS URI 文件、二维码 PNG、Mihomo YAML 和 sing-box JSON。终端只打印路径。不提供订阅 URL |
| 显式更新公网地址并保留 SSH 主机身份 | 已实现并测试 |
| SSH 身份保护、事务恢复和本地状态保护 | 已实现，存在明确使用边界 |
| Web 可视化管理及更广泛的网络功能 | 实验阶段，**不属于首发稳定范围** |

**已测试系统：** Ubuntu 24.04 LTS、Debian 13。已归档的实机验证使用 Xray v26.11.9。上述事实**不代表**支持所有 Linux 发行版、云平台、协议或客户端。

正式命令是 `routequay`。`vpncp` 仍是同一程序的兼容入口。源码文件名可以继续沿用早期名称。

## 📦 安装与环境要求

需要 Node.js 22.19.0 或更新版本及 npm。Node 直接运行 TypeScript；`build` 执行类型检查，不生成 bundle。在本仓库目录执行：

```powershell
npm ci
npm run build
npm run check
.\routequay.cmd --help
```

`.\vpncp.cmd` 仍然可用，并且运行同一程序。不停留在本仓库目录的当前用户安装见 [Windows 安装](docs/INSTALL.zh-CN.md)。`routequay init-config` 会在操作员配置不存在时创建它，并且只打印路径。尚未发布带版本号的 GitHub Release。

当前已验证的 Windows 管理端流程依赖可用的 OpenSSH 客户端、配置好的 SSH Host 别名、密钥认证及可信主机密钥记录；远端 Linux 还需通过工具的环境与权限检查。

已验证的管理端为 Windows / PowerShell / OpenSSH。远端首装实机范围是 Debian 13、Ubuntu 24.04 的 x86_64；aarch64 仅有本地选型测试。远端需要 systemd、root 或非交互 sudo、Python 3、curl、OpenSSL 及安装器检查的既有工具；缺失时停止，不自动安装软件包。

## 🖥️ 命令示例

以下示例在项目目录的 PowerShell 中执行。完成 Windows 安装并写入当前用户 PATH 后，也可以在新终端直接运行 `routequay`。`example-node` 是使用者自行配置的 SSH 主机别名，不是预设服务器。`vpncp` 接受相同参数。

```powershell
# 只读查看准备执行的部署操作。
.\routequay.cmd setup example-node --plan

# 查看已配置节点的状态。
.\routequay.cmd status example-node

# 导出到受保护的本地文件，不要公开完整 VLESS URI。
.\routequay.cmd export example-node --to v2rayn
.\routequay.cmd export example-node --to vless-qr

# Mihomo / Clash Meta：已有配置用节点列表，首次导入用最小配置文件。
.\routequay.cmd export example-node --to mihomo-provider
.\routequay.cmd export example-node --to mihomo-profile

# sing-box：一份本地 JSON。导入该文件，不提供订阅 URL。
.\routequay.cmd export example-node --to sing-box

# 一次把五种现行文件写回本机私有目录。终端只打印路径。
.\routequay.cmd pull example-node
```

空机计划审核后使用 `routequay setup example-node --apply` 显式确认安装；已有 Xray 实例可能进入接管流程。在应用任何更改前，应先确认计划、备份和恢复方式。

当同一台服务器的公网地址合法变化时，可显式授权更新：

```powershell
# 203.0.113.10 为文档示例保留地址，不能作为真实服务器使用。
.\routequay.cmd endpoint example-node --host 203.0.113.10
```

这不是信任陌生服务器的操作。必须继续通过严格 SSH 主机密钥验证。

## 客户端导出

`routequay export <node> --to <格式>` 只把一种文件写到私有目录，终端只打印路径，不打印 URI、YAML、JSON、UUID、REALITY 公钥或 shortId。`--out` 可指定其他文件路径。内容相同则保留原文件；内容不同则拒绝并返回 `OUTPUT_EXISTS`。

`routequay pull <node>` 使用同一套导出器，把 VLESS URI（`.vless.txt`）、VLESS 二维码 PNG、Mihomo provider、Mihomo profile 和 sing-box JSON 一起写回本机。成功的空机安装，以及接管已有实例且本地状态发生变化时，会自动做同样的带回。状态没有变化时不改这些文件。终端和 `--json` 只打印目录与路径。

默认目录是私有数据目录下的 `local/private/cli-nodes/<node>/`。未安装的开发目录仍用仓库里的 `local/private`。已安装副本用 `%USERPROFILE%\.routequay\`，也可以用 `--data-dir` 或 `ROUTEQUAY_DATA_DIR`。不会自动迁移旧的仓库数据。

`pull` 对这个目录里的同名现行文件采用覆盖：内容逐字节相同则保留并重新收紧权限；内容不同则替换。符号链接直接拒绝。权限无法收紧时命令失败，不把凭据留在更宽松的文件里。`pull --out` 必须是已经存在的目录，该目录也会被收紧为仅当前用户可访问。`export --out` 写到其他路径的副本不会被 `pull` 修改。`endpoint` 不自动改已有文件；需要新地址的现行文件时再执行 `pull`。多个客户端时必须加上 `--client <ref>`。

| `--to` | 默认文件 | 适用情况 |
|---|---|---|
| `v2rayn` | `<ref>.vless.txt` | 客户端导入 VLESS URI。省略 `--to` 时仍使用此格式。 |
| `vless-qr` | `<ref>.vless.png` | 离线生成与 `v2rayn` 同一条 VLESS URI 的 PNG 二维码；不调网络 API。扫码导入不会自动带上 Mihomo YAML 字段。 |
| `mihomo-provider` | `<ref>.mihomo-provider.yaml` | 已经有 Mihomo / Clash Meta 配置。文件只有 `proxies:` 列表，不含 URI 或 base64。 |
| `mihomo-profile` | `<ref>.mihomo-profile.yaml` | FlClash 或 Mihomo 需要第一份文件：一个节点、一个 `select` 组、一条末尾 `MATCH` 规则。 |
| `sing-box` | `<ref>.sing-box.json` | 本地 sing-box 配置：一个 VLESS 出站、一个 `selector`、`route.final` 指向该 selector。不写入站，不开启 TUN，不改 DNS。 |

代理名是 `rq-<节点 id>-<客户端 ref>`，策略组名在其后加 `-select`，同一文件里不会重名。服务器 `network: raw` 导出为 `tcp`，与 URI 一致。只有客户端带 `xtls-rprx-vision` 时才写 `flow`。入站 `decryption` 省略或为 `none` 时才写 `encryption: none`，这也是 URI 里的 `encryption=none`；Mihomo 把这个值当作没有额外的 VLESS 加密。`reality-opts` 另写 `support-x25519mlkem768: true`（布尔、不引号），供 Xray 26.11.9 的 ML-KEM。2026-11-21 的记录里，两台已测 VPS 上的隔离 Mihomo 1.19.33 在 REALITY HTTPS 成功前需要该字段。FlClash 0.9.4（内嵌 Mihomo 1.19.34）在那天导入的是已经带有该字段的测试 profile。2026-11-23 复测中，FlClash 0.9.4 以文件导入直接导入官方 `mihomo-profile`，两台验收节点的延迟测试成功。请导入官方导出，不要使用编辑过的测试副本。不保证所有 Mihomo/Xray 组合。不写 `udp` 和 `packet-encoding`：安装器没有配置数据包编码，而 Mihomo 在省略 `udp` 时默认为 false。profile 不开启 TUN，不改系统 DNS，也不是一套完整路由规则。

FlClash 0.9.0 及更新版本可以解析分享链接，包括 `vless://`。其核心调用 Mihomo 的 `ConvertsV2Ray`，上游有 VLESS REALITY 往返测试。链接解析成功不等于已经和 RouteQuay 固定的 Xray 26.11.9 完成握手，分享链接里也没有策略组或规则。因此仍建议 FlClash 使用 YAML。

Mihomo 的 TLS/REALITY 文档写明不考虑与 xray-core v26.7.11 及更新版本的兼容。RouteQuay 只安装 26.11.9，并且不设置 `minClientVer`。该 Xray 版本里，默认的 `minClientVer=26.3.27` 赋值已被注释；捆绑的 REALITY 库在 `MinClientVer` 为 nil 时跳过版本检查。本次导出不会修改 `minClientVer`，也不会为了兼容而削弱 REALITY。2026-11-21（Asia/Shanghai）在两台已测 VPS 上对 Mihomo 1.19.33 与 FlClash 0.9.4 的有限检查，以及 2026-11-23 的客户端验收复测，都写在测试说明里。复测确认 FlClash 0.9.4 可以文件导入官方 `mihomo-profile`。同一天，Shadowrocket 可以导入与 v2rayN 粘贴相同的剪贴板 `vless://` URI，也可以扫码导入离线 VLESS 二维码；这次对 Shadowrocket 只记录导入成功。这些记录不延伸到全部 Mihomo/Xray 组合，也不把扫描 VLESS 二维码当成携带 Mihomo YAML ML-KEM 字段的方式。2026-11-21 没有把官方文件的隔离 HTTPS 重写成新的状态码与出口矩阵。

### sing-box

`--to sing-box` 写入 `<ref>.sing-box.json`。把这个文件当作本地配置导入：`sing-box check -c <文件>`、`sing-box run -c <文件>`，或图形客户端的“从本地文件导入”。命令只打印路径。没有托管订阅 URL。

字段对齐官方出站文档（[VLESS](https://sing-box.sagernet.org/configuration/outbound/vless/)、[TLS](https://sing-box.sagernet.org/configuration/shared/tls/)），并对照 **sing-box 1.14.4**（2026-10-24 发布，截至 2026-11-23 的最新稳定版）源码里的 `VLESSOutboundOptions`、`OutboundTLSOptions`、`OutboundUTLSOptions`、`OutboundRealityOptions`。`testing` 分支截至 2026-11-19，REALITY 客户端仍然只有同样的三个字段。文件里有：

- 一个标签为 `rq-<节点 id>-<客户端 ref>` 的 `vless` 出站
- 一个标签为 `rq-<节点 id>-<客户端 ref>-select` 的 `selector`，唯一成员和 `default` 都是该出站
- `route.final` 指向这个 selector

`server` 与 `server_port` 来自已保存的端点和入站端口。IPv6 地址写成普通字符串，不加方括号。`uuid` 是客户端 id。只有 `xtls-rprx-vision` 才写 `flow`。入站 `network` 为 `tcp` 或 `raw` 时，导出的 `network` 为 `tcp`。`packet_encoding` 写空字符串，因为 sing-box 1.14.4 在省略该字段时会启用 `xudp`（`protocol/vless/outbound.go`）。`tls.enabled` 为 true。`tls.server_name` 是唯一的 REALITY server name。`tls.utls.enabled` 为 true，`tls.utls.fingerprint` 为 `chrome`：1.14.4 的 REALITY 客户端在未启用 uTLS 时会直接拒绝启动。`tls.reality` 只有 `enabled`、`public_key`、`short_id`。空 short ID 保持为 `""`。

`curve_preferences` 是 sing-box 1.13.0 加入的 Go TLS 选项，允许的取值包含 `X25519MLKEM768`，文档写明列表顺序会被忽略。sing-box 的 REALITY 走 uTLS，因此这里不写 `curve_preferences`，也不把 Mihomo 的 `support-x25519mlkem768` 抄进 JSON。1.14.4 的 `common/tls/reality_client.go` 会从 REALITY ClientHello 中去掉 `X25519MLKEM768`。`testing` 分支提交 `39501357a5`（2026-11-14，说明为 “Stop removing X25519MLKEM768 from reality ClientHello”）改为保留指纹自带的 key share，没有新增 JSON 字段。该提交不在 1.14.4，也不在 1.15.0-alpha.13（2026-10-24）。

文件不写入站，所以不会打开本地代理端口。不写 TUN 和 DNS，也不写 `insecure`。服务器上的 `minClientVer` 保持原样。2026-11-23 用官方 sing-box 1.14.4 对三份合成文件执行 `sing-box check -c`：带 vision flow 和 short ID、空 short ID 且没有 flow、以及 IPv6 服务器，均被接受。同一二进制把抄进去的 `support-x25519mlkem768` 判为未知字段，并在去掉 `utls` 后拒绝该 REALITY 出站。这次合成文件检查只加载 JSON，不建立连接。同一天的验收复测使用官方导出 JSON：`sing-box check -c` 通过，但对 Xray 26.11.9 的 REALITY 握手失败，错误为 `reality verification failed`。原因是官方 1.14.4 从 REALITY ClientHello 去掉 `X25519MLKEM768`。同一路径上，Mihomo 1.19.33 使用官方字段 `reality-opts.support-x25519mlkem768: true` 时成功。不要把削弱服务器 REALITY、修改 `minClientVer` 或向 JSON 添加非官方字段当作解决办法。selector 目前只能通过 Clash API 切换；只有一个出站时，`default` 已经选中它。

## 🧪 测试

本独立候选目录提供的测试命令包括：

```powershell
npm run typecheck
npm run test:unit
npm run test:safety
```

`npm run check` 汇总文件白名单、路径与敏感模式检查及本候选选取的核心、导出器、SSH、CLI 及 smoke 检查，不等于原完整应用测试集。Ubuntu 24.04 / Debian 13 的公网 HTTPS 实机验收另有记录。测试说明包含 2026-11-21 的客户端检查、2026-11-23 的客户端验收复测及其边界。本地 mock 测试通过不等于新环境一定部署成功。

测试依据与限制见 [测试说明](docs/TESTING.zh-CN.md)。

## 🔐 安全提醒与限制

- **严禁提交** SSH 私钥、令牌、真实 VLESS 链接、本地私有节点状态、可能包含敏感字段的安装 journal 和导出产物。
- 执行变更前先检查 `setup --plan`，不要假定工具会自动设置云防火墙或随意替换已有服务。
- 必须保留严格 SSH 主机密钥校验；连接地址变化与服务器身份变化不是一回事。
- 不支持旧版写者与新版节点锁协议混用。遗留 guard/锁需要先确认相关操作全部静默，再人工核查恢复。
- 当前 CLI **并非**通用内外网虚拟组网方案，也不是已达到生产成熟度的多用户 Web 面板。
- 请遵守所在地法律法规及服务商条款。

## 🗺️ 后续方向

现阶段优先完成：可审计的 Core-first 公开源码快照、双语文档、可复现安装说明与精简测试流程。Web 管理、其他连接技术和线路评测只是探索方向，**不构成功能承诺**。

详见 [路线图](docs/ROADMAP.zh-CN.md)。

## 🤝 反馈与贡献

现在可以通过 GitHub Issue 反馈问题、需求或维护任务。ForgottenLab 的账户级 `.github` 仓库已经提供默认 Issue 表单与 PR 模板，项目没有自定义覆盖时会直接复用。英文或简体中文均可，无须重复写两份。

## 📜 许可证

RouteQuay 采用 [MIT License](LICENSE)，Copyright (c) 2026 ForgottenLab。本仓库已公开源码，但尚未创建正式版本 Release 或独立安装包。Xray 本体是采用独立 MPL-2.0 许可证的软件，不受本项目 MIT 许可替代。详见[许可证审阅](docs/LICENSE-REVIEW.md)。
