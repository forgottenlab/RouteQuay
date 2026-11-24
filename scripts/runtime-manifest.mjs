// Files copied into the slim Windows runtime. Tests reject an incomplete import graph.
export const runtimeFiles = [
  'package.json',
  'package-lock.json',
  'routequay.cmd',
  'routequay.ps1',
  'vpncp.cmd',
  'vpncp.ps1',
  'apps/cli/src/vpncp.ts',
  'packages/core/src/install-layout.ts',
  'packages/core/src/operator-config.ts',
  'packages/core/src/xray-adoption.ts',
  'packages/core/src/xray-client.ts',
  'packages/core/src/xray-add-client.py',
  'packages/core/src/xray-install.ts',
  'packages/core/src/linux-compatibility.ts',
  'packages/core/src/protect-private-path.ps1',
  'packages/core/src/install-preflight.py',
  'packages/core/src/xray-adoption-probe.py',
  'packages/core/src/first-install-transaction.sh',
  'packages/core/src/xray-install.sh',
  'packages/exporters/src/client-connection.ts',
  'packages/exporters/src/mihomo-yaml.ts',
  'packages/exporters/src/shadowrocket-real.ts',
  'packages/exporters/src/sing-box-json.ts',
  'packages/exporters/src/vless-qr.ts',
  'examples/operator-config.example.json',
  'scripts/install.ps1',
  'scripts/install-win.mjs',
  'scripts/runtime-manifest.mjs'
];

export function listRuntimeFiles() {
  return [...runtimeFiles];
}
