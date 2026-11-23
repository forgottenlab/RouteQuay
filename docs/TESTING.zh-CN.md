# 🧪 RouteQuay 测试说明

[English README](../README.md) | [简体中文 README](../README.zh-CN.md)

本页说明当前已掌握的测试证据与首次公开前仍需执行的验证。它不是自动生成的 CI 状态报告。

## 测试范围

- 已归档的 Ubuntu 24.04 LTS、Debian 13 实机验收：首次安装、状态校验、客户端导出、v2rayN 实际 HTTPS 请求均通过。
- 2026-11-21（Asia/Shanghai，UTC+8）在这两台已测 VPS 上补充了有限的 Mihomo、FlClash 与 v2rayN 二维码图像导入记录。边界见下文同名小节，不扩大发行版或客户端范围，也不改写更早的安装验收。
- Debian 曾出现旧公网 IP 的特定连接路径问题。通过合法更换公网 IP 并进行 SSH 主机身份验证后，完成端到端代理验证。旧 IP 的最终丢包位置及根因未被证明。
- 新增 endpoint 更新、安全 journal 校验、并发 export 与节点锁清理逻辑完成本地测试和针对性独立复审。

## 已报告的本地验证结果

2026-11-17 最终复审记录：专项测试 40/40、单元测试 113/113、安全测试 2/2，类型检查与 `git diff --check` 通过。此处引用的是开发阶段证据，**不是对未来公开快照的测试保证**。

```powershell
npm run typecheck
npm run test:unit
npm run test:safety
```

## 公开前必须重新验证

1. 在隔离、干净的目录中获得公开候选源码，不借用原仓库的未跟踪文件。
2. 根据实际锁文件安装依赖，确认运行时版本和命令入口。
3. 运行上述测试、已确认的专项测试和最小 CLI smoke test。
4. 检查 README 中每一条安装和使用命令能否直接复现。
5. 验证没有真实凭据、测试云服务器地址或私有状态文件进入快照或 Git 历史。
6. 若添加 CI，只运行无需 SSH 密钥、无需真实服务器的安全测试。

## Mihomo YAML 导出

`vpncp export --to v2rayn|vless-qr|mihomo-provider|mihomo-profile|sing-box` 在本地 mock 中覆盖字段映射、IPv6、空 shortId、代理名与组名不冲突、未知 `--to`（含笼统的 `clash`）拒绝、内容不同则 `OUTPUT_EXISTS`、以及 JSON/人类可读输出不包含 URI、UUID、公钥或 shortId。`v2rayn` 仍写 `.vless.txt`；`vless-qr` 写 `.vless.png`，单元测试用合成 fixture 解码二维码并与 URI 逐字节比对。Mihomo YAML 的 `reality-opts` 断言包含 `support-x25519mlkem768: true`。provider 只有 `proxies:`；profile 只有一个节点、一个 select 组和一条 `MATCH`，不写 TUN、DNS、`udp` 或 `packet-encoding`。`sing-box` 写 `.sing-box.json`，断言见下一节。

这些检查不连接 SSH，也不与 FlClash 或 Mihomo 握手。Windows ACL 用例在 `process.platform !== 'win32'` 时直接返回，TAP 仍会计为通过；只在 Linux 上跑完测试，不能写成已经执行 Windows ACL。POSIX 文件 0600、目录 0700 只在实际执行该断言的系统上成立。

兼容性口径与 README 相同：FlClash 0.9.0+ 可以解析 `vless://`，但解析成功不是握手成功；不把当前 26.11.9 安装写成必然拒绝 Mihomo；不把 `minClientVer` 改成 1.8.2，也不削弱 REALITY。2026-11-21 的有限实机记录只覆盖下文点名的版本与两台 VPS。

### 2026-11-20 本地复测

Linux、Node.js v22.23.4 上执行 `npm ci --ignore-scripts --no-audit --no-fund` 和 `npm run check`：类型检查通过；单元 16、安全 5、SSH 信任 2、CLI 39 全部通过，0 失败。smoke 与候选文件扫描（45 个文件）通过。没有连接 SSH，没有做 FlClash 或 Mihomo 握手。

同一次 CLI 测试中，Windows ACL 用例因平台不是 win32 立即返回，TAP 仍把它计为通过。这次没有执行 Windows ACL。文件 0600 与目录 0700 的断言在这次 Linux 运行里执行并通过。

## sing-box JSON 导出

`--to sing-box` 生成一份可本地导入的官方 sing-box JSON：一个 `vless` 出站、一个 `selector`、`route.final` 指向该 selector。标签与 Mihomo 相同，为 `rq-<节点 id>-<客户端 ref>` 和带 `-select` 的 selector。不写入站、TUN、DNS 或 `insecure`。终端和 `--json` 只给出路径与格式名。

