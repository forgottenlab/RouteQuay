#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AdoptionError, createOpenSshTransport, runAdoption, runClientGroups, type AdoptionOptions, type AdoptionResult, type AdoptionTransport, type ClientGroupCommand } from '../../../packages/core/src/xray-adoption.ts';
import { isGroupName } from '../../../packages/core/src/client-groups.ts';
import { isLocalLabel } from '../../../packages/core/src/xray-client.ts';
import { InstallLayoutError, resolveStateRoot } from '../../../packages/core/src/install-layout.ts';
import { applyOperatorSshAlias, initOperatorConfig, operatorConfigPath, operatorSshFiles, readOperatorConfig } from '../../../packages/core/src/operator-config.ts';
import { isExportFormat } from '../../../packages/exporters/src/client-connection.ts';
import { createInstallTransport, runSetup, type SetupOptions } from '../../../packages/core/src/xray-install.ts';
import { createInterface } from 'node:readline/promises';

export const help = `routequay — 通过 OpenSSH 接管现有 Xray

正式命令是 routequay。vpncp 调用同一程序，保留为兼容入口。

  routequay setup <node> [--ssh <Host>] [--plan | --apply] [--port 8443] [--json]
  routequay status <node> [--ssh <Host>] [--json]
  routequay endpoint <node> --host <new-host> [--json]
  routequay export <node> --to v2rayn|vless-qr|mihomo-provider|mihomo-profile|sing-box [--client <ref> | --group <name>] [--out <path>] [--json]
  routequay pull <node> [--ssh <Host>] [--client <ref> | --group <name>] [--out <目录>] [--json]
  routequay add-client <node> [--ssh <Host>] [--inbound inbound-N] [--name <email>] [--owner <标签>] [--remark <备注>] [--plan | --apply] [--json]
  routequay group <node> list [--json]
  routequay group <node> create <name> [--json]
  routequay group <node> rename <name> <new-name> [--json]
  routequay group <node> remove <name> [--json]
  routequay group <node> add-member <name> --client <ref> [--json]
  routequay group <node> remove-member <name> --client <ref> [--json]
  routequay init-config

默认 SSH Host 与 node 同名；接管后复用已保存的 Host。
若用户配置里的节点写了 sshAlias，且命令没有 --ssh，则用该别名。
ssh.configPath 会作为 ssh -F 传给 ssh -G 和随后的连接。指定 -F 后，OpenSSH 使用该文件，不再读取系统级 ssh_config。省略 configPath 则不传 -F。
节点 identityFile 只写密钥路径。实际连接追加 ssh -i 和 IdentitiesOnly=yes，从而设置 IdentityFile；ssh -G 不带 -i，也不读取密钥内容。省略 identityFile 则不传 -i。
host、user、port、knownHostsPath、authMethod 仍只作校验和记录。主机、用户和端口以 ssh -G 为准，并由命令行固定。
BatchMode=yes、StrictHostKeyChecking=yes、ForwardAgent=no、ClearAllForwardings=yes 固定在命令行上，配置文件不能改松。
这两个路径必须是已存在的普通文件，不能是符号链接。POSIX 上密钥文件不能对组或其他用户可读。空的或过大的密钥和配置文件也会被拒绝。上述情况都在启动 ssh 之前失败，终端只给出错误码。
init-config 在用户数据目录创建 config.json。文件已存在时拒绝覆盖，退出码 2，并且只打印路径。init 是同一命令。
模板不包含 ssh.configPath 和 identityFile。需要时再写自己机器上已经存在的路径；用不到就不要加。占位路径不会被传给 ssh。
setup 接管已有实例；干净 Debian 13 / Ubuntu 24.04 LTS 可安装固定 Xray 26.11.9。
自动识别架构、systemd、包管理器及文件权限能力；缺依赖时停止，不自动安装包。
空机交互模式展示计划并确认一次；非交互安装必须指定 --apply。
--plan 严格只读。端口默认 8443，客户端名 client-1，可覆盖以下参数。
--client-name <name> --server-name <SNI> --reality-target <host:port>
--version <受支持版本> --ready-timeout <秒>，默认就绪等待 30 秒。
安装参数仅用于空机，已有实例保留原配置与身份。
REALITY 默认 www.cloudflare.com:443，执行前验证 TLS1.3 与证书，失败则停止。
endpoint 仅显式更新已接管节点的连接地址；使用原地址的可信 SSH 主机密钥，要求配置及运行状态一致。
endpoint 不改已有本地文件，也不改 SSH 配置和历史安装日志。
需要新地址的现行文件时再执行 pull。pull 会覆盖节点目录里的同名现行文件。
若要留下旧地址副本，请先把文件复制出去，或使用 export --out 写到其他路径；pull 不改那些路径。
export 写入一种私有文件，不在终端显示 URI、YAML、JSON、UUID、公钥或 shortId。
pull 一次写回五种现行文件：VLESS URI、VLESS 二维码 PNG、Mihomo provider、Mihomo profile、sing-box JSON。终端只打印目录和路径。
成功的空机安装，以及接管已有实例且本地状态发生变化时，会自动做同样的带回。状态未变化时不改这些文件。
pull 的同名现行文件：内容相同则保留并重新收紧权限；内容不同则覆盖。符号链接直接拒绝。
单次 export 在内容不同时仍拒绝并返回 OUTPUT_EXISTS。export 本身不会覆盖已有文件。
多客户端时 pull 与 export 都要用 status 返回的 ref 选择，或用 --group 选择一个本机分组。自动带回也不会猜测客户端；此时请再执行 pull --client <ref>。
add-client 在已经接管的节点上追加一个人或一台设备。同一个入站继续共用端口和 REALITY 参数；新的 UUID 只作为 clients[] 的新条目。已有客户端的 UUID 保持不变，不会顺带轮换私钥、shortId、SNI、端口或 minClientVer。
只有一个受支持的入站时可以省略 --inbound。有多个入站时必须写 status 同一套编号里的 inbound-N。--name 是写入服务器的 email，省略时使用 client-N。--owner 和 --remark 只写在本地元数据里，不上传，也不出现在终端输出。
--plan 只读，不重启服务，也不写文件。非交互执行必须带 --apply；交互执行会确认一次。确认后重启 xray，并在私有目录写下这个新客户端的五种现行文件。终端只打印路径。
追加之后节点上会有多个客户端。之后的 pull 和 export 必须显式带上 --client inbound-N-client-N，或带上 --group。status 仍列出这些 ref，并列出本机分组。
group 只在本机维护分组，文件是私有数据目录下的 local/private/cli-nodes/<node>/groups.local.json。分组名由操作员自己决定，例如 self 或 friend-a。程序不内置家人、同学或朋友这类分类。成员只写 status 使用的 inbound-N-client-N。添加成员时对照本机已接管状态里的 ref，不连接服务器。分组不上传，也不执行流量、到期、启停或远程删除。remove 只删除这条本地分组，不删除远程客户端，也不改 UUID。文件不存在表示还没有分组。文件残缺、字段多余或无法解析时命令失败，代码是 GROUP_STORE_INVALID，并且不改写该文件。终端和 --json 只打印分组名、ref 和文件路径。
status 列出每个分组的名字和成员 ref。export 与 pull 加上 --group <name> 时，为该分组里的每个成员分别写入现行文件，仍然只打印路径。这不会生成分组订阅地址，也不会把多个客户端合成一个公开文件。--group 与 --client 不能同时使用。带 --group 时，export 的 --out 必须是已经存在的目录。
--to v2rayn 写 VLESS URI（.vless.txt）。--to vless-qr 离线生成同一条 URI 的 PNG 二维码（.vless.png）。
--to mihomo-provider 只写 proxies 列表。--to mihomo-profile 写最小配置：一个节点、一个 select 组、一条 MATCH；不开启 TUN，不改系统 DNS。
mihomo YAML 的 reality-opts 写入 support-x25519mlkem768；已在 Mihomo 1.19.33/1.19.34 对接 Xray 26.11.9 REALITY 的实测中验证为必需，不保证所有客户端组合。
--to sing-box 写官方 sing-box JSON（.sing-box.json）：一个 VLESS 出站、一个 selector、route.final 指向该 selector。不写入站，不开启 TUN，不改 DNS。
sing-box 的 reality 只写官方字段 enabled、public_key、short_id，并启用 utls 指纹 chrome。network 为 tcp。packet_encoding 写空字符串，因为 sing-box 1.14.4 省略该字段时会启用 xudp。
sing-box 没有与 support-x25519mlkem768 对应的官方字段，也不写 curve_preferences。官方稳定版 1.14.4 在 REALITY 客户端代码里去掉 X25519MLKEM768；这不是配置项。未做 sing-box 握手验证。
默认 chrome 指纹。服务器 network 为 raw 时仍导出 tcp。Mihomo 不写 udp 与 packet-encoding。
防火墙与 SSH 配置不会自动调整。
这些文件默认写在私有数据目录下的 local/private/cli-nodes/<node>/。
pull 的 --out 必须是已经存在的目录，命令会把它收紧为仅当前用户可访问。
--data-dir <path> 只覆盖这一次命令的私有数据目录。开发目录默认仍使用仓库内的 local/private。
已安装副本的私有数据默认在用户主目录的 .routequay，不放在程序目录，更新和卸载也不会删除它。
退出码 0 完成，2 参数或不支持，3 基线/目标冲突，4 连接或本地 I/O 失败。
`;
export function parseArguments(args: string[]): SetupOptions {
  const [command, nodeId, ...flags] = args;
  if (!['setup', 'status', 'export', 'endpoint', 'pull', 'add-client'].includes(command) || !nodeId || nodeId.startsWith('-')) throw new AdoptionError('USAGE');
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
    else if (flag === '--plan' && (command === 'setup' || command === 'add-client')) options.plan = true;
    else if (flag === '--apply' && (command === 'setup' || command === 'add-client')) options.apply = true;
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
    else if (['--name', '--owner', '--remark', '--inbound'].includes(flag)) {
      if (command !== 'add-client') throw new AdoptionError('OPTION_NOT_APPLICABLE');
      const value = flags[++i];
      if (!value || value.startsWith('-')) throw new AdoptionError('OPTION_VALUE_REQUIRED');
      if (flag === '--name' && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) throw new AdoptionError('OPTION_VALUE_INVALID');
      if (flag === '--inbound' && !/^inbound-[1-9]\d*$/.test(value)) throw new AdoptionError('OPTION_VALUE_INVALID');
      if ((flag === '--owner' || flag === '--remark') && !isLocalLabel(value)) throw new AdoptionError('OPTION_VALUE_INVALID');
      if (flag === '--name') options.name = value;
      if (flag === '--owner') options.ownerLabel = value;
      if (flag === '--remark') options.remark = value;
      if (flag === '--inbound') options.inbound = value;
    }
    else if (['--ssh', '--out', '--client', '--to', '--group'].includes(flag)) {
      const value = flags[++i];
      if (!value || value.startsWith('-')) throw new AdoptionError('OPTION_VALUE_REQUIRED');
      const artifactCommand = command === 'export' || command === 'pull';
      if (flag === '--to' && command !== 'export') throw new AdoptionError('OPTION_NOT_APPLICABLE');
      if ((flag === '--out' || flag === '--client' || flag === '--group') && !artifactCommand) throw new AdoptionError('OPTION_NOT_APPLICABLE');
      if (flag === '--group' && !isGroupName(value)) throw new AdoptionError('OPTION_VALUE_INVALID');
      if (flag === '--ssh') options.ssh = value;
      if (flag === '--out') options.out = value;
      if (flag === '--client') options.client = value;
      if (flag === '--to') options.to = value;
      if (flag === '--group') options.group = value;
    } else throw new AdoptionError('UNKNOWN_OPTION');
  }
  if (command === 'endpoint' && !options.expectedHost) throw new AdoptionError('ENDPOINT_CONFIRMATION_REQUIRED', 3);
  if (command === 'export' ? !isExportFormat(options.to) : options.to !== 'v2rayn') throw new AdoptionError('EXPORT_FORMAT_UNSUPPORTED');
  if (options.plan && options.apply) throw new AdoptionError('CONFLICTING_OPTIONS');
  if (options.client && options.group) throw new AdoptionError('CONFLICTING_OPTIONS');
  return options;
}
const groupActions = ['list', 'create', 'rename', 'remove', 'add-member', 'remove-member'] as const;
export function parseGroupArguments(args: string[]): ClientGroupCommand & { dataDir?: string } {
  const [command, nodeId, action, ...rest] = args;
  if (command !== 'group' || !nodeId || nodeId.startsWith('-') || !groupActions.includes(action as typeof groupActions[number])) throw new AdoptionError('USAGE');
  const parsed: ClientGroupCommand & { dataDir?: string } = { nodeId, action: action as ClientGroupCommand['action'] };
  const positionals: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!flag.startsWith('-')) { positionals.push(flag); continue; }
    if (seen.has(flag)) throw new AdoptionError('DUPLICATE_OPTION');
    seen.add(flag);
    if (flag === '--json') continue;
    if (flag === '--data-dir' || flag === '--client') {
      const value = rest[++i];
      if (!value || value.startsWith('-')) throw new AdoptionError('OPTION_VALUE_REQUIRED');
      if (flag === '--data-dir') parsed.dataDir = value;
      else {
        if (action !== 'add-member' && action !== 'remove-member') throw new AdoptionError('OPTION_NOT_APPLICABLE');
        if (!/^inbound-[1-9]\d*-client-[1-9]\d*$/.test(value)) throw new AdoptionError('OPTION_VALUE_INVALID');
        parsed.client = value;
      }
    } else throw new AdoptionError('UNKNOWN_OPTION');
  }
  const named = action === 'list' ? 0 : action === 'rename' ? 2 : 1;
  if (positionals.length !== named) throw new AdoptionError('USAGE');
  if (named >= 1 && !isGroupName(positionals[0]!)) throw new AdoptionError('OPTION_VALUE_INVALID');
  if (named === 2 && !isGroupName(positionals[1]!)) throw new AdoptionError('OPTION_VALUE_INVALID');
  if (named >= 1) parsed.name = positionals[0];
  if (named === 2) parsed.newName = positionals[1];
  if ((action === 'add-member' || action === 'remove-member') && !parsed.client) throw new AdoptionError('OPTION_VALUE_REQUIRED');
  return parsed;
}
export async function runAddClient(options: SetupOptions, root: string, transport: AdoptionTransport,
  confirm?: (preview: AdoptionResult) => Promise<boolean>): Promise<AdoptionResult> {
  if (options.plan) return runAdoption(options, root, transport);
  if (!options.apply) {
    const preview = runAdoption({ ...options, plan: true }, root, transport);
    if (preview.status !== 'planned') return preview;
    if (!confirm || !await confirm(preview)) throw new AdoptionError('CLIENT_APPROVAL_REQUIRED');
  }
  return runAdoption({ ...options, apply: true, plan: false }, root, transport);
}
export function renderHumanResult(result: AdoptionResult): string {
  const lines = [
    `${result.nodeId} · ${result.status}`,
    `SSH ${result.ssh} · Xray ${result.version ?? '未知'} · 服务 ${result.service}`,
    `检查时间 ${result.checkedAt}`,
    `客户端 ${(result.clients as string[]).join(', ') || '无'}`
  ];
  appendGroupLines(lines, result);
  if ('plan' in result) lines.push(JSON.stringify(result.plan, null, 2));
  if ('networkStatus' in result) lines.push(`网络验证 ${result.networkStatus}`);
  const outputFiles = Array.isArray(result.outputFiles) ? result.outputFiles : [];
  if (outputFiles.length) {
    if (typeof result.outputDirectory === 'string') lines.push(`私有目录 ${result.outputDirectory}`);
    for (const file of outputFiles) {
      if (file && typeof file === 'object' && 'path' in file && typeof file.path === 'string') lines.push(`私有导出 ${file.path}`);
    }
  } else if (result.outputFile) lines.push(`私有导出 ${result.outputFile}`);
  if (typeof result.metadataFile === 'string') lines.push(`本地标注 ${result.metadataFile}`);
  if (typeof result.format === 'string') lines.push(`导出格式 ${result.format}`);
  else if (Array.isArray(result.formats)) lines.push(`带回格式 ${result.formats.join(', ')}`);
  if (result.code) lines.push(`原因 ${result.code}`);
  lines.push(`未验证 ${(result.unverified as string[]).join(', ')}`);
  return lines.join('\n');
}
function groupLabel(group: unknown): string | undefined {
  if (!group || typeof group !== 'object') return undefined;
  const record = group as { name?: unknown; members?: unknown };
  if (typeof record.name !== 'string' || !Array.isArray(record.members)) return undefined;
  const members = record.members.filter((member): member is string => typeof member === 'string');
  return `分组 ${record.name}${members.length ? ' · ' + members.join(', ') : ''}`;
}
function appendGroupLines(lines: string[], result: AdoptionResult): void {
  if (typeof result.group === 'string' && !Array.isArray(result.groups)) {
    const members = Array.isArray(result.members) ? result.members.filter((member): member is string => typeof member === 'string') : [];
    lines.push(`分组 ${result.group}${members.length ? ' · ' + members.join(', ') : ''}`);
  }
  if (!Array.isArray(result.groups)) return;
  if (!result.groups.length) lines.push('分组 无');
  for (const group of result.groups) {
    const line = groupLabel(group);
    if (line) lines.push(line);
  }
}
export function renderGroupResult(result: AdoptionResult): string {
  const lines = [`${result.nodeId} · ${result.status}`, `检查时间 ${result.checkedAt}`];
  if (typeof result.groupFile === 'string') lines.push(`本地分组 ${result.groupFile}`);
  appendGroupLines(lines, result);
  if (result.code) lines.push(`原因 ${result.code}`);
  return lines.join('\n');
}
export async function main(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args.includes('--help') || args.length === 0) { console.log(help); return 0; }
  try {
    const programRoot = fileURLToPath(new URL('../../../', import.meta.url));
    if (args[0] === 'group') {
      const groupCommand = parseGroupArguments(args);
      const config = readOperatorConfig(operatorConfigPath(env));
      const root = resolveStateRoot(programRoot, { dataDir: groupCommand.dataDir, configuredDataDir: config?.dataDir, env });
      const result = runClientGroups(groupCommand, root);
      console.log(args.includes('--json') ? JSON.stringify(result) : renderGroupResult(result));
      return result.code ? (['completed-cleanup-failed', 'cleanup-failed'].includes(String(result.status)) ? 4 : 2) : 0;
    }
    if (args[0] === 'init-config' || args[0] === 'init') {
      if (args.slice(1).some(arg => arg !== '--json')) throw new AdoptionError('UNKNOWN_OPTION');
      const configPath = initOperatorConfig(programRoot, operatorConfigPath(env));
      console.log(args.includes('--json') ? JSON.stringify({ path: configPath }) : configPath);
      return 0;
    }
    const options = parseArguments(args);
    const config = readOperatorConfig(operatorConfigPath(env));
    const command = applyOperatorSshAlias(options, config);
    const sshFiles = operatorSshFiles(config, command.nodeId);
    const root = resolveStateRoot(programRoot, { dataDir: command.dataDir, configuredDataDir: config?.dataDir, env });
    const transport = createOpenSshTransport(sshFiles);
    const confirmAddClient = process.stdin.isTTY && !options.json && !options.plan && !options.apply ? async (preview: AdoptionResult) => {
      const plan = preview.plan && typeof preview.plan === 'object' ? preview.plan as { action?: string; inbound?: string; client?: string } : {};
      if (plan.action === 'finish-client') console.log(`上次追加的客户端 ${plan.client ?? ''} 已在服务器上。确认后只补写本地文件，不再新增 UUID。`);
      else {
        console.log(`将在 ${plan.inbound ?? ''} 追加客户端 ${plan.client ?? ''}。`);
        console.log('已有客户端 UUID、端口和 REALITY 参数保持不变，不修改 minClientVer。');
        console.log('确认后会重启 xray，并把这个客户端的五个文件写到私有目录。终端只打印路径。');
      }
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { return /^y(?:es)?$/i.test((await prompt.question('执行此客户端计划？[y/N] ')).trim()); }
      finally { prompt.close(); }
    } : undefined;
    const result = command.command === 'setup' ? await runSetup(command, root, createInstallTransport(sshFiles),
      process.stdin.isTTY && !options.json ? async plan => {
        console.log(`安装 Xray ${plan.version} · 节点 ${plan.nodeId} · TCP ${plan.port} · REALITY ${plan.realityTarget}`);
        console.log('将创建服务账号、配置和 systemd unit，保存恢复记录；防火墙规则需自行核对。');
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try { return /^y(?:es)?$/i.test((await prompt.question('执行此安装计划？[y/N] ')).trim()); }
        finally { prompt.close(); }
      } : undefined) : command.command === 'add-client' ? await runAddClient(command, root, transport, confirmAddClient)
      : runAdoption(command, root, transport);
    if (command.json) console.log(JSON.stringify(result));
    else console.log(renderHumanResult(result));
    return result.code ? (['unknown', 'failed-restored', 'rollback-failed', 'installed-local-state-incomplete',
      'adopted-local-handoff-failed', 'client-added-local-handoff-failed', 'completed-cleanup-failed', 'cleanup-failed'].includes(result.status) ? 4 : 2) : 0;
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
