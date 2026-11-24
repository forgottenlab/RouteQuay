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

已安装副本的私有状态默认在 `%USERPROFILE%\.routequay\`，不放在程序目录里。开发目录仍使用 `local\private\cli-nodes`，除非该次命令传入 `--data-dir` 或设置了 `ROUTEQUAY_DATA_DIR`。不会自动迁移已有的仓库本地数据。

`routequay pull`，以及成功的安装或状态有变化的接管，会把客户端文件写到该数据目录下的 `local\private\cli-nodes\<node>\`。终端只打印路径。这些文件留在操作员自己的机器上，不写到服务器，也没有订阅地址。

依赖安装失败时，输出是一行 JSON：`code` 为 `NPM_CI_FAILED`，`reason` 是 spawn 错误或 npm 的简短输出，并会去掉密钥、URI 和私钥块。此时不写入安装标记，也不修改 PATH。程序目录里可能已经有复制出来的文件；再次安装前需要清空该目录，否则会得到 `DEST_NOT_EMPTY`。

## 操作员配置

`routequay init-config` 在文件不存在时，把 `examples/operator-config.example.json` 复制到 `%USERPROFILE%\.routequay\config.json`，并且只打印路径。`init` 是同一命令。已有文件不会被覆盖：命令以退出码 2 结束，标准输出仍然只有该路径。加上 `--json` 时，失败对象的 `code` 是 `OPERATOR_CONFIG_EXISTS`，并带上同一路径，不打印文件内容。数据目录和文件只允许当前用户访问。

模板没有口令字段。`sshAlias` 选择 `%USERPROFILE%\.ssh\config` 里已经存在的 OpenSSH 主机。`host`、`user`、`port` 和 `identityFile` 是可选项；`identityFile` 只保存密钥路径，不保存密钥内容。命令仍用 `ssh -G` 解析别名，并保持 `BatchMode=yes` 和 `StrictHostKeyChecking=yes`。`vpn.example.invalid` 和 `example-user` 只是占位符。

## 使用命令

修改 PATH 后请打开新的终端：

```powershell
routequay --help
routequay setup example-node --plan
routequay status example-node
```

`vpncp` 是同一程序的兼容命令。不会安装 `rq`。未使用安装器时，仍可在仓库目录运行 `.\routequay.cmd` 或 `.\vpncp.cmd`。

## 更新与卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Action update -Yes
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Action uninstall -Yes
```

更新只替换程序文件。卸载会删除这些文件、程序目录中的 `node_modules`，以及该目录对应的当前用户 PATH 项。两者都不会删除 `%USERPROFILE%\.routequay\`，也不会删除仓库里的 `local\`。

## 打包运行包

在仓库目录执行：

```powershell
npm run pack:runtime
```

压缩包写到 `dist/routequay-runtime-win.zip`。打包不会发布 tag，也不会创建 GitHub Release。
