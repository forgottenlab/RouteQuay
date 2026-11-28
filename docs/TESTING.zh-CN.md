# 🧪 RouteQuay 测试说明

[English README](../README.md) | [简体中文 README](../README.zh-CN.md)

本页说明当前已掌握的测试证据与首次公开前仍需执行的验证。它不是自动生成的 CI 状态报告。

## 测试范围

- 已归档的 Ubuntu 24.04 LTS、Debian 13 实机验收：首次安装、状态校验、客户端导出、v2rayN 实际 HTTPS 请求均通过。
- 2026-11-21（Asia/Shanghai，UTC+8）在这两台已测 VPS 上补充了有限的 Mihomo、FlClash 与 v2rayN 二维码图像导入记录。边界见下文同名小节，不扩大发行版或客户端范围，也不改写更早的安装验收。
- 2026-11-23 复测了 FlClash 0.9.4 对官方 profile 的文件导入（两台验收节点的延迟测试成功）、Shadowrocket 的导入，以及 sing-box 1.14.4 对 Xray 26.11.9 的 REALITY 握手。结果与边界见下文同名小节，不扩大发行版范围，也不改写更早的安装验收。
- Debian 曾出现旧公网 IP 的特定连接路径问题。通过合法更换公网 IP 并进行 SSH 主机身份验证后，完成端到端代理验证。旧 IP 的最终丢包位置及根因未被证明。
- 新增 endpoint 更新、安全 journal 校验、并发 export 与节点锁清理逻辑完成本地测试和针对性独立复审。
- 操作员配置里的 `ssh.configPath`（`ssh -F`）和节点 `identityFile`（`ssh -i` 与 `IdentitiesOnly=yes`）由本地参数测试覆盖。这些测试不启动 ssh，不读取私钥字节，也不连接远程主机。配置文件或密钥路径缺失、是符号链接、为空、过大，或在 POSIX 上对组/其他用户可读时，在启动 ssh 之前失败，输出只有错误码。模板本身不包含这两项路径，避免 `init-config` 把示例路径传给 ssh。
- `add-client` 在本地 mock 中覆盖：向已有入站追加一个客户端、已有客户端与 REALITY 参数保持不变、`minClientVer` 不被改写、多个客户端时 `pull` / `export` 仍要求显式 ref、`status` 返回 `inbound-N-client-N`。终端和 JSON 只检查路径，不断言 URI、UUID、私钥或 shortId。远程追加脚本在临时文件上检查拒绝轮换和失败回滚。Linux 上另有一项检查不设置 `ROUTEQUAY_CLIENT_LOCAL`：在用户命名空间里把临时文件系统挂到 `/var/backups`，用目录描述符加锁，再走收据、配置写入和假的重启路径。该项里 `open()` 目录得到 `IsADirectoryError`，锁仍然成功。远端回滚失败或无法识别的结果会保留标记、退出码和异常类名；重新探测后配置仍是基线时，删除这次客户端变更日志。非 Linux 上这项目录锁检查直接返回，不记成已经执行。这些测试不连接 SSH，也不在真实节点上重启 Xray。
- 本机分组在本地 mock 中覆盖：创建、列出、重命名、删除分组，以及添加和移除成员。成员是 `inbound-N-client-N`。分组文件缺失时列出为空；残缺文件失败且不改写。删除分组不改远程客户端。`status` 只显示分组名和 ref。`export` / `pull --group` 为每个成员分别写现行文件。终端和 JSON 只检查路径、分组名和 ref，不断言 URI、UUID、私钥或 shortId。这些测试不连接 SSH。
- 可选本机技能由 `npm run test:skill` 检查，`npm run test:smoke` 也会调用同一检查。技能文件是 `.agents/skills/routequay/SKILL.md`。它点名的命令必须出现在 `routequay --help`。检查脚本把分享链接方案拼接起来，只用来确认禁令写在正文里、示例块里没有它，并且没有带载荷的链接。脚本不写入 UUID 或私钥，只断言技能里没有这两种材料。操作员配置模板仍然没有 `ssh.configPath`、`knownHostsPath` 和 `identityFile`。运行包清单不包含该技能。这项检查不连接 SSH。

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

