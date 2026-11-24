# Windows install

[简体中文](INSTALL.zh-CN.md) | [English README](../README.md)

GitHub Releases are not published yet. This checkout can install a slim runtime for the current user. The installer does not install Node.js, does not change the machine PATH, and does not delete private node state.

## Requirements

- Windows with PowerShell
- Node.js and npm already installed
- The required Node.js version is `engines.node` in `package.json` (currently `>=22.19.0`)

OpenSSH, a configured SSH host alias, and known host keys are the same prerequisites as a checkout run.

## Install

From this checkout, or from an unpacked runtime zip:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Yes -ConfirmPath
```

`-Yes` confirms copying program files. `-ConfirmPath` confirms adding the program directory to the **current-user** PATH. Without `-ConfirmPath`, the script asks before it changes PATH. A non-interactive run that omits `-ConfirmPath` leaves PATH unchanged. The default program directory is `%LOCALAPPDATA%\Programs\RouteQuay`. Pass `-InstallDir` to choose another directory.

A program directory that contains the install marker `routequay-install.json` is a marked install. Its data root defaults to `%USERPROFILE%\.routequay\` and is not stored under the program directory. `--data-dir` overrides that root for one command, and `ROUTEQUAY_DATA_DIR` is next. `dataDir` in the operator config applies only to that marked install; the template value is `~/.routequay`.

An unmarked checkout uses the repository root as its data root, so node state stays in the repository's `local\private`. The two roots stay separate. Nothing is migrated from one to the other. Node state created in the checkout is not visible to the installed `routequay`. To use that state, install or adopt the node in the install data root, or point `--data-dir` at the checkout. `--data-dir` is the data root that contains `local\private`, not the `local\private` directory itself. On an unmarked checkout, `dataDir` in `config.json` does not move the data root to the user profile.

The `nodes` list in `config.json` records operator settings such as the SSH alias. It does not replace node state under `local\private\cli-nodes\<node>\`. After an update, `%USERPROFILE%\.routequay\` may still contain only `config.json` and no node state. `routequay pull <node>` then fails with `SETUP_REQUIRED` (exit 2) before SSH. That result is expected.

`routequay pull`, a successful first install, and an adoption whose local state changed write five canonical files to `local\private\cli-nodes\<node>\` under that data root: `<ref>.vless.txt`, `<ref>.vless.png`, `<ref>.mihomo-provider.yaml`, `<ref>.mihomo-profile.yaml`, and `<ref>.sing-box.json`. When more than one client exists, pass `--client <ref>`. `--out` must be an already-existing directory. Default human output and `--json` print the directory and paths only. They do not print the URI, UUID, keys, or shortId. Automatic bring-back does not choose among several clients and returns `CLIENT_SELECTION_REQUIRED`. An unchanged adoption does not rewrite these files. The files stay on the operator machine. Nothing is written to the server for this, and there is no subscription URL.

When that node's local state already exists in the data root, `pull` still probes the server over SSH before it writes files. If SSH cannot connect, the official error is `SSH_UNAVAILABLE` (exit 4). The five canonical files are not written or changed. A failure to connect uses `SSH_UNAVAILABLE`. `SSH_AUTH_FAILED` is a different error. Canonical files with the same bytes are kept and their permissions are tightened again; different bytes are overwritten. Symbolic links are refused. If permission tightening fails, the command fails closed. A single-format `export --to` still returns `OUTPUT_EXISTS` when the bytes differ. Copies made with `export --out` are not modified by a later `pull`. `endpoint` does not refresh existing artifact files; run `pull` again after a new address.

If dependency installation fails, the command prints one JSON object. `code` is `NPM_CI_FAILED` and `reason` is the spawn error or a short npm transcript, with secrets, import URIs, and private-key blocks removed. The install marker is not written and PATH is not changed. Program files may already have been copied; clear that directory before installing again, or the next run reports `DEST_NOT_EMPTY`.

## Operator config

`routequay init-config` copies `examples/operator-config.example.json` to `%USERPROFILE%\.routequay\config.json` when that file is missing, and prints that path only. `init` is the same command. An existing file is left unchanged: the command exits 2 and still prints only that path. With `--json`, the failure object uses code `OPERATOR_CONFIG_EXISTS` and includes that same path; it does not print the file. The data directory and file are private to the current user.

The template has no password field. `sshAlias` selects an existing OpenSSH host from `%USERPROFILE%\.ssh\config`. `host`, `user`, `port`, and `identityFile` are optional; `identityFile` is a path, not key material. Commands still resolve the alias with `ssh -G` and keep `BatchMode=yes` and `StrictHostKeyChecking=yes`. Example values such as `vpn.example.invalid` and `example-user` are placeholders.

## Use the command

Open a new terminal after PATH is changed:

```powershell
routequay --help
routequay setup example-node --plan
routequay status example-node
routequay pull example-node
```

`example-node` is an SSH host alias configured by the operator. When the user data root has no local state for that node, `pull` returns `SETUP_REQUIRED` before SSH. `vpncp` is the compatibility command for the same program. `rq` is not installed. Running `.\routequay.cmd` or `.\vpncp.cmd` from a checkout still works when the installer has not been used.

## Update and uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Action update -Yes
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Action uninstall -Yes
```

The official update of an existing Windows install is the first command above, run from the checkout. It replaces program files in the existing destination. It does not delete user configuration in `%USERPROFILE%\.routequay\`, and it does not migrate node state out of the checkout. That command does not pass `-ConfirmPath`. An interactive run still asks before it changes the current-user PATH. A non-interactive run leaves PATH unchanged and the installer reports `pathUpdated` as `false`. When the current-user PATH already contains the program directory, an update that does not confirm PATH leaves PATH unchanged. Passing `-ConfirmPath` writes the current-user PATH, and then `pathUpdated` is `true`. The machine PATH stays unchanged. When `-InstallDir` is omitted, the destination remains the default program directory `%LOCALAPPDATA%\Programs\RouteQuay`. An install that used another directory needs that same `-InstallDir` on update.

Uninstall removes the program files, the program directory's `node_modules`, and the current-user PATH entry created for that directory. Neither update nor uninstall deletes `%USERPROFILE%\.routequay\` or a checkout `local\` directory.

## Pack a runtime zip

From the checkout:

```powershell
npm run pack:runtime
```

The zip is written to `dist/routequay-runtime-win.zip`. Building the zip does not publish a tag or a GitHub Release.
