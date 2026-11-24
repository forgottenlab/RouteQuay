# 🗺️ RouteQuay 路线图与范围说明

[English README](../README.md) | [简体中文 README](../README.zh-CN.md)

RouteQuay 的目标是减少个人服务器连接与管理中的不必要步骤，而不是追求与成熟网络管理面板一样多的功能。

| 阶段 | 方向 | 当前判断 |
|---|---|---|
| Path A：Core-first CLI | Xray CLI 部署、接管、状态检查；为已接管节点按人/设备追加独立 UUID，并把该客户端的文件写回本机；本机分组由操作员自己起名，成员是 `inbound-N-client-N`；VLESS/REALITY 导出为 v2rayN URI、Mihomo YAML 或 sing-box JSON 文件 | 这条路径不需要助手。部署与 v2rayN URI 有实机证据。2026-11-21 在 Ubuntu 24.04 与 Debian 13、Xray 26.11.9 上有 Mihomo 1.19.33 与 FlClash 0.9.4 的有限记录。2026-11-23 复测：FlClash 0.9.4 以文件导入直接导入官方 `mihomo-profile`，两台验收节点延迟测试成功；Shadowrocket 只完成导入（与 v2rayN 粘贴相同的剪贴板 `vless://` URI，以及离线二维码）。sing-box 1.14.4 的官方导出 JSON 通过 `check`，对 Xray 26.11.9 的 REALITY 握手失败（`reality verification failed`），因为官方 1.14.4 从 ClientHello 去掉 `X25519MLKEM768`；同一路径上 Mihomo 1.19.33 使用官方字段时成功。不把削弱 REALITY、修改 `minClientVer` 或非官方字段写成解决办法。边界见测试说明，不覆盖全部版本。独立候选本地验证通过，待维护者发布审阅 |
| Path B：本机助手技能 | 可选技能在仓库 `.agents/skills/routequay/`。操作员在自己的机器上，用会读取该目录的本地助手打开本仓库，或把该目录复制到本机用户技能目录。助手只调用已经存在的 `routequay` 命令，只汇报路径、节点 id、`inbound-N-client-N`、分组名和状态或错误码 | 当前这一步。CLI 不读取该技能。未加载时 Path A 照常使用。技能留在操作员机器上，不安装到 Xray 主机 |
| 首次公开 | 安全隔离、双语 README、可复制安装步骤、许可证及必要测试 | 准备中 |
| 后续维护 | 实际问题反馈、兼容性修复、可维护的文档 | 按需进行 |
| 仍在后面 | 主机防火墙与安全组、GitHub Release | Path B 不做这些。防火墙和安全组要等 CLI 自己有命令。Release 仍未发布 |
| 实验性工作 | 已探索的 Web 管理界面、节点/用户/部署相关页面 | 不属于首发稳定范围 |
| 可能研究 | 更多连接技术、内外网接入、线路性能对照 | 未承诺实施或支持时间 |

Path B 是当前这一步，而且只是本机技能。Xray 主机上不安装技能、助手或额外守护进程。主机防火墙与安全组、GitHub Release 仍留在后面。

项目品牌刻意不绑定单一 VPN 协议，但**未来方向不能冒充已完成能力**。是否继续扩展由实际问题、维护成本和测试能力决定。公开快照应包含真正需要的 Core 依赖，而不是为了精简表面文件数量而删除必需模块。