`routequay pull <node>` 复用上述五种导出，把文件写到临时数据目录的 `local/private/cli-nodes/<node>/`：`<ref>.vless.txt`、`<ref>.vless.png`、`<ref>.mihomo-provider.yaml`、`<ref>.mihomo-profile.yaml`、`<ref>.sing-box.json`。测试断言目录 0700、文件 0600（非 Windows）、默认人类可读输出和 JSON 只有路径、不含 URI、UUID、私钥、公钥或 shortId。同名现行文件的策略是覆盖：内容相同则保留并重新收紧权限；内容不同则替换为新的导出字节。符号链接拒绝，并且不会顺带改写其他文件。权限收紧失败时命令失败。缺少的 `--out` 目录拒绝创建。单次 `export` 仍在内容不同时返回 `OUTPUT_EXISTS`。成功的 `setup --apply` 会写回全部五种文件；状态未变化的再次 setup 不改已有文件；状态变化后的接管会覆盖同名现行文件。多个客户端且没有 `--client` 时，接管本身完成，带回失败并给出 `CLIENT_SELECTION_REQUIRED`。这些测试不连接真实 SSH，也不写入真实用户主目录，因此不覆盖“已有本地状态时 SSH 连不上”。该情况见下文 2026-11-24 Windows 操作员核对：错误是 `SSH_UNAVAILABLE`（退出码 4），现行文件保持不变。

这些检查不连接 SSH，也不与 FlClash 或 Mihomo 握手。Windows ACL 用例在 `process.platform !== 'win32'` 时直接返回，TAP 仍会计为通过；只在 Linux 上跑完测试，不能写成已经执行 Windows ACL。POSIX 文件 0600、目录 0700 只在实际执行该断言的系统上成立。

兼容性口径与 README 相同：FlClash 0.9.0+ 可以解析 `vless://`，但解析成功不是握手成功；不把当前 26.11.9 安装写成必然拒绝 Mihomo；不把 `minClientVer` 改成 1.8.2，也不削弱 REALITY。2026-11-21 的有限实机记录只覆盖下文点名的版本与两台 VPS。2026-11-23 的验收复测另记 FlClash 0.9.4 官方 profile 文件导入、Shadowrocket 导入，以及 sing-box 1.14.4 的握手结果。

### 2026-11-20 本地复测

Linux、Node.js v22.23.4 上执行 `npm ci --ignore-scripts --no-audit --no-fund` 和 `npm run check`：类型检查通过；单元 16、安全 5、SSH 信任 2、CLI 39 全部通过，0 失败。smoke 与候选文件扫描（45 个文件）通过。没有连接 SSH，没有做 FlClash 或 Mihomo 握手。

同一次 CLI 测试中，Windows ACL 用例因平台不是 win32 立即返回，TAP 仍把它计为通过。这次没有执行 Windows ACL。文件 0600 与目录 0700 的断言在这次 Linux 运行里执行并通过。

### 2026-11-24 本地带回检查

Linux、Node.js v22.23.4 上执行 `npm ci --ignore-scripts --no-audit --no-fund` 和 `npm run check`：类型检查通过；单元 28、安全 5、SSH 信任 2、CLI 46、安装器 16 全部通过，0 失败。smoke 通过。候选文件扫描 64 个文件通过。没有连接 SSH，没有写入真实用户主目录，没有做客户端握手。Windows ACL 用例因平台不是 win32 立即返回，这次没有执行 Windows ACL。`pull` 的 0600/0700 断言在这次 Linux 运行里执行并通过。

## 2026-11-24 Windows 操作员核对（Asia/Shanghai）

本节只记录 PR #9 进入 `main`（`81bcb1f`）之后，在操作员 Windows 机器上已经核对过的安装更新和 `pull`。不写主机名、地址或文件哈希，也不把这次核对写成新的客户端握手或发行版范围。

