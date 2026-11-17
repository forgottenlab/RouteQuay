import json
import os
import re
import subprocess
import time


def command(*args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=10)
    except OSError:
        return ''
    return result.stdout.strip()


def probe():
    properties = dict(line.split('=', 1) for line in command(
        'systemctl', 'show', 'xray.service', '--property=LoadState,ActiveState,User,Group,MainPID,ExecStart'
    ).splitlines() if '=' in line)
    result = {'linux': linux_environment(), 'loadState': properties.get('LoadState'), 'service': properties.get('ActiveState'),
              'user': properties.get('User') or 'root', 'group': properties.get('Group') or None,
              'version': None, 'configPath': None, 'permissions': None, 'config': None,
              'listeners': [], 'diskMatchesRunning': False}
    if result['loadState'] == 'not-found':
        result['install'] = inspect_install(8443)
        return result
    managed_elsewhere = any(os.path.exists(path) for path in ['/etc/x-ui', '/opt/marzban', '/usr/local/x-ui'])
    unit_lines = command('systemctl', 'list-unit-files', '--no-legend', '--no-pager').splitlines()
    unit_lines += command('systemctl', 'list-units', '--all', '--no-legend', '--no-pager', 'xray*').splitlines()
    # An uninstantiated, disabled vendor template is normal alongside xray.service.
    multiple_units = any(line.split()[0].startswith('xray') and line.split()[0].endswith('.service')
                         and line.split()[0] not in ('xray.service', 'xray@.service')
                         for line in unit_lines if line.split())
    if managed_elsewhere or multiple_units:
        result['layout'] = 'unsupported'
        return result
    pid = int(properties.get('MainPID') or '0')
    if pid > 0:
        with open('/proc/%d/cmdline' % pid, 'rb') as source:
            args = source.read().decode().rstrip('\0').split('\0')
    else:
        # Only accept a conventional single-file systemd command when stopped.
        match = re.search(r'argv\[\]=(.*?)(?: ;|$)', properties.get('ExecStart', ''))
        args = match.group(1).split() if match else []
    paths = [args[i + 1] for i, arg in enumerate(args[:-1]) if arg in ('-config', '-c')]
    if len(paths) != 1 or any(arg in ('-confdir', '-configdir') for arg in args):
        result['layout'] = 'unsupported'
        return result
    path = os.path.realpath(paths[0])
    if not os.path.isabs(paths[0]) or not args or not os.path.isabs(args[0]):
        result['layout'] = 'unsupported'
        return result
    version = re.search(r'^Xray\s+(\d+\.\d+\.\d+)', command(args[0], 'version'))
    if not version:
        result['layout'] = 'unsupported'
        return result
    result['version'] = 'Xray ' + version.group(1)
    result['configPath'] = path
    stat = os.stat(path)
    result['permissions'] = {'uid': stat.st_uid, 'gid': stat.st_gid, 'mode': oct(stat.st_mode & 0o777)}
    with open(path, encoding='utf-8') as source:
        result['config'] = json.load(source)
    after = os.stat(path)
    if (stat.st_ino, stat.st_mtime_ns, stat.st_size) != (after.st_ino, after.st_mtime_ns, after.st_size):
        raise ValueError('configuration changed during read')
    if pid > 0:
        with open('/proc/%d/stat' % pid) as source:
            ticks = int(source.read().rsplit(')', 1)[1].split()[19])
        with open('/proc/uptime') as source:
            uptime = float(source.read().split()[0])
        started = time.time() - uptime + ticks / os.sysconf('SC_CLK_TCK')
        result['diskMatchesRunning'] = max(stat.st_mtime, stat.st_ctime) <= started
    # Return only address/port strings, never process command lines.
    result['listeners'] = [line.split()[3] for line in command('ss', '-H', '-lnt').splitlines() if len(line.split()) > 3]
    result['layout'] = 'single-file'
    return result


try:
    print(json.dumps({'ok': True, 'probe': probe()}))
except Exception:
    # Configuration and subprocess exceptions may include private values.
    print(json.dumps({'ok': False, 'code': 'REMOTE_LAYOUT_OR_PERMISSION_UNAVAILABLE'}))
