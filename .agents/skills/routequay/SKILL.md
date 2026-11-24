---
name: routequay
description: >-
  用本机的 routequay 命令查看节点、把官方客户端文件带回本地路径、追加一个人或一台设备、导出一种文件，或整理本机分组。
  Use when the operator asks to check a node, bring official client files back as local paths, append one person or device, export one file, or organize local groups.
  Drive only the existing CLI. Do not print secret material, and do not install anything on the remote host.
---

# RouteQuay 本机 CLI

Path A 是产品。不加载本技能时，`routequay` 仍然完整可用。本技能可选，只在操作员自己的机器上生效。助手只运行官方 CLI，不建立第二套控制面。

先运行 `routequay --help`。帮助里没有的命令不要发明。不要直接调用 `ssh`，不要手改远端配置。

检出目录用 `node apps/cli/src/vpncp.ts`。`routequay.cmd` 和 `routequay.ps1` 调用同一程序。已经安装并位于 PATH 时直接运行 `routequay`。`vpncp` 是兼容入口。

## 何时使用

操作员用自己的话提出这些事时使用：

- 查看一台节点
- 把官方客户端文件带回本机，只要路径
- 追加一个人或一台设备
- 整理本机分组
- 导出一种现行文件，或执行帮助里已经列出的其他命令

## 只汇报这些

- 路径
- 节点 id
- 稳定引用 `inbound-N-client-N`
- 分组名
- 状态、错误码、退出码

退出码：0 完成，2 参数或不支持，3 基线或目标冲突，4 连接或本地读写失败。

需要解析结果时加上 `--json`，并且只摘出上面这些字段。不要把整份 JSON 贴进对话。监听地址、权限、服务账号、远程配置路径和其他字段都不要复述。

## 绝不

- 绝不在对话、示例、日志、Issue 或 PR 文本里粘贴、打印、引用，或要求回显 UUID、私钥、密码或 vless:// 文本。CLI 只是提到这些种类时，只转述错误码和路径。
- 绝不在远端 Xray 主机上安装、复制或运行技能、助手或额外守护进程。控制面留在操作员机器上。Xray 留在服务器上。
- 绝不发明托管订阅 URL、第二套配置 API 或远程管理器。
- 不读取、不引用活动的 `config.json`，也不读取私有数据文件。使用 CLI。这包括用户数据目录里的 `config.json`，以及 `local/private/cli-nodes/<node>/` 下的 `state.local.json`、`clients.local.json`、`groups.local.json` 和现行导出文件。不要打开 CLI 打印出的文件。
- 会改状态的动作必须走 CLI 自己的确认、`--plan` 和 `--apply`。不要绕过，也不要另做一条静默应用路径。不要把确认词管道进提示。不要同时传入 `--plan` 和 `--apply`。
- 不削弱 REALITY，不修改 `minClientVer`，不轮换私钥、shortId、服务器名或端口。

不要把密钥路径或 SSH 配置文件路径传给 `ssh`。`--ssh` 只接受操作员已经配好的 Host 别名。用不到的路径不要加，也不要写占位路径。

`setup` 和 `add-client` 在非交互，或带了 `--json` 时，没有 `--apply` 不会自己执行。返回 `INSTALL_APPROVAL_REQUIRED` 或 `CLIENT_APPROVAL_REQUIRED` 就停下来汇报代码。不要改用管道，不要手改配置，不要发明另一个开关。操作员没有明确要求执行时，只用 `--plan`。交互终端不带这两个参数时，由 CLI 自己询问一次，不要替操作员回答。

分组命令没有 `--plan` 和 `--apply`。不要给它们加上这两个参数。只有操作员点名要创建、改名、删除或调整成员时才运行对应子命令。`remove` 只删除这条本地分组，不删除远程客户端。

`endpoint` 没有单独的 `--apply`。只有操作员给出新地址时才运行。不要自己编一个地址，也不要改用文档里的保留地址。

## 命令

`example-node` 是操作员自己的 SSH 主机别名，不是预设服务器。省略 `--out` 时，文件写到当前私有数据目录；CLI 会打印路径。操作员没有指定目录时，不要另选一个目录。带 `--out` 时，那个目录必须已经存在。

```text
allowed-commands: setup status endpoint export pull add-client group init-config
routequay status example-node
routequay pull example-node --client inbound-1-client-1
routequay pull example-node --group self
routequay export example-node --to v2rayn --client inbound-1-client-1
routequay export example-node --to vless-qr --client inbound-1-client-1
routequay export example-node --to mihomo-provider --group self
routequay export example-node --to mihomo-profile --group self
routequay export example-node --to sing-box --client inbound-1-client-1
routequay add-client example-node --plan
routequay add-client example-node --apply
routequay group example-node list
routequay group example-node create self
routequay group example-node rename self friend-a
routequay group example-node add-member self --client inbound-1-client-1
routequay group example-node remove-member self --client inbound-1-client-1
routequay group example-node remove self
routequay setup example-node --plan
routequay setup example-node --apply
routequay init-config
```

`endpoint` 的形状是 `routequay endpoint <node> --host`，后面只接操作员这次给出的地址。不要把示例词当成主机名，也不要使用文档里的保留地址。

`pull` 写五种现行文件，只打印目录和路径。`export` 只写一种。`--to` 只能是 `v2rayn`、`vless-qr`、`mihomo-provider`、`mihomo-profile`、`sing-box`。多于一个客户端时必须带 `--client` 或 `--group`，不要猜测。两者不能同时使用。带 `--group` 时，`export` 的 `--out` 必须是已经存在的目录。内容不同时 `export` 返回 `OUTPUT_EXISTS`，不要删掉已有文件再重试。多个客户端却没选择时，带回失败的代码是 `CLIENT_SELECTION_REQUIRED`，再按操作员给出的 ref 或分组名执行。

`add-client` 在已经接管的节点上追加一个人或一台设备。只有一个受支持的入站时可以省略 `--inbound`。多个入站时使用 `inbound-N`。`--name` 是服务器上的 email。`--owner` 和 `--remark` 只留在本机，CLI 不打印它们，不要从磁盘读回来。

`group` 不连接服务器。分组名由操作员决定。文件残缺时代码是 `GROUP_STORE_INVALID`，不要手改那个文件。

`setup --plan` 只读。已有实例走接管，不为了重装而替换配置。CLI 不调整防火墙或 SSH 配置。若结果里出现 `CHECK_FIREWALL_AND_CLOUD_RULES`，只汇报这个代码，不要自己改规则。

`init-config` 只打印路径。文件已存在时退出码 2，输出仍然只有路径。不要打开该文件。

## 还没有的命令

主机防火墙、安全组，以及一套固定的安全默认，都还不是 CLI 命令。不要执行它们，也不要假装命令已经存在。等 CLI 自己提供之后，再只通过那些命令操作。

不要从本技能创建 GitHub Release、关闭 Issue、新增 CI，或做 Web 管理界面。不要另做一套连通性测试。操作员要求的那一条 CLI 命令就是全部动作。