- 在检出目录执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Action update -Yes`。它更新现有目标目录中的程序文件，不删除用户配置。当时没有同时使用 `-ConfirmPath`。当前用户 PATH 已经包含程序目录，安装器输出 `pathUpdated` 为 `false`。
- 带安装标记 `routequay-install.json` 的安装使用 `%USERPROFILE%\.routequay\`，也可以用 `--data-dir` 或 `ROUTEQUAY_DATA_DIR`。没有安装标记的检出使用仓库里的 `local/private`。两处数据根不会自动迁移。检出目录里的节点状态，已安装的 `routequay` 看不到。
- 更新之后，`%USERPROFILE%\.routequay\` 里可以只有 `config.json`，没有节点状态。此时 `routequay pull <node>` 在 SSH 之前返回 `SETUP_REQUIRED`。`config.json` 里的 `nodes` 不能代替节点状态。
- 检出目录里已经有节点状态时，`pull` 仍先通过 SSH 探测。SSH 无法连接时，正式错误是 `SSH_UNAVAILABLE`（退出码 4），五个现行文件不写入、也不改动。`SSH_AUTH_FAILED` 是另一条错误。

## sing-box JSON 导出

`--to sing-box` 生成一份可本地导入的官方 sing-box JSON：一个 `vless` 出站、一个 `selector`、`route.final` 指向该 selector。标签与 Mihomo 相同，为 `rq-<节点 id>-<客户端 ref>` 和带 `-select` 的 selector。不写入站、TUN、DNS 或 `insecure`。终端和 `--json` 只给出路径与格式名。

目标版本是官方稳定版 **sing-box 1.14.4**（2026-10-24 发布；截至 2026-11-23，GitHub Releases 上没有更新的稳定版）。字段对照该标签的 `VLESSOutboundOptions`、`OutboundTLSOptions`、`OutboundUTLSOptions`、`OutboundRealityOptions`，以及当时的在线文档 [VLESS](https://sing-box.sagernet.org/configuration/outbound/vless/) 与 [TLS](https://sing-box.sagernet.org/configuration/shared/tls/)。`testing` 分支在 2026-11-19 的 REALITY 客户端结构体仍然只有 `enabled`、`public_key`、`short_id`。

写入的出站字段：`server`、`server_port`、`uuid`、仅当 flow 为 `xtls-rprx-vision` 时的 `flow`、`network: "tcp"`、`packet_encoding: ""`、`tls.enabled`、`tls.server_name`、`tls.utls.enabled: true`、`tls.utls.fingerprint: "chrome"`、`tls.reality.enabled`、`tls.reality.public_key`、`tls.reality.short_id`。空 shortId 写成 `""`。IPv6 不加方括号。uTLS 是 1.14.4 `common/tls/reality_client.go` 的启动条件（未启用时返回 `uTLS is required by reality client`）。`packet_encoding` 使用空字符串，因为同一版本的 `protocol/vless/outbound.go` 在字段缺失时把编码设为 xudp；`network` 为 `tcp` 时不启用 UDP。

官方 schema 里没有 Mihomo 的 `support-x25519mlkem768`。`curve_preferences` 自 1.13.0 起包含 `X25519MLKEM768`，但是 Go TLS 的密钥交换列表，文档写明顺序会被忽略；REALITY 走 uTLS，导出文件不写这个字段。1.14.4 在 REALITY 客户端代码中从 ClientHello 去掉 `X25519MLKEM768`。`testing` 提交 `39501357a5`（2026-11-14）停止去掉该 key share，且没有新增 JSON 字段；它不在 1.14.4 或 1.15.0-alpha.13（2026-10-24）里。因此当前没有一个官方配置项可以单独打开或关闭这一行为。

本地 mock 覆盖上述字段、权限 0600/0700、内容不同则 `OUTPUT_EXISTS`、以及输出不含 URI、UUID、公钥或 shortId。这些检查不连接 SSH，也不与 sing-box 或 Xray 握手。导入方式是保存该 JSON 后在本机执行 `sing-box check -c <文件>` 或由客户端从本地文件导入；`sing-box run -c <文件>` 不会因为这份文件打开监听端口。

**2026-11-23 本地 `sing-box check`。** 官方发布包 sing-box 1.14.4（linux/amd64，revision `c005f35300ce76427dc285481ec5695f5b179cd2`）对三份合成 JSON 执行 `sing-box check -c`：带 `xtls-rprx-vision` 与 short ID、空 short ID 且省略 `flow`、IPv6 服务器。三份都退出 0。同一二进制把抄入的 `support-x25519mlkem768` 报为 unknown field，并在去掉 `utls` 时返回 `uTLS is required by reality client`。公钥是本机临时生成的 X25519 公钥，配置留在临时目录，不进入仓库。这次检查没有连接网络。

**本地检查的边界：** 上述 `check` 使用合成 JSON，只说明 1.14.4 能加载这些文件。这次检查没有连接网络，也没有操作图形客户端。不能把上游 issue 或第三方记录单独写成 RouteQuay 的实机验收。同一天的验收复测另行使用官方导出 JSON：`sing-box check -c` 通过，对 Xray 26.11.9 的 REALITY 握手失败，见下文「2026-11-23 客户端验收复测」。

## 2026-11-21 客户端有限验收（Asia/Shanghai，UTC+8）

本节只记录 PR #3 合并进 `main`（`f918246`）之后、2026-11-21 当天实际做过的检查。环境是 Ubuntu 24.04 与 Debian 13 两台 VPS，Xray 26.11.9，TCP 8443，REALITY target/SNI 为 `www.cloudflare.com:443`。结论停在这两台主机和下面点名的客户端版本。

官方导出在 `mihomo-provider` 与 `mihomo-profile` 的 `reality-opts` 中写入未加引号的布尔值 `support-x25519mlkem768: true` 之后，记录如下。

**隔离 Mihomo 1.19.33 的 HTTPS 对照。** 两台 VPS 都做了对照。没有该字段时 REALITY 认证失败；只加上该字段后，发往测试目标的 HTTPS 返回 HTTP 200，TLS 校验通过，出口地址等于对应 VPS 的公网地址。这一结果先在临时测试 YAML 副本上得到。合并后重新导出的两份官方 profile，与这些已经过图形界面测试的副本 SHA-256 相同：Ubuntu `dde28473d951af5c24f25d9d8152230358913943b6c563d7ed456034de9fc6cf`，Debian `c6a8ff2dfd0b16a4234fcecbff1d20677f721e2afb9e2294986ad10626cb8d92`。

**FlClash 0.9.4（内嵌 Mihomo 1.19.34）。** 图形界面以文件方式导入上述带 ML-KEM 字段的测试 profile。Ubuntu 节点延迟 121 ms，面板出口地址等于该 VPS 公网地址（具体地址不写入公开文档），服务检查为绿色；Debian 节点延迟 125 ms。测试机上 mixed 入站 7890 的绑定冲突仍然存在，与这次导入相互独立，本次没有修复。本次未把 FlClash 记成日常应用代理，也未把 mixed 端口记成可用。最后一次会话没有改用合并后的官方文件重新导入 FlClash；当时的依据是官方 profile 与已测副本的哈希一致。这一句只描述 2026-11-21。2026-11-23 已用官方 `mihomo-profile` 做文件导入，见下一节。

**合并后的官方 CLI 导出。** 2026-11-21 在 `main` `f918246` 之后重新生成。四份官方 Mihomo YAML 为两台 VPS 各自的 `mihomo-provider` 与 `mihomo-profile`，都含未加引号的 `support-x25519mlkem768: true`。Mihomo 1.19.33 的 `-t` 在这四份文件上都成功。两台节点的官方 `vless-qr` PNG 按仓库测试的做法用 jsqr 离线解码；去掉同一次 `v2rayn` 文本文件末尾换行后，与该 URI 一致。

**v2rayN 二维码图像导入。** 2026-11-21 用图形界面导入上述官方 PNG，两台节点都成功：Debian 延迟 120 ms，Ubuntu 延迟 131 ms。更早一次 Ubuntu v2rayN 的 URI/图形界面测试记录为 124 ms、13.8 MB/s，与本次 2026-11-21 的二维码图像导入分开保留。

**本次未覆盖：**

- 合并之后没有再对官方文件重跑隔离 HTTPS。已有证据是临时副本上的对照、FlClash 图形界面导入，以及官方 profile 与已测副本哈希相同。FlClash 直接导入官方 profile 的结果记在 2026-11-23 复测，不回写成 2026-11-21 当天的结果。
- 扫描 VLESS URI 二维码不会带上 Mihomo YAML 里的 ML-KEM 字段。FlClash 继续使用 YAML。
- 已审阅 URL 订阅托管，本次没有引入。CLI 保持本地优先，凭据留在私有本地文件。
- REALITY 与 `minClientVer` 保持原样。
- 不覆盖全部 Mihomo 与 Xray 版本组合。
- 测试当时的临时本机 /32 路由和安全组 /32 放行是环境条件，不是产品功能。本文不记录测试机广域网地址或安全组网段。

## 2026-11-23 客户端验收复测

本节只记录 2026-11-23 客户端验收复测中已经核实的结果。FlClash 0.9.4 的延迟测试覆盖两台已记录的验收节点。本节不把这一节点范围套到 Shadowrocket 或 sing-box。客户端版本只写下面点名的版本。不扩大发行版范围，也不改写更早的安装验收和 2026-11-21 当天的记录。本文不写测试机广域网地址、安全组、云实例标识、节点公网地址、凭据、UUID、私钥或 URI。

**FlClash 0.9.4。** 官方 RouteQuay `mihomo-profile` YAML 可以通过文件导入直接导入。两台验收节点的延迟测试都成功。请导入官方导出文件，不要改用编辑过的测试副本。

**Shadowrocket。** 导入成功。与 v2rayN 粘贴所用的同一条剪贴板 `vless://` URI 可以导入，离线 VLESS 二维码也可以扫码导入。这次只记录导入，没有 Shadowrocket 的流量或出口结果。

