#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AdoptionError, runAdoption, type AdoptionOptions, type AdoptionResult } from '../../../packages/core/src/xray-adoption.ts';
import { InstallLayoutError, resolveStateRoot } from '../../../packages/core/src/install-layout.ts';
import { applyOperatorSshAlias, initOperatorConfig, operatorConfigPath, readOperatorConfig } from '../../../packages/core/src/operator-config.ts';
import { isExportFormat } from '../../../packages/exporters/src/client-connection.ts';
import { runSetup, type SetupOptions } from '../../../packages/core/src/xray-install.ts';
import { createInterface } from 'node:readline/promises';

export const help = `routequay — 通过 OpenSSH 接管现有 Xray

正式命令是 routequay。vpncp 调用同一程序，保留为兼容入口。

  routequay setup <node> [--ssh <Host>] [--plan | --apply] [--port 8443] [--json]
  routequay status <node> [--ssh <Host>] [--json]
  routequay endpoint <node> --host <new-host> [--json]
  routequay export <node> --to v2rayn|vless-qr|mihomo-provider|mihomo-profile|sing-box [--client <ref>] [--out <path>] [--json]
  routequay init-config

默认 SSH Host 与 node 同名；接管后复用已保存的 Host。
若用户配置里的节点写了 sshAlias，且命令没有 --ssh，则用该别名。host、user、port、identityFile 只作校验和记录，identityFile 是密钥路径而不是密钥内容。
init-config 在用户数据目录创建 config.json。文件已存在时拒绝覆盖，退出码 2，并且只打印路径。init 是同一命令。
setup 接管已有实例；干净 Debian 13 / Ubuntu 24.04 LTS 可安装固定 Xray 26.11.9。
自动识别架构、systemd、包管理器及文件权限能力；缺依赖时停止，不自动安装包。
空机交互模式展示计划并确认一次；非交互安装必须指定 --apply。
--plan 严格只读。端口默认 8443，客户端名 client-1，可覆盖以下参数。
--client-name <name> --server-name <SNI> --reality-target <host:port>
--version <受支持版本> --ready-timeout <秒>，默认就绪等待 30 秒。
安装参数仅用于空机，已有实例保留原配置与身份。
REALITY 默认 www.cloudflare.com:443，执行前验证 TLS1.3 与证书，失败则停止。
endpoint 仅显式更新已接管节点的连接地址；使用原地址的可信 SSH 主机密钥，要求配置及运行状态一致。
更新后 export --out <新文件路径>，保留旧导出；不改 SSH 配置和历史安装日志。
export 写入私有文件，不在终端显示 URI、YAML、JSON、UUID、公钥或 shortId。
--to v2rayn 写 VLESS URI（.vless.txt）。--to vless-qr 离线生成同一条 URI 的 PNG 二维码（.vless.png）。
--to mihomo-provider 只写 proxies 列表。--to mihomo-profile 写最小配置：一个节点、一个 select 组、一条 MATCH；不开启 TUN，不改系统 DNS。
mihomo YAML 的 reality-opts 写入 support-x25519mlkem768；已在 Mihomo 1.19.33/1.19.34 对接 Xray 26.11.9 REALITY 的实测中验证为必需，不保证所有客户端组合。
--to sing-box 写官方 sing-box JSON（.sing-box.json）：一个 VLESS 出站、一个 selector、route.final 指向该 selector。不写入站，不开启 TUN，不改 DNS。
sing-box 的 reality 只写官方字段 enabled、public_key、short_id，并启用 utls 指纹 chrome。network 为 tcp。packet_encoding 写空字符串，因为 sing-box 1.14.4 省略该字段时会启用 xudp。
sing-box 没有与 support-x25519mlkem768 对应的官方字段，也不写 curve_preferences。官方稳定版 1.14.4 在 REALITY 客户端代码里去掉 X25519MLKEM768；这不是配置项。未做 sing-box 握手验证。
默认 chrome 指纹。服务器 network 为 raw 时仍导出 tcp。Mihomo 不写 udp 与 packet-encoding。
多客户端时通过 status 返回的 ref 选择。防火墙与 SSH 配置不会自动调整。
--data-dir <path> 只覆盖这一次命令的私有数据目录。开发目录默认仍使用仓库内的 local/private。
已安装副本的私有数据默认在用户主目录的 .routequay，不放在程序目录，更新和卸载也不会删除它。
退出码 0 完成，2 参数或不支持，3 基线/目标冲突，4 连接或本地 I/O 失败。
`;
export function parseArguments(args: string[]): SetupOptions {
  const [command, nodeId, ...flags] = args;
  if (!['setup', 'status', 'export', 'endpoint'].includes(command) || !nodeId || nodeId.startsWith('-')) throw new AdoptionError('USAGE');
  const options: SetupOptions = { command: command as AdoptionOptions['command'], nodeId, to: 'v2rayn' };
  const seen = new Set<string>();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (seen.has(flag)) throw new AdoptionError('DUPLICATE_OPTION');
    seen.add(flag);
    if (flag === '--json') options.json = true;
    else if (flag === '--data-dir') {
      const value = flags[++i];
      if (!value || value.startsWith('-')) throw new AdoptionError('OPTION_VALUE_REQUIRED');
      options.dataDir = value;
    }
    else if (flag === '--plan' && command === 'setup') options.plan = true;
    else if (flag === '--apply' && command === 'setup') options.apply = true;
    else if (flag === '--host' && command === 'endpoint') {
      const value = flags[++i];
      if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9.:_-]*$/.test(value)) throw new AdoptionError('OPTION_VALUE_INVALID');
      options.expectedHost = value;
    }
    else if (['--port', '--client-name', '--server-name', '--reality-target', '--version', '--ready-timeout'].includes(flag)) {
      if (command !== 'setup') throw new AdoptionError('OPTION_NOT_APPLICABLE');
      const value = flags[++i];
      if (!value || value.startsWith('-')) throw new AdoptionError('OPTION_VALUE_REQUIRED');
      if (flag === '--port' || flag === '--ready-timeout') {
        if (!/^\d+$/.test(value)) throw new AdoptionError('OPTION_VALUE_INVALID');
        if (flag === '--port') options.port = Number(value);
        else options.readyTimeout = Number(value);
      }
      if (flag === '--client-name') options.clientName = value;
      if (flag === '--server-name') options.serverName = value;
      if (flag === '--reality-target') options.realityTarget = value;
      if (flag === '--version') options.version = value;
    }
    else if (['--ssh', '--out', '--client', '--to'].includes(flag)) {
      const value = flags[++i];
      if (!value || value.startsWith('-')) throw new AdoptionError('OPTION_VALUE_REQUIRED');
      if (flag !== '--ssh' && command !== 'export') throw new AdoptionError('OPTION_NOT_APPLICABLE');
      if (flag === '--ssh') options.ssh = value;
      if (flag === '--out') options.out = value;
      if (flag === '--client') options.client = value;
      if (flag === '--to') options.to = value;
    } else throw new AdoptionError('UNKNOWN_OPTION');
  }
  if (command === 'endpoint' && !options.expectedHost) throw new AdoptionError('ENDPOINT_CONFIRMATION_REQUIRED', 3);
  if (command === 'export' ? !isExportFormat(options.to) : options.to !== 'v2rayn') throw new AdoptionError('EXPORT_FORMAT_UNSUPPORTED');
  if (options.plan && options.apply) throw new AdoptionError('CONFLICTING_OPTIONS');
  return options;
}
export function renderHumanResult(result: AdoptionResult): string {
  const lines = [
    `${result.nodeId} · ${result.status}`,
    `SSH ${result.ssh} · Xray ${result.version ?? '未知'} · 服务 ${result.service}`,
    `检查时间 ${result.checkedAt}`,
    `客户端 ${(result.clients as string[]).join(', ') || '无'}`
  ];
  if ('plan' in result) lines.push(JSON.stringify(result.plan, null, 2));
  if ('networkStatus' in result) lines.push(`网络验证 ${result.networkStatus}`);
  if (result.outputFile) lines.push(`私有导出 ${result.outputFile}`);
  if (result.format) lines.push(`导出格式 ${result.format}`);
  if (result.code) lines.push(`原因 ${result.code}`);
  lines.push(`未验证 ${(result.unverified as string[]).join(', ')}`);
  return lines.join('\n');
}
export async function main(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args.includes('--help') || args.length === 0) { console.log(help); return 0; }
  try {
    const programRoot = fileURLToPath(new URL('../../../', import.meta.url));
    if (args[0] === 'init-config' || args[0] === 'init') {
      if (args.slice(1).some(arg => arg !== '--json')) throw new AdoptionError('UNKNOWN_OPTION');
      const configPath = initOperatorConfig(programRoot, operatorConfigPath(env));
      console.log(args.includes('--json') ? JSON.stringify({ path: configPath }) : configPath);
      return 0;
    }
    const options = parseArguments(args);
    const config = readOperatorConfig(operatorConfigPath(env));
    const command = applyOperatorSshAlias(options, config);
    const root = resolveStateRoot(programRoot, { dataDir: command.dataDir, configuredDataDir: config?.dataDir, env });
    const result = command.command === 'setup' ? await runSetup(command, root, undefined,
      process.stdin.isTTY && !options.json ? async plan => {
        console.log(`安装 Xray ${plan.version} · 节点 ${plan.nodeId} · TCP ${plan.port} · REALITY ${plan.realityTarget}`);
        console.log('将创建服务账号、配置和 systemd unit，保存恢复记录；防火墙规则需自行核对。');
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try { return /^y(?:es)?$/i.test((await prompt.question('执行此安装计划？[y/N] ')).trim()); }
        finally { prompt.close(); }
      } : undefined) : runAdoption(command, root);
    if (command.json) console.log(JSON.stringify(result));
    else console.log(renderHumanResult(result));
    return result.code ? (['unknown', 'failed-restored', 'rollback-failed', 'installed-local-state-incomplete',
      'completed-cleanup-failed', 'cleanup-failed'].includes(result.status) ? 4 : 2) : 0;
  } catch (error) {
    const failure = error instanceof InstallLayoutError ? new AdoptionError(error.code, 2)
      : error instanceof AdoptionError ? error : new AdoptionError('LOCAL_OR_REMOTE_OPERATION_FAILED', 4);
    if (!args.includes('--json') && failure.code === 'OPERATOR_CONFIG_EXISTS' && failure.details?.reason) {
      console.log(failure.details.reason);
      return failure.exitCode;
    }
    const body = { schemaVersion: 'vpncp-result-v1', operation: args[0], status: 'failed', code: failure.code,
      changed: false, checkedAt: new Date().toISOString(), details: failure.details };
    console.log(args.includes('--json') ? JSON.stringify(body) : `操作失败 ${failure.code}${failure.details?.reason ? '\n' + failure.details.reason : ''}`);
    if (!args.includes('--json') && failure.details?.missingCommands?.length) {
      console.log(`缺少工具 ${failure.details.missingCommands.join(', ')}`);
    }
    return failure.exitCode;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
