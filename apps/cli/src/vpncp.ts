#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AdoptionError, runAdoption, type AdoptionOptions } from '../../../packages/core/src/xray-adoption.ts';
import { runSetup, type SetupOptions } from '../../../packages/core/src/xray-install.ts';
import { createInterface } from 'node:readline/promises';

export const help = `vpncp — 通过 OpenSSH 接管现有 Xray

  vpncp setup <node> [--ssh <Host>] [--plan | --apply] [--port 8443] [--json]
  vpncp status <node> [--ssh <Host>] [--json]
  vpncp endpoint <node> --host <new-host> [--json]
  vpncp export <node> --to v2rayn [--client <ref>] [--out <path>] [--json]

默认 SSH Host 与 node 同名；接管后复用已保存的 Host。
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
export 保存 VLESS URI，默认使用 chrome 指纹；不在终端显示链接。
多客户端时通过 status 返回的 ref 选择。防火墙与 SSH 配置不会自动调整。
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
  if (options.to !== 'v2rayn') throw new AdoptionError('EXPORT_FORMAT_UNSUPPORTED');
  if (options.plan && options.apply) throw new AdoptionError('CONFLICTING_OPTIONS');
  return options;
}
export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.includes('--help') || args.length === 0) { console.log(help); return 0; }
  try {
    const options = parseArguments(args);
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const result = options.command === 'setup' ? await runSetup(options, root, undefined,
      process.stdin.isTTY && !options.json ? async plan => {
        console.log(`安装 Xray ${plan.version} · 节点 ${plan.nodeId} · TCP ${plan.port} · REALITY ${plan.realityTarget}`);
        console.log('将创建服务账号、配置和 systemd unit，保存恢复记录；防火墙规则需自行核对。');
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try { return /^y(?:es)?$/i.test((await prompt.question('执行此安装计划？[y/N] ')).trim()); }
        finally { prompt.close(); }
      } : undefined) : runAdoption(options, root);
    if (options.json) console.log(JSON.stringify(result));
    else {
      console.log(`${result.nodeId} · ${result.status}`);
      console.log(`SSH ${result.ssh} · Xray ${result.version ?? '未知'} · 服务 ${result.service}`);
      console.log(`检查时间 ${result.checkedAt}`);
      console.log(`客户端 ${(result.clients as string[]).join(', ') || '无'}`);
      if ('plan' in result) console.log(JSON.stringify(result.plan, null, 2));
      if ('networkStatus' in result) console.log(`网络验证 ${result.networkStatus}`);
      if (result.outputFile) console.log(`私有导出 ${result.outputFile}`);
      if (result.code) console.log(`原因 ${result.code}`);
      console.log(`未验证 ${(result.unverified as string[]).join(', ')}`);
    }
    return result.code ? (['unknown', 'failed-restored', 'rollback-failed', 'installed-local-state-incomplete',
      'completed-cleanup-failed', 'cleanup-failed'].includes(result.status) ? 4 : 2) : 0;
  } catch (error) {
    const failure = error instanceof AdoptionError ? error : new AdoptionError('LOCAL_OR_REMOTE_OPERATION_FAILED', 4);
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
