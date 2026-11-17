import hashlib
import json
import os
import shutil
import subprocess
import shlex


def parse_os_release(text):
    release = {}
    for line in text.splitlines():
        if '=' not in line or line.lstrip().startswith('#'):
            continue
        key, value = line.split('=', 1)
        if key in ('ID', 'VERSION_ID'):
            values = shlex.split(value, comments=True, posix=True)
            if len(values) != 1:
                raise ValueError('Invalid os-release value')
            release[key] = values[0]
    return release


def linux_environment():
    with open('/etc/os-release') as source:
        release = parse_os_release(source.read())
    try:
        with open('/proc/1/comm') as source:
            pid_one = source.read().strip()
    except OSError:
        pid_one = ''
    return {'os': release.get('ID'), 'release': release.get('VERSION_ID'), 'arch': os.uname().machine,
            'serviceManager': 'systemd' if pid_one == 'systemd' and os.path.isdir('/run/systemd/system') else 'unknown',
            'packageManager': 'apt' if shutil.which('apt-get') and shutil.which('dpkg-query') else 'unknown'}


def filesystem_capabilities():
    # Metadata-only checks keep --plan read-only. publish() later validates actual
    # atomic hard-link creation and fails closed if the filesystem rejects it.
    directories = ['/usr/local/bin', '/usr/local/etc', '/etc/systemd/system', '/var/backups', '/var/lib', '/etc']
    present = all(os.path.isdir(path) for path in directories)
    safe = present and all(os.path.realpath(path) == path for path in directories)
    writable = present and all(os.access(path, os.W_OK | os.X_OK)
                              and not (os.statvfs(path).f_flag & os.ST_RDONLY) for path in directories)
    return {'standardDirectories': present, 'safePaths': safe, 'writable': writable,
            'posixPermissions': hasattr(os, 'chmod') and hasattr(os, 'chown'),
            'serviceAccountFiles': all(os.path.isfile(path) and os.access(path, os.W_OK)
                                       for path in ['/etc/passwd', '/etc/group']),
            'nologin': os.path.isfile('/usr/sbin/nologin') and os.access('/usr/sbin/nologin', os.X_OK)}


def inspect_install(port):
    def run(*args):
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=10)
        except FileNotFoundError:
            return 127, ''
        except subprocess.TimeoutExpired:
            return 124, ''
        return result.returncode, result.stdout.strip()

    environment = linux_environment()
    commands = ['bash', 'flock', 'curl', 'python3', 'openssl', 'ss', 'systemctl',
                'sha256sum', 'install', 'ln', 'realpath', 'stat', 'useradd', 'userdel',
                'getent', 'chown', 'chmod', 'mktemp', 'grep', 'awk', 'cat', 'touch',
                'rmdir', 'rm', 'mkdir', 'uname', 'id', 'dirname', 'sleep', 'timeout', 'cut', 'groupdel', 'date']
    paths = ['/usr/local/bin/xray', '/usr/bin/xray', '/usr/local/etc/xray', '/etc/xray',
             '/etc/systemd/system/xray.service', '/usr/lib/systemd/system/xray.service',
             '/lib/systemd/system/xray.service', '/etc/systemd/system/xray.service.d',
             '/run/systemd/system/xray.service', '/etc/systemd/system/multi-user.target.wants/xray.service',
             '/etc/x-ui', '/opt/marzban', '/usr/local/x-ui']
    existing = [path for path in paths if os.path.lexists(path)]
    units_code, units = run('systemctl', 'list-unit-files', '--no-legend', '--no-pager')
    conflicts = [line.split()[0] for line in units.splitlines()
                 if any(name in line.split()[0].lower() for name in ['xray', 'x-ui', 'marzban'])]
    processes = []
    for entry in os.listdir('/proc'):
        if entry.isdigit():
            try:
                with open('/proc/' + entry + '/comm') as source:
                    name = source.read().strip().lower()
                if any(value in name for value in ['xray', 'x-ui', 'marzban']):
                    processes.append(name)
            except (OSError, ValueError):
                pass
    listener_code, listeners = run('ss', '-H', '-lntup')
    active_code, load = run('systemctl', 'show', 'xray.service', '--property=LoadState', '--value')
    root = os.geteuid() == 0
    sudo = root or run('sudo', '-n', 'true')[0] == 0 if shutil.which('sudo') or root else False
    nft_present = shutil.which('nft') is not None
    nft_code, nft = run('nft', '-s', '-j', 'list', 'ruleset') if nft_present and root else (1, '')
    info = {**environment, 'filesystem': filesystem_capabilities(),
            'systemd': environment['serviceManager'] == 'systemd', 'root': root, 'sudo': sudo,
            'missingCommands': [name for name in commands if not shutil.which(name)],
            'freeMiB': shutil.disk_usage('/usr/local').free // (1024 * 1024),
            'existing': existing, 'units': conflicts, 'processes': sorted(processes),
            'loadState': load, 'inspectionComplete': units_code == 0 and listener_code == 0 and active_code == 0,
            'listeners': sorted(listeners.splitlines()),
            'firewall': 'read' if nft_code == 0 else 'unknown',
            'firewallHash': hashlib.sha256(nft.encode()).hexdigest() if nft_code == 0 else None,
            'sshEndpoint': os.environ.get('SSH_CONNECTION', '').split()[-2:]}
    # Disk capacity varies without changing target identity; evaluate its lower bound separately.
    baseline = {key: value for key, value in info.items() if key != 'freeMiB'}
    info['baseline'] = hashlib.sha256(json.dumps(baseline, sort_keys=True).encode()).hexdigest()
    return info
