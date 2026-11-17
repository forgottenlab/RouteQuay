export type DiagnosticSeverity = "info" | "warning" | "error";

export type RedactedDiagnostic = {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
};

export type CommandResult = {
  command: string;
  status: "pass" | "fail" | "skipped";
  exitCode?: number;
  summary: string;
};

export type PermissionFlags = {
  allowRemoteReadonly: boolean;
  allowRemoteValidate: boolean;
  allowDeploy: boolean;
  allowSecretFileMove: boolean;
};

export type HostStatus = {
  hostname: string;
  operatingSystem: string;
  kernel: string;
  architecture: string;
  virtualization?: string;
  providerModel?: string;
  uptimeSummary: string;
  loadAverage: [number, number, number];
};

export type DiskUsage = {
  mount: string;
  size: string;
  used: string;
  available: string;
  usedPercent: number;
};

export type ResourceSummary = {
  cpu: {
    vcpus: number;
    model: string;
  };
  memory: {
    totalMiB: number;
    usedMiB: number;
    availableMiB: number;
  };
  swap: {
    totalGiB: number;
    usedMiB: number;
  };
  disks: DiskUsage[];
};

export type ListeningPort = {
  protocol: "tcp" | "udp";
  port: number;
  scope: "loopback" | "public" | "interface" | "unknown";
  purpose?: string;
};

export type ListeningPortSummary = {
  ports: ListeningPort[];
  rawAddressesIncluded: false;
  notes: string[];
};

export type XrayServiceStatus = {
  loadState: "loaded" | "not-found" | "error" | "unknown";
  activeState: "active" | "inactive" | "failed" | "unknown";
  subState: string;
  unitFileState: "enabled" | "disabled" | "static" | "unknown";
  unitFilePath: string;
  mainPid?: number;
  restartCount?: number;
  memoryCurrentBytes?: number;
  processElapsed?: string;
  processCpuPercent?: number;
  processMemoryPercent?: number;
  binaryPath?: string;
  version?: string;
  logsRead: false;
};

export type ConfigFileMetadata = {
  path: string;
  exists: boolean;
  sizeBytes?: number;
  modifiedTime?: string;
  permissions?: string;
  owner?: string;
  group?: string;
  contentRead: false;
};

export type ReadonlyInventory = {
  checkTime: string;
  targetAlias: string;
  mode: "remote-readonly";
  commands: CommandResult[];
  host: HostStatus;
  resources: ResourceSummary;
  listeningPorts: ListeningPortSummary;
  xray: XrayServiceStatus;
  configFile: ConfigFileMetadata;
  diagnostics: RedactedDiagnostic[];
};

export type ServerStatus = {
  nodeId: string;
  displayName: string;
  statusSource: "fixture" | "remote-readonly" | "local-cache";
  lastCheckedAt: string;
  host: HostStatus;
  resources: ResourceSummary;
  listeningPorts: ListeningPortSummary;
  xray: XrayServiceStatus;
  configFile: ConfigFileMetadata;
  diagnostics: RedactedDiagnostic[];
};

export function defaultPermissionFlags(): PermissionFlags {
  return {
    allowRemoteReadonly: false,
    allowRemoteValidate: false,
    allowDeploy: false,
    allowSecretFileMove: false
  };
}

export function canRunRemoteReadonly(flags: Partial<PermissionFlags> = {}): boolean {
  return flags.allowRemoteReadonly === true;
}

export function canRunRemoteValidate(flags: Partial<PermissionFlags> = {}): boolean {
  return flags.allowRemoteValidate === true;
}

export function canRunDeploy(flags: Partial<PermissionFlags> = {}): boolean {
  return flags.allowDeploy === true;
}

export function canMoveSecretFiles(flags: Partial<PermissionFlags> = {}): boolean {
  return flags.allowSecretFileMove === true;
}
