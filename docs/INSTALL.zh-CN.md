# Windows 安装

[English](INSTALL.md) | [简体中文 README](../README.zh-CN.md)

尚未发布 GitHub Release。可以从当前仓库安装一份供当前用户使用的精简运行包。安装器不会安装 Node.js，不会修改系统级 PATH，也不会删除私有节点状态。

## 环境

- 带 PowerShell 的 Windows
- 已经安装的 Node.js 和 npm
- Node.js 版本以 `package.json` 的 `engines.node` 为准（当前为 `>=22.19.0`）

OpenSSH、已配置的 SSH 主机别名和已知主机密钥，与在仓库目录中运行时相同。

## 安装

在本仓库或解压后的运行包目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Yes -ConfirmPath
```

`-Yes` 确认复制程序文件。`-ConfirmPath` 确认把程序目录加入**当前用户** PATH。不带 `-ConfirmPath` 时，脚本会先询问。非交互运行如果没有 `-ConfirmPath`，则不修改 PATH。默认程序目录是 `%LOCALAPPDATA%\Programs\RouteQuay`。可以用 `-InstallDir` 指定其他目录。

程序目录里有安装标记 `routequay-install.json` 时，这是已安装副本。它的数据根默认是 `%USERPROFILE%\.routequay\`，不放在程序目录里。`--data-dir` 只覆盖这一次命令，`ROUTEQUAY_DATA_DIR` 次之。用户配置里的 `dataDir` 只对这种已安装副本生效，模板值是 `~/.routequay`。

没有安装标记的检出目录使用仓库根作为数据根，节点状态在仓库的 `local\private`。两处数据根各自保留，没有自动迁移。在检出目录里创建的节点状态，已安装的 `routequay` 看不到。要使用那些状态，在安装数据根里安装或接管该节点，或让 `--data-dir` 指向检出目录。`--data-dir` 是包含 `local\private` 的数据根，不是 `local\private` 本身。没有安装标记时，`config.json` 里的 `dataDir` 不会把检出目录的数据根改到用户主目录。

`config.json` 里的 `nodes` 只记录 SSH 别名等操作员配置，不能代替 `local\private\cli-nodes\<node>\` 下的节点状态。更新之后，`%USERPROFILE%\.routequay\` 里可能仍然只有 `config.json`，没有节点状态。这时 `routequay pull <node>` 在 SSH 之前失败，代码是 `SETUP_REQUIRED`（退出码 2）。这是预期结果。

`routequay pull`，以及成功的首次安装或本地状态有变化的接管，会把五种现行文件写到该数据根下的 `local\private\cli-nodes\<node>\`：`<ref>.vless.txt`、`<ref>.vless.png`、`<ref>.mihomo-provider.yaml`、`<ref>.mihomo-profile.yaml`、`<ref>.sing-box.json`。多于一个客户端时加上 `--client <ref>`。`--out` 必须是已经存在的目录。默认的人类可读输出和 `--json` 只打印目录与路径，不打印 URI、UUID、密钥或 shortId。多个客户端时自动带回不会猜测客户端，并返回 `CLIENT_SELECTION_REQUIRED`。本地状态没有变化的接管不重写这些文件。这些文件留在操作员自己的机器上，不写到服务器，也没有订阅地址。

数据根里已经有该节点的本地状态时，`pull` 仍先通过 SSH 探测服务器，然后再写文件。SSH 无法连接时，正式错误是 `SSH_UNAVAILABLE`（退出码 4）。五个现行文件不会被写入或修改。这种连不上的结果使用 `SSH_UNAVAILABLE`；`SSH_AUTH_FAILED` 是另一条错误。同名现行文件逐字节相同则保留并重新收紧权限，字节不同则覆盖。符号链接直接拒绝。权限收紧失败时命令失败并停止。单次 `export --to` 在内容不同时仍返回 `OUTPUT_EXISTS`。`export --out` 复制出去的文件，之后的 `pull` 不会修改。`endpoint` 不刷新已有现行文件；地址变更后再执行 `pull`。

依赖安装失败时，输出是一行 JSON：`code` 为 `NPM_CI_FAILED`，`reason` 是 spawn 错误或 npm 的简短输出，并会去掉密钥、URI 和私钥块。此时不写入安装标记，也不修改 PATH。程序目录里可能已经有复制出来的文件；再次安装前需要清空该目录，否则会得到 `DEST_NOT_EMPTY`。

## 操作员配置

`routequay init-config` 在文件不存在时，把 `examples/operator-config.example.json` 复制到 `%USERPROFILE%\.routequay\config.json`，并且只打印路径。`init` 是同一命令。已有文件不会被覆盖：命令以退出码 2 结束，标准输出仍然只有该路径。加上 `--json` 时，失败对象的 `code` 是 `OPERATOR_CONFIG_EXISTS`，并带上同一路径，不打印文件内容。数据目录和文件只允许当前用户访问。

模板没有口令字段。`sshAlias` 选择 OpenSSH 主机别名。命令没有 `--ssh` 时使用该别名。`host`、`user`、`port`、`knownHostsPath` 和 `authMethod` 仍只作校验和记录，不会变成另一条连接。主机、用户和端口仍来自 `ssh -G`，再由命令行固定。`BatchMode=yes`、`StrictHostKeyChecking=yes`、`ForwardAgent=no` 和 `ClearAllForwardings=yes` 写在命令行上，SSH 配置文件不能把它们改松。`vpn.example.invalid` 和 `example-user` 只是占位符。

`ssh.configPath` 是要传给 OpenSSH 的配置文件路径。写了这一项时，`ssh -G` 和随后的实际连接都会带上 `ssh -F` 指向该文件。OpenSSH 因此使用这个文件，并且不再读取系统级 `ssh_config`。删掉 `configPath` 则不传 `-F`，仍由 OpenSSH 查找默认配置。`identityFile` 只保存私钥路径，不保存私钥内容。写了这一项时，实际连接追加 `ssh -i` 和 `IdentitiesOnly=yes`，用来设置 IdentityFile，并且不使用 ssh-agent 里的其他密钥。`ssh -G` 不带 `-i`，也不会读取私钥内容。删掉 `identityFile` 则不传 `-i`，密钥仍由 SSH 配置或 ssh-agent 提供。

这两个路径都可以用 `~` 开头。RouteQuay 先展开成绝对路径，再传给 ssh。路径必须是已经存在的普通文件，不能是符号链接。POSIX 上私钥文件不能对组或其他用户可读。空的私钥、超过 32 KiB 的私钥，以及超过 256 KiB 的配置文件，也会被拒绝。不满足时，命令在启动 ssh 之前失败，终端只给出错误码，不打印私钥、口令或文件内容。模板里的 `~/.ssh/config` 和 `~/.ssh/id_ed25519_example` 是占位符。请改成自己的配置文件和密钥路径，或者删掉用不到的字段。RouteQuay 不生成密钥，也不写 SSH 配置。需要口令提示的加密私钥会因为 `BatchMode=yes` 无法交互而失败；请先把这把密钥载入 ssh-agent，并省略 `identityFile`。

## 使用命令

修改 PATH 后请打开新的终端：

```powershell
routequay --help
routequay setup example-node --plan
routequay status example-node
routequay pull example-node
```

`example-node` 是操作员自己的 SSH 主机别名。用户数据根里还没有该节点的本地状态时，`pull` 在 SSH 之前返回 `SETUP_REQUIRED`。`vpncp` 是同一程序的兼容命令。不会安装 `rq`。未使用安装器时，仍可在仓库目录运行 `.\routequay.cmd` 或 `.\vpncp.cmd`。

## 更新与卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Action update -Yes
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Action uninstall -Yes
```

