#!/usr/bin/env python3
"""Append one VLESS client. Stdout is only a fixed marker; the document is never printed."""
import base64
import copy
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time

UUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')
EMAIL_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
JOB_RE = re.compile(r'^[a-f0-9]{32}$')


class ApplyError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def marker_for(code):
    return {
        'APPLIED': 'ROUTEQUAY_CLIENT_APPLIED',
        'RESTORED': 'ROUTEQUAY_CLIENT_RESTORED',
        'REFUSED': 'ROUTEQUAY_CLIENT_REFUSED',
        'ROLLBACK_FAILED': 'ROUTEQUAY_CLIENT_ROLLBACK_FAILED',
    }.get(code, 'ROUTEQUAY_CLIENT_ROLLBACK_FAILED')


def assert_append_only(baseline, nxt, inbound_index):
    if not isinstance(baseline, dict) or not isinstance(nxt, dict):
        raise ApplyError('REFUSED')
    if not isinstance(inbound_index, int) or isinstance(inbound_index, bool):
        raise ApplyError('REFUSED')
    base_inbounds = baseline.get('inbounds')
    next_inbounds = nxt.get('inbounds')
    if not isinstance(base_inbounds, list) or not isinstance(next_inbounds, list):
        raise ApplyError('REFUSED')
    if inbound_index < 0 or inbound_index >= len(base_inbounds) or inbound_index >= len(next_inbounds):
        raise ApplyError('REFUSED')
    reduced = copy.deepcopy(nxt)
    settings = reduced['inbounds'][inbound_index].get('settings')
    base_settings = base_inbounds[inbound_index].get('settings')
    if not isinstance(settings, dict) or not isinstance(base_settings, dict):
        raise ApplyError('REFUSED')
    clients = settings.get('clients')
    base_clients = base_settings.get('clients')
    if not isinstance(clients, list) or not isinstance(base_clients, list) or len(clients) != len(base_clients) + 1:
        raise ApplyError('REFUSED')
    new = clients[-1]
    if not isinstance(new, dict) or set(new) - {'id', 'email', 'flow'}:
        raise ApplyError('REFUSED')
    if not isinstance(new.get('id'), str) or not UUID_RE.match(new['id']):
        raise ApplyError('REFUSED')
    if not isinstance(new.get('email'), str) or not EMAIL_RE.match(new['email']):
        raise ApplyError('REFUSED')
    if 'flow' in new and new['flow'] != 'xtls-rprx-vision':
        raise ApplyError('REFUSED')
    if clients[:-1] != base_clients:
        raise ApplyError('REFUSED')
    seen = set()
    for inbound in next_inbounds:
        if not isinstance(inbound, dict):
            raise ApplyError('REFUSED')
        inbound_settings = inbound.get('settings') if isinstance(inbound.get('settings'), dict) else {}
        inbound_clients = inbound_settings.get('clients') if isinstance(inbound_settings.get('clients'), list) else []
        for client in inbound_clients:
            if isinstance(client, dict) and isinstance(client.get('id'), str):
                if client['id'] in seen:
                    raise ApplyError('REFUSED')
                seen.add(client['id'])
    settings['clients'] = clients[:-1]
    if reduced != baseline:
        raise ApplyError('REFUSED')


def load_json(path):
    with open(path, encoding='utf-8') as source:
        return json.load(source)


def write_bytes(path, data, mode, uid, gid):
    temporary = path + '.routequay-tmp'
    if os.path.lexists(temporary):
        raise ApplyError('ROLLBACK_FAILED')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
        os.chown(temporary, uid, gid)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except Exception:
        if os.path.lexists(temporary):
            try:
                os.remove(temporary)
            except OSError:
                pass
        raise ApplyError('ROLLBACK_FAILED')


