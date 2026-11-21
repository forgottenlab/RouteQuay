# 🧪 RouteQuay 测试说明

[English README](../README.md) | [简体中文 README](../README.zh-CN.md)

本页说明当前已掌握的测试证据与首次公开前仍需执行的验证。它不是自动生成的 CI 状态报告。

## 测试范围

- 已归档的 Ubuntu 24.04 LTS、Debian 13 实机验收：首次安装、状态校验、客户端导出、v2rayN 实际 HTTPS 请求均通过。
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

`vpncp export --to v2rayn|vless-qr|mihomo-provider|mihomo-profile` 在本地 mock 中覆盖字段映射、IPv6、空 shortId、代理名与组名不冲突、未知 `--to`（含笼统的 `clash`）拒绝、内容不同则 `OUTPUT_EXISTS`、以及 JSON/人类可读输出不包含 URI、UUID、公钥或 shortId。`v2rayn` 仍写 `.vless.txt`；`vless-qr` 写 `.vless.png`，单元测试用合成 fixture 解码二维码并与 URI 逐字节比对。Mihomo YAML 的 `reality-opts` 断言包含 `support-x25519mlkem768: true`。provider 只有 `proxies:`；profile 只有一个节点、一个 select 组和一条 `MATCH`，不写 TUN、DNS、`udp` 或 `packet-encoding`。

这些检查不连接 SSH，也不与 FlClash 或 Mihomo 握手。Windows ACL 用例在 `process.platform !== 'win32'` 时直接返回，TAP 仍会计为通过；只在 Linux 上跑完测试，不能写成已经执行 Windows ACL。POSIX 文件 0600、目录 0700 只在实际执行该断言的系统上成立。

兼容性口径与 README 相同：FlClash 0.9.0+ 可以解析 `vless://`，但解析成功不是握手成功；不把当前 26.11.9 安装写成必然拒绝 Mihomo；不把 `minClientVer` 改成 1.8.2，也不削弱 REALITY。

### 2026-11-20 本地复测

Linux、Node.js v22.23.4 上执行 `npm ci --ignore-scripts --no-audit --no-fund` 和 `npm run check`：类型检查通过；单元 16、安全 5、SSH 信任 2、CLI 39 全部通过，0 失败。smoke 与候选文件扫描（45 个文件）通过。没有连接 SSH，没有做 FlClash 或 Mihomo 握手。

同一次 CLI 测试中，Windows ACL 用例因平台不是 win32 立即返回，TAP 仍把它计为通过。这次没有执行 Windows ACL。文件 0600 与目录 0700 的断言在这次 Linux 运行里执行并通过。

## 不能从当前结果推断的事项

- 不代表对所有 Linux 版本或云服务商提供兼容保证。
- 不代表已经验证长期稳定性、全部网络运营商或高负载吞吐。
- 不代表实验性的 Web 管理功能达到可发布质量。
- 本地模拟通过不等于远端实机测试重新执行。

## 测试安全

不得使用真实 SSH 密钥和客户端凭据作为 CI fixtures。使用测试用合成节点、临时路径和 mock transport。远端 `setup`、服务重启和云资源清理必须获得单独授权。

## 本独立候选验证（2026-11-17）

在本候选目录实际运行 npm run check：类型检查通过，核心/导出器10项、安全5项、SSH信任边界2项、接管/安装/endpoint/export回归36项全部通过，无失败或跳过，CLI help及无网络参数拒绝smoke通过。原开发仓库的113项广泛应用测试未复制，避免引入Web/Server耦合，不能混用数量。

受测环境为Windows、Node.js22.19.0、npm10.9.3；测试使用合成凭据，不连接SSH。新增check:candidate使用显式文件白名单与非示例地址/非fixture UUID/凭据模式/路径/相对链接检查；它减少发布快照混入私有文件的风险，不替代人工复核。

### 独立干净安装复测

仅将41个候选文件复制到不含node_modules和私有状态的新目录，实际执行 npm ci --ignore-scripts --no-audit --no-fund 和 npm run check，结果相同：10+5+2+36=53项通过，0失败/跳过；CLI smoke和候选文件扫描通过。主候选目录npm ci、npm run build及Windows vpncp.cmd --help退出0。这里不是Git克隆（尚未允许首次commit），而是只含明确文件集合的干净源码复制验证；未重新连接实机。
