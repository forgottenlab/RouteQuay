# RouteQuay

面向用户的说明使用简体中文；代码标识符保持原样。

- 首发稳定范围是 vpncp Xray CLI。Web、Server 和其他网络能力属于实验/未来方向。
- 先核对 Git 与本地状态，保护已有改动；修改已有文件前复制到 backups/<timestamp>/，保留相对路径。
- 默认只运行 mock/fixture 本地检查。真实 SSH、安装、服务操作和云操作需要最新任务明确授权；维护本项目不自动授权管理任何节点。
- 保留严格 SSH 主机密钥验证、journal 拒绝保护及 operation.guard 协议；不得混用忽略 guard 的旧写者或自动抢占孤立锁。
- 不输出或提交真实凭据、完整客户端链接、节点私有状态或内部 .ai 记录。
- 不自动暂存、提交、推送、打标签、发布或改变仓库可见性。项目采用 MIT；Xray 及第三方依赖保留各自许可证。
- 开发及验证见 [开发说明](docs/DEVELOPMENT.md)、[测试说明](docs/TESTING.zh-CN.md)；工程约定遵循 [ForgottenLab 工程手册](https://github.com/forgottenlab/.github/blob/main/docs/standards/README.zh-CN.md)。不重复全局个人规则。