**sing-box 1.14.4。** 官方导出的 JSON 通过 `sing-box check -c`。对 Xray 26.11.9 的 REALITY 握手失败，错误为 `reality verification failed`。这是已知的上游限制：官方 sing-box 1.14.4 会从 REALITY ClientHello 中去掉 `X25519MLKEM768`。同一路径上，Mihomo 1.19.33 使用官方字段 `reality-opts.support-x25519mlkem768: true` 时成功。不要为此削弱服务器 REALITY，不要修改 `minClientVer`，也不要向 sing-box JSON 添加非官方字段。

## 不能从当前结果推断的事项

- 不代表对所有 Linux 版本或云服务商提供兼容保证。
- 不代表已经验证长期稳定性、全部网络运营商或高负载吞吐。
- 不代表实验性的 Web 管理功能达到可发布质量。
- 本地模拟通过不等于远端实机测试重新执行。
- 2026-11-21 仍未把官方文件的隔离 HTTPS 写成新的状态码与出口矩阵，也不覆盖全部 Mihomo 与 Xray 版本组合。FlClash 0.9.4 对官方 `mihomo-profile` 的文件导入以 2026-11-23 复测为准。
- sing-box JSON 通过 `sing-box check -c` 只说明 1.14.4 能加载该文件。2026-11-23 复测中，官方导出 JSON 对 Xray 26.11.9 的 REALITY 握手失败，错误为 `reality verification failed`。官方 sing-box 1.14.4 会从 REALITY ClientHello 去掉 `X25519MLKEM768`。同一路径上，Mihomo 1.19.33 使用官方字段 `reality-opts.support-x25519mlkem768: true` 时成功。这不构成削弱服务器 REALITY、修改 `minClientVer` 或添加非官方 sing-box JSON 字段的依据。

