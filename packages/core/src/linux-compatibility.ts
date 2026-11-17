export type LinuxEnvironment = {
  os: string | null;
  release: string | null;
  arch: string;
  serviceManager: 'systemd' | 'unknown';
  packageManager: 'apt' | 'unknown';
};

// ID_LIKE is deliberately excluded. Additional releases need their own tests.
export const firstInstallPlatforms = [
  { os: 'debian', release: '13' },
  { os: 'ubuntu', release: '24.04' }
] as const;

export function supportsFirstInstallPlatform(os: unknown, release: unknown): boolean {
  return firstInstallPlatforms.some(platform => platform.os === os && platform.release === release);
}