def write_document(path, document, mode, uid, gid):
    body = json.dumps(document, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b'\n'
    write_bytes(path, body, mode, uid, gid)


def restore_bytes(path, previous, mode, uid, gid):
    with open(previous, 'rb') as source:
        data = source.read()
    write_bytes(path, data, mode, uid, gid)


def unit_properties():
    result = subprocess.run(
        ['systemctl', 'show', 'xray.service', '--property=LoadState,MainPID,ExecStart'],
        capture_output=True, text=True, timeout=10, check=False)
    if result.returncode != 0:
        raise ApplyError('REFUSED')
    properties = {}
    for line in result.stdout.splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            properties[key] = value
    return properties


def command_args(properties):
    pid = int(properties.get('MainPID') or '0')
    if pid > 0:
        with open('/proc/%d/cmdline' % pid, 'rb') as source:
            return source.read().decode().rstrip('\0').split('\0')
    match = re.search(r'argv\[\]=(.*?)(?: ;|$)', properties.get('ExecStart', ''))
    return match.group(1).split() if match else []


def discover_config_path(expected):
    properties = unit_properties()
    if properties.get('LoadState') == 'not-found':
        raise ApplyError('REFUSED')
    args = command_args(properties)
    paths = [args[i + 1] for i, arg in enumerate(args[:-1]) if arg in ('-config', '-c')]
    if len(paths) != 1 or any(arg in ('-confdir', '-configdir') for arg in args):
        raise ApplyError('REFUSED')
    found = os.path.realpath(paths[0])
    if found != expected or os.path.islink(expected) or not os.path.isfile(expected):
        raise ApplyError('REFUSED')
    return found


def discover_binary():
    args = command_args(unit_properties())
    if not args or not os.path.isabs(args[0]) or os.path.islink(args[0]) or not os.path.isfile(args[0]):
        raise ApplyError('REFUSED')
    return args[0]


def service_ready(port):
    active = subprocess.run(['systemctl', 'is-active', '--quiet', 'xray'], check=False).returncode == 0
    if not active:
        return False
    listened = subprocess.run(
        ['ss', '-H', '-ltn', 'sport = :%d' % port],
        capture_output=True, text=True, timeout=10, check=False)
    return listened.returncode == 0 and listened.stdout.strip() != ''


def safe_path(value):
    return isinstance(value, str) and value.startswith('/') and 1 <= len(value) <= 240 and '\n' not in value and '\0' not in value


def apply_payload(payload):
    if not isinstance(payload, dict):
        raise ApplyError('REFUSED')
    job_id = payload.get('jobId')
    inbound_index = payload.get('inboundIndex')
    port = payload.get('port')
    expected = payload.get('configPath')
    if not isinstance(job_id, str) or not JOB_RE.match(job_id):
        raise ApplyError('REFUSED')
    if not isinstance(port, int) or isinstance(port, bool) or port < 1 or port > 65535:
        raise ApplyError('REFUSED')
    if not safe_path(expected):
        raise ApplyError('REFUSED')
    assert_append_only(payload.get('baseline'), payload.get('next'), inbound_index)
    local = os.environ.get('ROUTEQUAY_CLIENT_LOCAL') == '1'
    if local:
        if os.path.islink(expected) or not os.path.isfile(expected):
            raise ApplyError('REFUSED')
        path = expected
        receipt = payload.get('receiptDir')
        if not safe_path(receipt) or os.path.islink(receipt):
            raise ApplyError('REFUSED')
    else:
        import fcntl
        path = discover_config_path(expected)
        receipt = '/var/backups/routequay-client-' + job_id
        lock = open('/var/backups', 'r')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ApplyError('REFUSED')
    try:
        current = load_json(path)
    except (OSError, json.JSONDecodeError):
        raise ApplyError('REFUSED')
    if current == payload.get('next'):
        return 'APPLIED'
    if current != payload.get('baseline'):
        raise ApplyError('REFUSED')
    if os.path.lexists(receipt):
        raise ApplyError('REFUSED')
    os.makedirs(receipt, mode=0o700)
    os.chmod(receipt, 0o700)
    info = os.stat(path)
    mode = stat.S_IMODE(info.st_mode)
    previous = os.path.join(receipt, 'previous.json')
    shutil.copy2(path, previous)
    os.chmod(previous, 0o600)
    if os.environ.get('ROUTEQUAY_CLIENT_TEST_FAIL') == '1':
        raise ApplyError('RESTORED')
    if not local:
        staged = os.path.join(receipt, 'next.json')
        write_document(staged, payload.get('next'), 0o600, 0, 0)
        tested = subprocess.run(
            [discover_binary(), 'run', '-test', '-config', staged],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
        if tested.returncode != 0:
            raise ApplyError('RESTORED')
    write_document(path, payload.get('next'), mode, info.st_uid, info.st_gid)
    if local and os.environ.get('ROUTEQUAY_CLIENT_RESTART_FAIL') == '1':
        restore_bytes(path, previous, mode, info.st_uid, info.st_gid)
        raise ApplyError('RESTORED')
    if local:
        return 'APPLIED'
    restarted = subprocess.run(
        ['systemctl', 'restart', 'xray'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
    ready = False
    if restarted.returncode == 0:
        for _ in range(30):
            if service_ready(port):
                ready = True
                break
            time.sleep(1)
    if ready:
        return 'APPLIED'
    try:
        restore_bytes(path, previous, mode, info.st_uid, info.st_gid)
        subprocess.run(['systemctl', 'restart', 'xray'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
    except ApplyError:
        raise
    except Exception:
        raise ApplyError('ROLLBACK_FAILED')
    raise ApplyError('RESTORED')


def main():
    os.umask(0o077)
    try:
        raw = os.environ.get('ROUTEQUAY_CLIENT_PAYLOAD', '')
        payload = json.loads(base64.b64decode(raw))
        code = apply_payload(payload)
        sys.stdout.write(marker_for(code) + '\n')
        return 0 if code == 'APPLIED' else 1
    except ApplyError as error:
        sys.stdout.write(marker_for(error.code) + '\n')
        return 1
    except Exception:
        sys.stdout.write(marker_for('ROLLBACK_FAILED') + '\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())