目标版本是官方稳定版 **sing-box 1.14.4**（2026-10-24 发布；截至 2026-11-23，GitHub Releases 上没有更新的稳定版）。字段对照该标签的 `VLESSOutboundOptions`、`OutboundTLSOptions`、`OutboundUTLSOptions`、`OutboundRealityOptions`，以及当时的在线文档 [VLESS](https://sing-box.sagernet.org/configuration/outbound/vless/) 与 [TLS](https://sing-box.sagernet.org/configuration/shared/tls/)。`testing` 分支在 2026-11-19 的 REALITY 客户端结构体仍然只有 `enabled`、`public_key`、`short_id`。

写入的出站字段：`server`、`server_port`、`uuid`、仅当 flow 为 `xtls-rprx-vision` 时的 `flow`、`network: "tcp"`、`packet_encoding: ""`、`tls.enabled`、`tls.server_name`、`tls.utls.enabled: true`、`tls.utls.fingerprint: "chrome"`、`tls.reality.enabled`、`tls.reality.public_key`、`tls.reality.short_id`。空 shortId 写成 `""`。IPv6 不加方括号。uTLS 是 1.14.4 `common/tls/reality_client.go` 的启动条件（未启用时返回 `uTLS is required by reality client`）。`packet_encoding` 使用空字符串，因为同一版本的 `protocol/vless/outbound.go` 在字段缺失时把编码设为 xudp；`network` 为 `tcp` 时不启用 UDP。

官方 schema 里没有 Mihomo 的 `support-x25519mlkem768`。`curve_preferences` 自 1.13.0 起包含 `X25519MLKEM768`，但是 Go TLS 的密钥交换列表，文档写明顺序会被忽略；REALITY 走 uTLS，导出文件不写这个字段。1.14.4 在 REALITY 客户端代码中从 ClientHello 去掉 `X25519MLKEM768`。`testing` 提交 `39501357a5`（2026-11-14）停止去掉该 key share，且没有新增 JSON 字段；它不在 1.14.4 或 1.15.0-alpha.13（2026-10-24）里。因此当前没有一个官方配置项可以单独打开或关闭这一行为。

本地 mock 覆盖上述字段、权限 0600/0700、内容不同则 `OUTPUT_EXISTS`、以及输出不含 URI、UUID、公钥或 shortId。这些检查不连接 SSH，也不与 sing-box 或 Xray 握手。导入方式是保存该 JSON 后在本机执行 `sing-box check -c <文件>` 或由客户端从本地文件导入；`sing-box run -c <文件>` 不会因为这份文件打开监听端口。

**2026-11-23 本地 `sing-box check`。** 官方发布包 sing-box 1.14.4（linux/amd64，revision `c005f35300ce76427dc285481ec5695f5b179cd2`）对三份合成 JSON 执行 `sing-box check -c`：带 `xtls-rprx-vision` 与 short ID、空 short ID 且省略 `flow`、IPv6 服务器。三份都退出 0。同一二进制把抄入的 `support-x25519mlkem768` 报为 unknown field，并在去掉 `utls` 时返回 `uTLS is required by reality client`。公钥是本机临时生成的 X25519 公钥，配置留在临时目录，不进入仓库。这次检查没有连接网络。

**尚未验证：** 没有在 Xray 26.11.9 上用任何 sing-box 版本完成 REALITY 握手或 HTTPS。不能把上游 issue 或第三方记录写成 RouteQuay 的实机验收。官方 1.14.4 能否与当前服务器完成 REALITY，需要使用者自行确认。图形客户端的导入界面也没有在本次检查中操作。`check` 通过只说明这份 JSON 能被 1.14.4 加载。

## 2026-11-21 客户端有限验收（Asia/Shanghai，UTC+8）

本节只记录 PR #3 合并进 `main`（`f918246`）之后、2026-11-21 当天实际做过的检查。环境是 Ubuntu 24.04 与 Debian 13 两台 VPS，Xray 26.11.9，TCP 8443，REALITY target/SNI 为 `www.cloudflare.com:443`。结论停在这两台主机和下面点名的客户端版本。

官方导出在 `mihomo-provider` 与 `mihomo-profile` 的 `reality-opts` 中写入未加引号的布尔值 `support-x25519mlkem768: true` 之后，记录如下。

**隔离 Mihomo 1.19.33 的 HTTPS 对照。** 两台 VPS 都做了对照。没有该字段时 REALITY 认证失败；只加上该字段后，发往测试目标的 HTTPS 返回 HTTP 200，TLS 校验通过，出口地址等于对应 VPS 的公网地址。这一结果先在临时测试 YAML 副本上得到。合并后重新导出的两份官方 profile，与这些已经过图形界面测试的副本 SHA-256 相同：Ubuntu `dde28473d951af5c24f25d9d8152230358913943b6c563d7ed456034de9fc6cf`，Debian `c6a8ff2dfd0b16a4234fcecbff1d20677f721e2afb9e2294986ad10626cb8d92`。

**FlClash 0.9.4（内嵌 Mihomo 1.19.34）。** 图形界面以文件方式导入上述带 ML-KEM 字段的测试 profile。Ubuntu 节点延迟 121 ms，面板出口地址等于该 VPS 公网地址（具体地址不写入公开文档），服务检查为绿色；Debian 节点延迟 125 ms。测试机上 mixed 入站 7890 的绑定冲突仍然存在，与这次导入相互独立，本次没有修复。本次未把 FlClash 记成日常应用代理，也未把 mixed 端口记成可用。最后一次会话没有改用合并后的官方文件重新导入 FlClash；当时的依据是官方 profile 与已测副本的哈希一致。

**合并后的官方 CLI 导出。** 2026-11-21 在 `main` `f918246` 之后重新生成。四份官方 Mihomo YAML 为两台 VPS 各自的 `mihomo-provider` 与 `mihomo-profile`，都含未加引号的 `support-x25519mlkem768: true`。Mihomo 1.19.33 的 `-t` 在这四份文件上都成功。两台节点的官方 `vless-qr` PNG 按仓库测试的做法用 jsqr 离线解码；去掉同一次 `v2rayn` 文本文件末尾换行后，与该 URI 一致。

**v2rayN 二维码图像导入。** 2026-11-21 用图形界面导入上述官方 PNG，两台节点都成功：Debian 延迟 120 ms，Ubuntu 延迟 131 ms。更早一次 Ubuntu v2rayN 的 URI/图形界面测试记录为 124 ms、13.8 MB/s，与本次 2026-11-21 的二维码图像导入分开保留。

**本次未覆盖：**

- 合并之后没有再对官方文件重跑隔离 HTTPS。已有证据是临时副本上的对照、FlClash 图形界面导入，以及官方 profile 与已测副本哈希相同。
- 扫描 VLESS URI 二维码不会带上 Mihomo YAML 里的 ML-KEM 字段。FlClash 继续使用 YAML。
- 已审阅 URL 订阅托管，本次没有引入。CLI 保持本地优先，凭据留在私有本地文件。
- REALITY 与 `minClientVer` 保持原样。
- 不覆盖全部 Mihomo 与 Xray 版本组合。
- 测试当时的临时本机 /32 路由和安全组 /32 放行是环境条件，不是产品功能。本文不记录测试机广域网地址或安全组网段。

## 不能从当前结果推断的事项

- 不代表对所有 Linux 版本或云服务商提供兼容保证。
- 不代表已经验证长期稳定性、全部网络运营商或高负载吞吐。
- 不代表实验性的 Web 管理功能达到可发布质量。
- 本地模拟通过不等于远端实机测试重新执行。
- 2026-11-21 客户端记录的未覆盖项仍然成立，包括未重跑的官方文件隔离 HTTPS、未用官方文件重导入的 FlClash，以及未测的 Mihomo/Xray 版本组合。
- sing-box JSON 的字段检查不能推出它已经和 Xray 26.11.9 完成 REALITY。官方 1.14.4 会在客户端代码里去掉 `X25519MLKEM768`，而停止去掉该 key share 的改动当时只在未发布的 `testing` 提交里。

## 测试安全

不得使用真实 SSH 密钥和客户端凭据作为 CI fixtures。使用测试用合成节点、临时路径和 mock transport。远端 `setup`、服务重启和云资源清理必须获得单独授权。

## 本独立候选验证（2026-11-17）

在本候选目录实际运行 npm run check：类型检查通过，核心/导出器10项、安全5项、SSH信任边界2项、接管/安装/endpoint/export回归36项全部通过，无失败或跳过，CLI help及无网络参数拒绝smoke通过。原开发仓库的113项广泛应用测试未复制，避免引入Web/Server耦合，不能混用数量。

受测环境为Windows、Node.js22.19.0、npm10.9.3；测试使用合成凭据，不连接SSH。新增check:candidate使用显式文件白名单与非示例地址/非fixture UUID/凭据模式/路径/相对链接检查；它减少发布快照混入私有文件的风险，不替代人工复核。

### 独立干净安装复测

仅将41个候选文件复制到不含node_modules和私有状态的新目录，实际执行 npm ci --ignore-scripts --no-audit --no-fund 和 npm run check，结果相同：10+5+2+36=53项通过，0失败/跳过；CLI smoke和候选文件扫描通过。主候选目录npm ci、npm run build及Windows vpncp.cmd --help退出0。这里不是Git克隆（尚未允许首次commit），而是只含明确文件集合的干净源码复制验证；未重新连接实机。