已有 Windows 安装的正式更新，在检出目录执行上面的第一条命令。它替换现有目标目录中的程序文件，不删除 `%USERPROFILE%\.routequay\` 里的用户配置，也不迁移检出目录里的节点状态。这条命令不带 `-ConfirmPath`。交互运行会先询问是否把程序目录加入当前用户 PATH；非交互运行不修改 PATH，安装器输出的 `pathUpdated` 为 `false`。当前用户 PATH 已经包含程序目录时，只要这次没有确认 PATH，更新也不改写 PATH。传入 `-ConfirmPath` 会写入当前用户 PATH，那时 `pathUpdated` 为 `true`。系统级 PATH 仍然不改。省略 `-InstallDir` 时，目标仍是默认程序目录 `%LOCALAPPDATA%\Programs\RouteQuay`；安装时如果用了其他目录，更新时传入同一个 `-InstallDir`。

卸载会删除程序文件、程序目录中的 `node_modules`，以及该目录对应的当前用户 PATH 项。更新和卸载都不会删除 `%USERPROFILE%\.routequay\`，也不会删除仓库里的 `local\`。

## 打包运行包

在仓库目录执行：

```powershell
npm run pack:runtime
```

压缩包写到 `dist/routequay-runtime-win.zip`。打包不会发布 tag，也不会创建 GitHub Release。
