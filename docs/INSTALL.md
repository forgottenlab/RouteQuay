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

Private state for an installed copy defaults to `%USERPROFILE%\.routequay\`. It is not stored under the program directory. A development checkout keeps using `local\private\cli-nodes` unless that command is given `--data-dir` or `ROUTEQUAY_DATA_DIR`. Existing checkout data is not migrated.

`routequay pull`, a successful install, and an adoption whose saved state changed write the client files to `local\private\cli-nodes\<node>\` under that data directory. The terminal prints paths only. The files stay on the operator machine. Nothing is written to the server for this, and there is no subscription URL.

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
```

`vpncp` is the compatibility command for the same program. `rq` is not installed. Running `.\routequay.cmd` or `.\vpncp.cmd` from a checkout still works when the installer has not been used.

## Update and uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Action update -Yes
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Action uninstall -Yes
```

Update replaces program files. Uninstall removes those files, the program directory's `node_modules`, and the current-user PATH entry created for that directory. Neither action deletes `%USERPROFILE%\.routequay\` or a checkout `local\` directory.

## Pack a runtime zip

From the checkout:

```powershell
npm run pack:runtime
```

The zip is written to `dist/routequay-runtime-win.zip`. Building the zip does not publish a tag or a GitHub Release.
