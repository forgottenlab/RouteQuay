# 🧭 RouteQuay

> Simple infrastructure. Clear control.
>
> 简化基础设施操作，让连接与管理更加清晰。

[English](README.md) | [简体中文](README.zh-CN.md)

**当前状态：** 独立 Core-first 私有源码候选，**尚未正式发布**。

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
| 显式更新公网地址并保留 SSH 主机身份 | 已实现并测试 |
| SSH 身份保护、事务恢复和本地状态保护 | 已实现，存在明确使用边界 |
| Web 可视化管理及更广泛的网络功能 | 实验阶段，**不属于首发稳定范围** |

**已测试系统：** Ubuntu 24.04 LTS、Debian 13。已归档的实机验证使用 Xray v26.11.9。上述事实**不代表**支持所有 Linux 发行版、云平台、协议或客户端。

项目正式品牌已确定为 **RouteQuay**；当前 CLI 仍沿用开发阶段的 `vpncp` 命令名。首发不以改名为前置条件。

## 📦 安装与环境要求

需要 Node.js 22.19.0 或更新版本及 npm。Node 直接运行 TypeScript；`build` 执行类型检查，不生成 bundle。在本仓库目录执行：

```powershell
npm ci
npm run build
npm run check
.\vpncp.cmd --help
```

当前已验证的 Windows 管理端流程依赖可用的 OpenSSH 客户端、配置好的 SSH Host 别名、密钥认证及可信主机密钥记录；远端 Linux 还需通过工具的环境与权限检查。

已验证的管理端为 Windows / PowerShell / OpenSSH。远端首装实机范围是 Debian 13、Ubuntu 24.04 的 x86_64；aarch64 仅有本地选型测试。远端需要 systemd、root 或非交互 sudo、Python 3、curl、OpenSSL 及安装器检查的既有工具；缺失时停止，不自动安装软件包。

## 🖥️ 命令示例

以下示例在项目目录的 PowerShell 中执行。`example-node` 是使用者自行配置的 SSH 主机别名，不是预设服务器。

```powershell
# 只读查看准备执行的部署操作。
.\vpncp.cmd setup example-node --plan

# 查看已配置节点的状态。
.\vpncp.cmd status example-node

# 导出到受保护的本地文件，不要公开完整 VLESS URI。
.\vpncp.cmd export example-node --to v2rayn
```

空机计划审核后使用 `vpncp setup example-node --apply` 显式确认安装；已有 Xray 实例可能进入接管流程。在应用任何更改前，应先确认计划、备份和恢复方式。

当同一台服务器的公网地址合法变化时，可显式授权更新：

```powershell
# 203.0.113.10 为文档示例保留地址，不能作为真实服务器使用。
.\vpncp.cmd endpoint example-node --host 203.0.113.10
```

这不是信任陌生服务器的操作。必须继续通过严格 SSH 主机密钥验证。

## 🧪 测试

本独立候选目录提供的测试命令包括：

```powershell
npm run typecheck
npm run test:unit
npm run test:safety
```

`npm run check` 汇总文件白名单、路径与敏感模式检查及本候选选取的核心、导出器、SSH、CLI 及 smoke 检查，不等于原完整应用测试集。Ubuntu 24.04 / Debian 13 的公网 HTTPS 实机验收另有记录；本地 mock 测试通过不等于新环境一定部署成功。

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

公开后可以通过 GitHub Issue 反馈问题、需求或维护任务。ForgottenLab 的账户级 `.github` 仓库已经提供默认 Issue 表单与 PR 模板，项目没有自定义覆盖时会直接复用。英文或简体中文均可，无须重复写两份。

## 📜 许可证

RouteQuay 采用 [MIT License](LICENSE)，Copyright (c) 2026 ForgottenLab。本仓库仍为私有发布候选；许可证落地不等于授权公开。Xray 本体是采用独立 MPL-2.0 许可证的软件，不受本项目 MIT 许可替代。详见[许可证审阅](docs/LICENSE-REVIEW.md)。