## Windows 安装器

`npm run test:installer` 在临时目录检查精简运行包的安装、当前用户 PATH 垫片解析、更新和卸载。更新与卸载不得改动单独的用户数据目录。测试不连接 SSH，不写注册表，也不安装 Node.js。PowerShell 入口由同一套 Node 安装逻辑执行；脚本本身在 Linux 检查里只做文本约束（确认后才改当前用户 PATH、不改系统级 PATH、不删除用户配置）。Windows ACL 仍由既有的私有路径助手负责，本项测试不把它记成已经在 Windows 上执行。2026-11-24 的 Windows 操作员核对另记正式更新命令在未加 `-ConfirmPath`、且当前用户 PATH 已含程序目录时输出 `pathUpdated` 为 `false`，并保留用户配置。那次核对不是本项 Linux 安装器测试。

`npm ci` 在 Windows 上不能直接 `spawn` / `spawnSync` 一个 `.cmd` 或 `.bat`。Node.js 在没有 `shell` 时会返回 `EINVAL`；Volta 这类 `npm.cmd` 会走到这条路径。安装器改为通过 `cmd.exe /d /s /c` 运行 `npm.cmd` 和固定的 `ci` 参数。失败结果除 `NPM_CI_FAILED` 外还带删减后的 `reason`。测试断言这条调用形状，并用临时目录里的假 `npm` 走一遍不带 `--skip-npm` 的安装。Linux 检查不执行 PowerShell，也不执行真实 `.cmd`，也不碰真实用户配置目录。

## 测试安全

不得使用真实 SSH 密钥和客户端凭据作为 CI fixtures。使用测试用合成节点、临时路径和 mock transport。远端 `setup`、服务重启和云资源清理必须获得单独授权。

## 本独立候选验证（2026-11-17）

在本候选目录实际运行 npm run check：类型检查通过，核心/导出器10项、安全5项、SSH信任边界2项、接管/安装/endpoint/export回归36项全部通过，无失败或跳过，CLI help及无网络参数拒绝smoke通过。原开发仓库的113项广泛应用测试未复制，避免引入Web/Server耦合，不能混用数量。

受测环境为Windows、Node.js22.19.0、npm10.9.3；测试使用合成凭据，不连接SSH。新增check:candidate使用显式文件白名单与非示例地址/非fixture UUID/凭据模式/路径/相对链接检查；它减少发布快照混入私有文件的风险，不替代人工复核。

### 独立干净安装复测

仅将41个候选文件复制到不含node_modules和私有状态的新目录，实际执行 npm ci --ignore-scripts --no-audit --no-fund 和 npm run check，结果相同：10+5+2+36=53项通过，0失败/跳过；CLI smoke和候选文件扫描通过。主候选目录npm ci、npm run build及Windows vpncp.cmd --help退出0。这里不是Git克隆（尚未允许首次commit），而是只含明确文件集合的干净源码复制验证；未重新连接实机。
