#!/usr/bin/env python3
"""Read-only plan and explicit apply for the RouteQuay host-hardening pack.

The pack is source-restricted host firewall, SSH key-only, and an Xray systemd
sandbox. It never deletes existing allow rules, never talks to a cloud security
group API, and never enables Fail2ban.
"""
import hashlib
import json
import os
import subprocess
import sys

SSH_DROPIN = '/etc/ssh/sshd_config.d/99-routequay-key-only.conf'
SANDBOX_DROPIN = '/etc/systemd/system/xray.service.d/10-routequay-sandbox.conf'
ALLOWED_WRITES = (SSH_DROPIN, SANDBOX_DROPIN)
SSH_DROPIN_BODY = """# Managed by routequay harden. Does not change Port or ListenAddress.
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
"""
SANDBOX_BODY = """[Service]
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
UMask=0077
"""
OPTIONAL_NOT_APPLIED = [
    'unattended-upgrades', 'logrotate', 'lynis', 'vnstat', 'sysstat', 'mtr', 'iperf3'
]
NOT_PRODUCTIZED = [
    'crowdsec', 'apparmor', 'aide', 'auditd', 'netdata', 'prometheus', 'grafana'
]


class CidrError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def ipv4_int(text):
    parts = text.split('.')
    if len(parts) != 4:
        raise CidrError('HARDEN_CIDR_INVALID')
    value = 0
    for part in parts:
        if not part.isdigit() or (len(part) > 1 and part.startswith('0')):
            raise CidrError('HARDEN_CIDR_INVALID')
        number = int(part)
        if number > 255:
            raise CidrError('HARDEN_CIDR_INVALID')
        value = (value << 8) | number
    return value


def ipv6_int(text):
    if '.' in text or '%' in text or text.count('::') > 1:
        raise CidrError('HARDEN_CIDR_INVALID')
    halves = text.lower().split('::')
    def groups_of(part):
        if part == '':
            return []
        return part.split(':')
    if len(halves) == 2:
        left, right = groups_of(halves[0]), groups_of(halves[1])
        if len(left) + len(right) > 7:
            raise CidrError('HARDEN_CIDR_INVALID')
        groups = left + ['0'] * (8 - len(left) - len(right)) + right
    else:
        groups = groups_of(text.lower())
    if len(groups) != 8:
        raise CidrError('HARDEN_CIDR_INVALID')
    value = 0
    for group in groups:
        if not group or len(group) > 4 or any(char not in '0123456789abcdef' for char in group):
            raise CidrError('HARDEN_CIDR_INVALID')
        value = (value << 16) | int(group, 16)
    return value


def canonical_cidr(text):
    if not isinstance(text, str) or '/' not in text or any(char.isspace() for char in text):
        raise CidrError('HARDEN_CIDR_INVALID')
    address, prefix_text = text.split('/', 1)
    if not prefix_text.isdigit():
        raise CidrError('HARDEN_CIDR_INVALID')
    prefix = int(prefix_text)
    if ':' in address:
        if prefix == 0:
            raise CidrError('HARDEN_CIDR_UNRESTRICTED')
        if prefix < 1 or prefix > 128:
            raise CidrError('HARDEN_CIDR_INVALID')
        network = ipv6_int(address) & (((1 << 128) - 1) << (128 - prefix) & ((1 << 128) - 1))
        groups = [format((network >> shift) & 0xffff, 'x') for shift in range(112, -1, -16)]
        return compress_ipv6(groups) + '/' + str(prefix)
    if prefix == 0:
        raise CidrError('HARDEN_CIDR_UNRESTRICTED')
    if prefix < 1 or prefix > 32:
        raise CidrError('HARDEN_CIDR_INVALID')
    mask = (0xffffffff << (32 - prefix)) & 0xffffffff
    network = ipv4_int(address) & mask
    octets = [str((network >> shift) & 255) for shift in (24, 16, 8, 0)]
    return '.'.join(octets) + '/' + str(prefix)


def compress_ipv6(groups):
    best_start, best_len, index = -1, 0, 0
    while index < 8:
        if groups[index] == '0':
            end = index
            while end < 8 and groups[end] == '0':
                end += 1
            if end - index > best_len:
                best_start, best_len = index, end - index
            index = end
        else:
            index += 1
    if best_len < 2:
        return ':'.join(groups)
    left = ':'.join(groups[:best_start])
    right = ':'.join(groups[best_start + best_len:])
    if not left and not right:
        return '::'
    if not left:
        return '::' + right
    if not right:
        return left + '::'
    return left + '::' + right


def cidr_contains(cidr, ip):
    network, prefix_text = canonical_cidr(cidr).split('/')
    prefix = int(prefix_text)
    if ':' in network:
        if ':' not in ip:
            return False
        mask = ((1 << 128) - 1) << (128 - prefix) & ((1 << 128) - 1)
        return (ipv6_int(ip) & mask) == (ipv6_int(network) & mask)
    if ':' in ip:
        return False
    mask = (0xffffffff << (32 - prefix)) & 0xffffffff
    return (ipv4_int(ip) & mask) == (ipv4_int(network) & mask)


def address_family(cidr):
    return 'ip6' if ':' in canonical_cidr(cidr).split('/')[0] else 'ip'


def parse_ruleset(payload):
    chains = []
    risky = False
    if not isinstance(payload, dict):
        return chains, True
    for item in payload.get('nftables') or []:
        if not isinstance(item, dict):
            continue
        if 'chain' in item:
            chain = item['chain']
            if chain.get('hook') != 'input':
                continue
            chains.append({
                'family': chain.get('family'), 'table': chain.get('table'), 'name': chain.get('name'),
                'policy': chain.get('policy') or 'accept', 'rules': []
            })
        elif 'rule' in item and chains:
            rule = item['rule']
            target = next((chain for chain in chains
                           if chain['family'] == rule.get('family') and chain['table'] == rule.get('table')
                           and chain['name'] == rule.get('chain')), None)
            if target is None:
                continue
            parsed, rule_risky = parse_rule(rule)
            risky = risky or rule_risky
            target['rules'].append(parsed)
    return chains, risky or len(chains) > 1


def parse_rule(rule):
    expr = rule.get('expr') or []
    if any(isinstance(item, dict) and ('drop' in item or 'reject' in item) for item in expr):
        return {'kind': 'drop', 'broad': False}, True
    port = None
    cidr = None
    saw_source = False
    established = False
    loopback = False
    accept = any(isinstance(item, dict) and 'accept' in item for item in expr)
    for item in expr:
        if not isinstance(item, dict) or 'match' not in item:
            continue
        match = item['match']
        left = match.get('left') or {}
        right = match.get('right')
        payload = left.get('payload') or {}
        if payload.get('field') == 'dport' and isinstance(right, int):
            port = right
        elif payload.get('field') == 'saddr':
            saw_source = True
            cidr = prefix_text(right)
        elif isinstance(left.get('ct'), dict) and left['ct'].get('key') == 'state':
            established = True
        elif isinstance(left.get('meta'), dict) and left['meta'].get('key') == 'iifname' and right == 'lo':
            loopback = True
    if established and accept:
        return {'kind': 'established', 'broad': False, 'comment': rule.get('comment')}, False
    if loopback and accept:
        return {'kind': 'loopback', 'broad': False, 'comment': rule.get('comment')}, False
    if accept and port and cidr:
        return {'kind': 'allow', 'port': port, 'cidr': cidr, 'broad': False, 'comment': rule.get('comment')}, False
    if accept and port and not cidr and not saw_source:
        return {'kind': 'allow', 'port': port, 'cidr': None, 'broad': True, 'comment': rule.get('comment')}, False
    if accept and not established and not loopback and not saw_source and not port:
        return {'kind': 'unknown', 'broad': True, 'comment': rule.get('comment')}, False
    return {'kind': 'unknown', 'broad': False, 'comment': rule.get('comment')}, False


def prefix_text(value):
    try:
        if isinstance(value, str) and '/' in value:
            return canonical_cidr(value)
        if isinstance(value, str):
            return canonical_cidr(value + ('/128' if ':' in value else '/32'))
        if isinstance(value, dict) and isinstance(value.get('prefix'), dict):
            prefix = value['prefix']
            return canonical_cidr('%s/%s' % (prefix.get('addr'), prefix.get('len')))
    except CidrError:
        return None
    return None


def render_ruleset(chains):
    items = [{'metainfo': {'json_schema_version': 1}}]
    for chain in chains:
        items.append({'table': {'family': chain['family'], 'name': chain['table']}})
        items.append({'chain': {
            'family': chain['family'], 'table': chain['table'], 'name': chain['name'],
            'type': 'filter', 'hook': 'input', 'prio': 0, 'policy': chain['policy']
        }})
        for rule in chain['rules']:
            items.append({'rule': {
                'family': chain['family'], 'table': chain['table'], 'chain': chain['name'],
                'comment': rule.get('comment'), 'expr': render_expr(rule)
            }})
    return json.dumps({'nftables': items})


def render_expr(rule):
    if rule.get('kind') == 'established':
        return [{'match': {'op': 'in', 'left': {'ct': {'key': 'state'}}, 'right': ['established', 'related']}}, {'accept': None}]
    if rule.get('kind') == 'loopback':
        return [{'match': {'op': '==', 'left': {'meta': {'key': 'iifname'}}, 'right': 'lo'}}, {'accept': None}]
    if rule.get('kind') == 'drop':
        return [{'drop': None}]
    expr = []
    if rule.get('port'):
        expr.append({'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'dport'}}, 'right': rule['port']}})
    if rule.get('cidr'):
        family = address_family(rule['cidr'])
        address, prefix = canonical_cidr(rule['cidr']).split('/')
        expr.append({'match': {'op': '==', 'left': {'payload': {'protocol': family, 'field': 'saddr'}},
                               'right': {'prefix': {'addr': address, 'len': int(prefix)}}}})
    expr.append({'accept': None})
    return expr


def firewall_hash(facts):
    material = {
        'chains': facts.get('chains') or [],
        'ufwRules': facts.get('ufwRules') or [],
        'ufwDefault': facts.get('ufwDefault'),
        'firewalldRich': facts.get('firewalldRich') or [],
        'firewalldServices': facts.get('firewalldServices') or [],
        'firewalldPorts': facts.get('firewalldPorts') or [],
        'preflightFirewallHash': facts.get('preflightFirewallHash')
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def choose_backend(facts):
    if facts.get('ufwActive') and facts.get('firewalldActive'):
        return None, 'HARDEN_FIREWALL_BACKEND_CONFLICT'
    if facts.get('firewalldActive'):
        return 'firewalld', None
    if facts.get('ufwActive'):
        return 'ufw', None
    if facts.get('nftPresent') and facts.get('nftReadable'):
        return 'nftables', None
    if not facts.get('nftPresent'):
        return None, 'HARDEN_FIREWALL_TOOL_MISSING'
    return None, 'HARDEN_FIREWALL_UNREADABLE'


def normalize_ports(value):
    if not isinstance(value, list) or not value:
        return [], 'HARDEN_XRAY_PORT_UNKNOWN'
    ports = []
    for port in value:
        if not isinstance(port, int) or isinstance(port, bool) or port < 1 or port > 65535:
            return [], 'HARDEN_XRAY_PORT_UNKNOWN'
        if port not in ports:
            ports.append(port)
    return ports, None


def normalize_cidrs(value):
    if not isinstance(value, list):
        return [], ['HARDEN_CIDR_REQUIRED']
    if not value:
        return [], ['HARDEN_CIDR_REQUIRED']
    cidrs, errors = [], []
    for item in value:
        try:
            cidr = canonical_cidr(item)
        except CidrError as error:
            errors.append(error.code)
            continue
        if cidr not in cidrs:
            cidrs.append(cidr)
    return cidrs, errors


def listening(lines, port):
    suffix = ':%s' % port
    for line in lines:
        fields = line.split()
        token = fields[3] if len(fields) > 3 else line
        host, separator, value = token.rpartition(':')
        if separator and value == str(port) and token.endswith(suffix):
            return True
    return False


def ssh_allows(facts):
    rules = []
    for chain in facts.get('chains') or []:
        for rule in chain.get('rules') or []:
            if rule.get('kind') == 'allow' or rule.get('broad'):
                rules.append(rule)
    return rules


def source_covered(facts, ssh_port, cidrs, backend):
    source = facts.get('sshSource')
    if not source or not ssh_port:
        return False
    for cidr in cidrs:
        try:
            if cidr_contains(cidr, source):
                return True
        except CidrError:
            continue
    if backend == 'nftables':
        for rule in ssh_allows(facts):
            if rule.get('broad') and rule.get('port') in (None, ssh_port):
                return True
            if rule.get('port') == ssh_port and rule.get('cidr') and cidr_contains(rule['cidr'], source):
                return True
    if backend == 'ufw':
        for rule in facts.get('ufwRules') or []:
            if rule.get('broad') and rule.get('port') in (None, ssh_port):
                return True
            if rule.get('port') == ssh_port and rule.get('cidr') and cidr_contains(rule['cidr'], source):
                return True
    if backend == 'firewalld':
        if 'ssh' in (facts.get('firewalldServices') or []):
            return True
        if '22/tcp' in (facts.get('firewalldPorts') or []) and ssh_port == 22:
            return True
        for rule in facts.get('firewalldRich') or []:
            if rule.get('port') == ssh_port and rule.get('cidr') and cidr_contains(rule['cidr'], source):
                return True
    return False


def broad_ssh(facts, ssh_port, backend):
    if backend == 'nftables':
        return any(rule.get('broad') and rule.get('port') in (None, ssh_port) for rule in ssh_allows(facts))
    if backend == 'ufw':
        return any(rule.get('broad') and rule.get('port') in (None, ssh_port) for rule in facts.get('ufwRules') or [])
    if backend == 'firewalld':
        if 'ssh' in (facts.get('firewalldServices') or []):
            return True
        if ssh_port == 22 and '22/tcp' in (facts.get('firewalldPorts') or []):
            return True
    return False


def rule_present(facts, port, cidr, backend):
    if backend == 'nftables':
        return any(rule.get('kind') == 'allow' and rule.get('port') == port and rule.get('cidr') == cidr
                   for chain in facts.get('chains') or [] for rule in chain.get('rules') or [])
    if backend == 'ufw':
        return any(rule.get('port') == port and rule.get('cidr') == cidr for rule in facts.get('ufwRules') or [])
    if backend == 'firewalld':
        return any(rule.get('port') == port and rule.get('cidr') == cidr for rule in facts.get('firewalldRich') or [])
    return False


def ssh_key_state(facts):
    sshd = facts.get('sshd') or {}
    pubkey_off = sshd.get('pubkeyauthentication') == 'no'
    password_on = sshd.get('passwordauthentication') != 'no' or sshd.get('kbdinteractiveauthentication') != 'no' \
        or sshd.get('challengeresponseauthentication') != 'no'
    if pubkey_off or (password_on and (facts.get('currentAuth') != 'publickey' or not facts.get('authorizedKeys'))):
        return 'blocked'
    if password_on or pubkey_off:
        return 'change'
    return 'unchanged'


def build_plan(facts, request):
    blockers = []
    cidrs, cidr_errors = normalize_cidrs(request.get('cidrs'))
    blockers.extend(cidr_errors)
    ssh_port = request.get('sshPort')
    if not isinstance(ssh_port, int) or isinstance(ssh_port, bool) or ssh_port < 1 or ssh_port > 65535:
        blockers.append('HARDEN_SSH_PORT_MISMATCH')
        ssh_port = None
    elif facts.get('sshPortObserved') != ssh_port or int((facts.get('sshd') or {}).get('port') or 0) != ssh_port:
        blockers.append('HARDEN_SSH_PORT_MISMATCH')
    xray_ports, port_error = normalize_ports(request.get('xrayPorts'))
    if port_error:
        blockers.append(port_error)
    for port in xray_ports:
        if not listening(facts.get('listeners') or [], port):
            blockers.append('HARDEN_XRAY_PORT_NOT_LISTENING')
            break
    if not facts.get('xrayActive'):
        blockers.append('HARDEN_XRAY_NOT_ACTIVE')
    backend, backend_error = choose_backend(facts)
    if backend_error:
        blockers.append(backend_error)
    if facts.get('layoutRisky'):
        blockers.append('HARDEN_FIREWALL_LAYOUT_UNSUPPORTED')
    covered = source_covered(facts, ssh_port, cidrs, backend) if ssh_port else False
    if backend and ssh_port and not covered and not cidr_errors:
        blockers.append('HARDEN_SSH_PATH_UNCOVERED')
    key_state = ssh_key_state(facts)
    if key_state == 'blocked':
        blockers.append('HARDEN_SSH_LOCKOUT_RISK')
    sandbox_state = 'blocked' if not facts.get('xrayActive') else (
        'unchanged' if facts.get('sandboxBody') == SANDBOX_BODY else 'change')
    broad = broad_ssh(facts, ssh_port or 0, backend)
    policy = 'absent'
    if backend == 'nftables':
        policy = facts['chains'][0]['policy'] if facts.get('chains') else 'absent'
    elif backend == 'ufw':
        policy = facts.get('ufwDefault') or 'allow'
    elif backend == 'firewalld':
        policy = 'drop'
    actions = []
    if not blockers and backend:
        ports = [ssh_port] + xray_ports
        if backend == 'nftables' and not facts.get('chains'):
            actions.append({'op': 'ensure-chain', 'backend': 'nftables'})
        if backend == 'nftables':
            if not any(rule.get('kind') == 'established' for chain in facts.get('chains') or [] for rule in chain['rules']):
                actions.append({'op': 'add-established', 'backend': 'nftables'})
            if not any(rule.get('kind') == 'loopback' for chain in facts.get('chains') or [] for rule in chain['rules']):
                actions.append({'op': 'add-loopback', 'backend': 'nftables'})
        for cidr in cidrs:
            for port in ports:
                if not rule_present(facts, port, cidr, backend):
                    actions.append({'op': 'add-allow', 'backend': backend, 'port': port, 'cidr': cidr})
        if backend == 'nftables' and policy != 'drop':
            actions.append({'op': 'set-policy-drop', 'backend': 'nftables'})
        if backend == 'ufw' and facts.get('ufwDefault') != 'deny':
            actions.append({'op': 'set-policy-drop', 'backend': 'ufw'})
        if key_state == 'change':
            actions.append({'op': 'ssh-key-only'})
        if sandbox_state == 'change':
            actions.append({'op': 'sandbox'})
    restricted = bool(backend) and covered and not broad and (policy == 'drop' or policy == 'deny' or any(
        action.get('op') == 'set-policy-drop' for action in actions) or backend == 'firewalld')
    reason = 'ssh-source-restricted' if restricted else (
        'not-default-existing-broad-allow' if broad else 'ssh-not-source-restricted')
    deduped = []
    for code in blockers:
        if code not in deduped:
            deduped.append(code)
    return {
        'ok': True, 'mode': 'plan', 'changed': False, 'backend': backend,
        'firewall': facts.get('preflightFirewall') or ('read' if facts.get('nftReadable') else 'unknown'),
        'firewallHash': firewall_hash(facts),
        'preflightFirewallHash': facts.get('preflightFirewallHash'),
        'policy': policy, 'sshPort': ssh_port, 'xrayPorts': xray_ports, 'cidrs': cidrs,
        'sshSourceCovered': covered, 'sshSourceRestricted': restricted and not deduped,
        'sshKeyOnly': 'blocked' if key_state == 'blocked' else key_state,
        'sandbox': sandbox_state, 'cloudSecurityGroup': 'unchanged', 'fail2ban': 'not-enabled',
        'fail2banReason': reason, 'optionalNotApplied': OPTIONAL_NOT_APPLIED,
        'notProductized': NOT_PRODUCTIZED, 'blockers': deduped, 'actions': actions
    }


def target_chain(facts):
    if facts.get('chains'):
        chain = facts['chains'][0]
        return chain['family'], chain['table'], chain['name']
    return 'inet', 'routequay', 'input'


def comment_for(kind, port, cidr):
    token = canonical_cidr(cidr).replace('/', '-').replace(':', '-').replace('.', '-')
    return 'routequay-%s-%s-%s' % (kind, port, token)


def nft_allow_argv(facts, port, cidr):
    family, table, name = target_chain(facts)
    protocol = address_family(cidr)
    return ['nft', 'add', 'rule', family, table, name, 'tcp', 'dport', str(port), protocol, 'saddr',
            canonical_cidr(cidr), 'accept', 'comment', comment_for('allow', port, cidr)]


def reject_forbidden(argv):
    if not argv or argv[0] == 'write-file':
        if argv and argv[0] == 'write-file' and argv[1] not in ALLOWED_WRITES:
            raise CidrError('HARDEN_ACTION_FORBIDDEN')
        return
    banned = {'delete', 'flush', 'insert', 'replace', 'reset'}
    if any(part in banned or part.startswith('--remove') for part in argv):
        raise CidrError('HARDEN_ACTION_FORBIDDEN')
    if argv[0] == 'ufw' and 'delete' in argv:
        raise CidrError('HARDEN_ACTION_FORBIDDEN')


class SubprocessHost:
    fixture = False

    def run(self, args):
        reject_forbidden(args)
        if args[0] == 'write-file':
            return write_allowed(args[1], args[2])
        if args[0] == 'read-file':
            return read_allowed(args[1])
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=20)
        except FileNotFoundError:
            return 127, ''
        except subprocess.TimeoutExpired:
            return 124, ''
        return result.returncode, result.stdout

    def ssh_connection(self):
        return os.environ.get('SSH_CONNECTION', '')


class FixtureHost:
    fixture = True

    def __init__(self, state):
        self.state = state

    def run(self, args):
        reject_forbidden(args)
        self.state.setdefault('calls', []).append(list(args[:6]) if args[0] != 'write-file' else ['write-file', args[1]])
        if args[0] == 'nft':
            return self._nft(args)
        if args[0] == 'ufw':
            return self._ufw(args)
        if args[0] == 'firewall-cmd':
            return self._firewalld(args)
        if args[0] == 'sshd':
            return 0, self._sshd_text()
        if args[0] == 'systemctl':
            return self._systemctl(args)
        if args[0] == 'ss':
            return 0, '\n'.join('LISTEN 0 128 %s 0.0.0.0:*' % item for item in self.state.get('listeners') or [])
        if args[0] == 'journalctl':
            source = self.ssh_connection().split()[0] if self.ssh_connection() else ''
            method = self.state.get('currentAuth') or 'unknown'
            if method == 'unknown':
                return 0, ''
            return 0, 'Accepted %s for root from %s port 50000 ssh2\n' % (method, source)
        if args[0] == 'read-file':
            if args[1].endswith('/authorized_keys'):
                if self.state.get('authorizedKeys'):
                    return 0, 'ssh-ed25519 fixture-not-a-key comment\n'
                return 1, ''
            body = (self.state.get('files') or {}).get(args[1])
            return (0, body) if body is not None else (1, '')
        if args[0] == 'write-file':
            self.state.setdefault('files', {})[args[1]] = args[2]
            if args[1] == SSH_DROPIN and not self.state.get('sshDropInIneffective'):
                sshd = self.state.setdefault('sshd', {})
                sshd['passwordauthentication'] = 'no'
                sshd['kbdinteractiveauthentication'] = 'no'
                sshd['challengeresponseauthentication'] = 'no'
                sshd['pubkeyauthentication'] = 'yes'
            return 0, ''
        return 127, ''

    def ssh_connection(self):
        return self.state.get('sshConnection') or ''

    def _nft(self, args):
        if not self.state.get('nftPresent', True):
            return 127, ''
        if args[1:] == ['-s', '-j', 'list', 'ruleset']:
            if self.state.get('nftReadable', True) is False:
                return 1, ''
            return 0, render_ruleset(self.state.get('chains') or [])
        if args[1:3] == ['add', 'table']:
            return 0, ''
        if args[1:3] == ['add', 'chain']:
            self.state.setdefault('chains', []).append({
                'family': args[3], 'table': args[4], 'name': args[5], 'policy': 'accept', 'rules': []
            })
            return 0, ''
        if args[1:3] == ['add', 'rule']:
            chain = self._chain(args[3], args[4], args[5])
            chain['rules'].append(rule_from_argv(args[6:]))
            return 0, ''
        if args[1] == 'chain' and '{ policy drop; }' in args:
            self._chain(args[2], args[3], args[4])['policy'] = 'drop'
            return 0, ''
        return 1, ''

    def _chain(self, family, table, name):
        for chain in self.state.setdefault('chains', []):
            if chain['family'] == family and chain['table'] == table and chain['name'] == name:
                return chain
        raise CidrError('HARDEN_APPLY_FAILED')

    def _ufw(self, args):
        if not self.state.get('ufwPresent'):
            return 127, ''
        if args[1:] == ['status', 'verbose']:
            lines = ['Status: %s' % ('active' if self.state.get('ufwActive') else 'inactive'),
                     'Default: %s (incoming), allow (outgoing), disabled (routed)' % (self.state.get('ufwDefault') or 'allow')]
            for rule in self.state.get('ufwRules') or []:
                source = 'Anywhere' if rule.get('broad') else rule.get('cidr')
                lines.append('%s/tcp                     ALLOW IN    %s' % (rule['port'], source))
            return 0, '\n'.join(lines)
        if args[1] == 'allow':
            port = int(args[args.index('port') + 1])
            cidr = canonical_cidr(args[args.index('from') + 1])
            self.state.setdefault('ufwRules', []).append({'port': port, 'cidr': cidr, 'broad': False})
            return 0, ''
        if args[1:] == ['default', 'deny', 'incoming']:
            self.state['ufwDefault'] = 'deny'
            return 0, ''
        return 1, ''

    def _firewalld(self, args):
        if not self.state.get('firewalldPresent'):
            return 127, ''
        if args[1:] == ['--state']:
            return (0, 'running') if self.state.get('firewalldActive') else (252, 'not running')
        if args[1:] == ['--list-services']:
            return 0, ' '.join(self.state.get('firewalldServices') or [])
        if args[1:] == ['--list-ports']:
            return 0, ' '.join(self.state.get('firewalldPorts') or [])
        if args[1:] == ['--list-rich-rules']:
            return 0, '\n'.join(rule['text'] for rule in self.state.get('firewalldRich') or [])
        joined = ' '.join(args)
        if '--query-rich-rule=' in joined:
            rule = joined.split('--query-rich-rule=', 1)[1]
            return (0, 'yes') if any(item['text'] == rule for item in self.state.get('firewalldRich') or []) else (1, 'no')
        if '--add-rich-rule=' in joined:
            rule = joined.split('--add-rich-rule=', 1)[1]
            parsed = parse_rich(rule)
            self.state.setdefault('firewalldRich', []).append({'text': rule, **parsed})
            return 0, ''
        if args[1:] == ['--reload']:
            return 0, ''
        return 1, ''

    def _sshd_text(self):
        sshd = self.state.get('sshd') or {}
        return '\n'.join('%s %s' % (key, sshd[key]) for key in (
            'port', 'passwordauthentication', 'kbdinteractiveauthentication',
            'challengeresponseauthentication', 'pubkeyauthentication') if key in sshd)

    def _systemctl(self, args):
        if args[1] == 'show' and args[2] == 'ssh.service':
            loaded = 'loaded' if self.state.get('sshUnit', 'ssh') == 'ssh' else 'not-found'
            return 0, loaded
        if args[1] == 'show' and args[2] == 'sshd.service':
            loaded = 'loaded' if self.state.get('sshUnit') == 'sshd' else 'not-found'
            return 0, loaded
        if args[1:] == ['is-active', 'xray']:
            active = self.state.get('xrayActive', True)
            if self.state.get('sandboxBreaks') and (self.state.get('files') or {}).get(SANDBOX_DROPIN) == SANDBOX_BODY:
                active = False
            return (0, 'active') if active else (3, 'inactive')
        if args[1] in ('reload', 'restart', 'daemon-reload'):
            if args[1] == 'restart' and len(args) > 2 and args[2] != 'xray':
                raise CidrError('HARDEN_ACTION_FORBIDDEN')
            return 0, ''
        return 1, ''


def rule_from_argv(args):
    if args[:3] == ['ct', 'state', 'established,related']:
        return {'kind': 'established', 'broad': False, 'comment': args[-1]}
    if args[:2] == ['iif', 'lo']:
        return {'kind': 'loopback', 'broad': False, 'comment': args[-1]}
    port = int(args[args.index('dport') + 1])
    cidr = canonical_cidr(args[args.index('saddr') + 1])
    return {'kind': 'allow', 'port': port, 'cidr': cidr, 'broad': False, 'comment': args[-1]}


def parse_rich(rule):
    try:
        family = 'ipv6' if 'family="ipv6"' in rule else 'ipv4'
        address = rule.split('source address="', 1)[1].split('"', 1)[0]
        port = int(rule.split('port port="', 1)[1].split('"', 1)[0])
        return {'port': port, 'cidr': canonical_cidr(address), 'broad': False, 'family': family, 'text': rule}
    except (CidrError, IndexError, ValueError):
        return {'port': None, 'cidr': None, 'broad': False, 'text': rule, 'unknown': True}


def stored_rich(rule):
    parsed = parse_rich(rule)
    parsed['text'] = rule
    return parsed


def write_allowed(path, content):
    if path not in ALLOWED_WRITES:
        return 126, ''
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o755, exist_ok=True)
    temporary = path + '.routequay-tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        os.write(fd, content.encode())
    finally:
        os.close(fd)
    os.replace(temporary, path)
    return 0, ''


def read_allowed(path):
    if path not in ALLOWED_WRITES and not path.endswith('/authorized_keys'):
        return 126, ''
    try:
        with open(path, encoding='utf-8') as source:
            return 0, source.read()
    except OSError:
        return 1, ''


def collect_facts(host):
    nft_code, nft_out = host.run(['nft', '-s', '-j', 'list', 'ruleset'])
    nft_present = nft_code != 127
    chains, risky = ([], False)
    nft_readable = False
    if nft_code == 0:
        try:
            chains, risky = parse_ruleset(json.loads(nft_out))
            nft_readable = True
        except (ValueError, TypeError):
            nft_readable = False
            risky = True
    ufw_code, ufw_out = host.run(['ufw', 'status', 'verbose'])
    ufw_present = ufw_code != 127
    ufw_active = 'Status: active' in ufw_out
    ufw_default = 'deny' if 'Default: deny (incoming)' in ufw_out else 'allow'
    firewalld_code, firewalld_out = host.run(['firewall-cmd', '--state'])
    firewalld_present = firewalld_code != 127
    firewalld_active = firewalld_code == 0 and 'running' in firewalld_out
    services = host.run(['firewall-cmd', '--list-services'])[1].split() if firewalld_present else []
    ports = host.run(['firewall-cmd', '--list-ports'])[1].split() if firewalld_present else []
    rich_lines = host.run(['firewall-cmd', '--list-rich-rules'])[1].splitlines() if firewalld_present else []
    sshd_code, sshd_out = host.run(['sshd', '-T'])
    sshd = {}
    if sshd_code == 0:
        for line in sshd_out.splitlines():
            key, separator, value = line.partition(' ')
            if separator:
                sshd[key.lower()] = value.strip().lower()
    listener_code, listener_out = host.run(['ss', '-H', '-lnt'])
    active_code, active_out = host.run(['systemctl', 'is-active', 'xray'])
    source, observed = parse_ssh_connection(host.ssh_connection())
    auth_out = host.run(['journalctl', '-u', 'ssh', '-u', 'sshd', '-n', '400', '--no-pager', '-o', 'cat'])[1]
    keys_code, keys_out = host.run(['read-file', authorized_keys_path()])
    sandbox_code, sandbox_out = host.run(['read-file', SANDBOX_DROPIN])
    facts = {
        'nftPresent': nft_present, 'nftReadable': nft_readable, 'chains': chains, 'layoutRisky': risky,
        'ufwPresent': ufw_present, 'ufwActive': ufw_active, 'ufwDefault': ufw_default, 'ufwRules': parse_ufw(ufw_out),
        'firewalldPresent': firewalld_present, 'firewalldActive': firewalld_active,
        'firewalldServices': services, 'firewalldPorts': ports,
        'firewalldRich': [stored_rich(line) for line in rich_lines if line.strip()],
        'sshd': sshd, 'listeners': [] if listener_code else listener_out.splitlines(),
        'xrayActive': active_code == 0 and active_out.strip() == 'active',
        'sshSource': source, 'sshPortObserved': observed, 'currentAuth': parse_auth(auth_out, source),
        'authorizedKeys': keys_code == 0 and has_public_key(keys_out),
        'sandboxBody': sandbox_out if sandbox_code == 0 else None
    }
    if not host.fixture and 'inspect_install' in globals():
        try:
            info = inspect_install(observed or 22)
            facts['preflightFirewall'] = info.get('firewall')
            facts['preflightFirewallHash'] = info.get('firewallHash')
        except Exception:
            facts['preflightFirewall'] = 'unknown'
            facts['preflightFirewallHash'] = None
    else:
        facts['preflightFirewall'] = 'read' if nft_readable else 'unknown'
        facts['preflightFirewallHash'] = None
    return facts


def parse_ssh_connection(text):
    parts = (text or '').split()
    if len(parts) != 4 or not parts[3].isdigit():
        return None, None
    return parts[0], int(parts[3])


def parse_auth(text, source):
    found = 'unknown'
    if not source:
        return found
    for line in text.splitlines():
        parts = line.split()
        if 'Accepted' not in parts or source not in parts:
            continue
        method = parts[parts.index('Accepted') + 1]
        if method in ('publickey', 'password', 'keyboard-interactive'):
            found = method
    return found


def authorized_keys_path():
    user = os.environ.get('SUDO_USER') or 'root'
    if user == 'root':
        return '/root/.ssh/authorized_keys'
    return os.path.join(os.path.expanduser('~' + user), '.ssh', 'authorized_keys')


def has_public_key(text):
    prefixes = ('ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'sk-ssh-ed25519@openssh.com')
    return any(line.strip().split(' ', 1)[0] in prefixes for line in text.splitlines() if line.strip() and not line.strip().startswith('#'))


def parse_ufw(text):
    rules = []
    for line in text.splitlines():
        if '/tcp' not in line or 'ALLOW' not in line:
            continue
        try:
            port = int(line.split('/tcp', 1)[0].strip())
            source = line.split()[-1]
            if source == 'Anywhere':
                rules.append({'port': port, 'cidr': None, 'broad': True})
            else:
                rules.append({'port': port, 'cidr': canonical_cidr(source), 'broad': False})
        except (CidrError, ValueError):
            continue
    return rules


def plan_host(host, request):
    return build_plan(collect_facts(host), request)


def apply_host(host, request):
    facts = collect_facts(host)
    plan = build_plan(facts, request)
    if plan['blockers']:
        return failure(plan, plan['blockers'][0])
    expected = request.get('expectedFirewallHash')
    if not isinstance(expected, str) or expected != plan['firewallHash']:
        return failure(plan, 'HARDEN_BASELINE_CHANGED')
    preflight = request.get('expectedPreflightHash')
    if plan.get('preflightFirewallHash') and preflight != plan['preflightFirewallHash']:
        return failure(plan, 'HARDEN_BASELINE_CHANGED')
    for index, action in enumerate(plan['actions']):
        code = perform(host, action, request)
        if code:
            refused = failure(build_plan(collect_facts(host), request), code)
            refused['changed'] = index > 0
            return refused
    after = build_plan(collect_facts(host), request)
    if 'set-policy-drop' in [action['op'] for action in plan['actions']] and not after['sshSourceCovered']:
        return failure(after, 'HARDEN_SSH_PATH_UNCOVERED')
    changed = bool(plan['actions'])
    after['mode'] = 'apply'
    after['changed'] = changed
    after['ok'] = True
    after['blockers'] = []
    return after


def failure(plan, code):
    body = dict(plan)
    body['ok'] = False
    body['mode'] = 'apply'
    body['changed'] = False
    body['code'] = code
    return body


def perform(host, action, request):
    op = action.get('op')
    if op == 'ensure-chain':
        code, _ = host.run(['nft', 'add', 'table', 'inet', 'routequay'])
        if code not in (0, 1):
            return 'HARDEN_APPLY_FAILED'
        code, _ = host.run(['nft', 'add', 'chain', 'inet', 'routequay', 'input',
                            '{ type filter hook input priority 0; policy accept; }'])
        return None if code == 0 else 'HARDEN_APPLY_FAILED'
    if op == 'add-established':
        family, table, name = target_chain(collect_facts(host))
        argv = ['nft', 'add', 'rule', family, table, name, 'ct', 'state', 'established,related', 'accept',
                'comment', 'routequay-established']
        return None if host.run(argv)[0] == 0 else 'HARDEN_APPLY_FAILED'
    if op == 'add-loopback':
        family, table, name = target_chain(collect_facts(host))
        argv = ['nft', 'add', 'rule', family, table, name, 'iif', 'lo', 'accept', 'comment', 'routequay-loopback']
        return None if host.run(argv)[0] == 0 else 'HARDEN_APPLY_FAILED'
    if op == 'add-allow':
        return add_allow(host, action)
    if op == 'set-policy-drop':
        facts = collect_facts(host)
        if not source_covered(facts, request.get('sshPort'), request_cidrs(request), action.get('backend')):
            return 'HARDEN_SSH_PATH_UNCOVERED'
        if action.get('backend') == 'ufw':
            return None if host.run(['ufw', 'default', 'deny', 'incoming'])[0] == 0 else 'HARDEN_APPLY_FAILED'
        family, table, name = target_chain(facts)
        argv = ['nft', 'chain', family, table, name, '{ policy drop; }']
        return None if host.run(argv)[0] == 0 else 'HARDEN_APPLY_FAILED'
    if op == 'ssh-key-only':
        return apply_ssh(host)
    if op == 'sandbox':
        return apply_sandbox(host)
    return 'HARDEN_ACTION_FORBIDDEN'


def request_cidrs(request):
    cidrs, errors = normalize_cidrs(request.get('cidrs'))
    return [] if errors else cidrs


def add_allow(host, action):
    facts = collect_facts(host)
    cidr = canonical_cidr(action['cidr'])
    port = action['port']
    backend = action['backend']
    if rule_present(facts, port, cidr, backend):
        return None
    if backend == 'nftables':
        return None if host.run(nft_allow_argv(facts, port, cidr))[0] == 0 else 'HARDEN_APPLY_FAILED'
    if backend == 'ufw':
        argv = ['ufw', 'allow', 'proto', 'tcp', 'from', cidr, 'to', 'any', 'port', str(port),
                'comment', comment_for('allow', port, cidr)]
        return None if host.run(argv)[0] == 0 else 'HARDEN_APPLY_FAILED'
    if backend == 'firewalld':
        family = 'ipv6' if address_family(cidr) == 'ip6' else 'ipv4'
        rule = 'rule family="%s" source address="%s" port port="%s" protocol="tcp" accept' % (family, cidr, port)
        query = ['firewall-cmd', '--query-rich-rule=%s' % rule]
        if host.run(query)[0] == 0:
            return None
        added = host.run(['firewall-cmd', '--permanent', '--add-rich-rule=%s' % rule])
        if added[0] != 0:
            return 'HARDEN_APPLY_FAILED'
        return None if host.run(['firewall-cmd', '--reload'])[0] == 0 else 'HARDEN_APPLY_FAILED'
    return 'HARDEN_ACTION_FORBIDDEN'


def apply_ssh(host):
    previous = host.run(['read-file', SSH_DROPIN])[1]
    if previous == SSH_DROPIN_BODY:
        return None
    if host.run(['write-file', SSH_DROPIN, SSH_DROPIN_BODY])[0] != 0:
        return 'HARDEN_APPLY_FAILED'
    _code, text = host.run(['sshd', '-T'])
    if 'passwordauthentication no' not in text or 'pubkeyauthentication yes' not in text:
        restore_file(host, SSH_DROPIN, previous)
        return 'HARDEN_SSH_KEY_ONLY_UNCONFIRMED'
    unit = 'ssh' if host.run(['systemctl', 'show', 'ssh.service', '--property=LoadState', '--value'])[1].strip() == 'loaded' else 'sshd'
    if host.run(['systemctl', 'reload', unit])[0] != 0:
        restore_file(host, SSH_DROPIN, previous)
        return 'HARDEN_SSH_KEY_ONLY_UNCONFIRMED'
    return None


def apply_sandbox(host):
    previous = host.run(['read-file', SANDBOX_DROPIN])[1]
    if previous == SANDBOX_BODY:
        return None
    if host.run(['write-file', SANDBOX_DROPIN, SANDBOX_BODY])[0] != 0:
        return 'HARDEN_APPLY_FAILED'
    if host.run(['systemctl', 'daemon-reload'])[0] != 0 or host.run(['systemctl', 'restart', 'xray'])[0] != 0:
        restore_file(host, SANDBOX_DROPIN, previous)
        host.run(['systemctl', 'daemon-reload'])
        host.run(['systemctl', 'restart', 'xray'])
        return 'HARDEN_SANDBOX_ROLLED_BACK'
    if host.run(['systemctl', 'is-active', 'xray'])[0] != 0:
        restore_file(host, SANDBOX_DROPIN, previous)
        host.run(['systemctl', 'daemon-reload'])
        host.run(['systemctl', 'restart', 'xray'])
        return 'HARDEN_SANDBOX_ROLLED_BACK'
    return None


def restore_file(host, path, previous):
    if previous:
        host.run(['write-file', path, previous])
    elif isinstance(host, FixtureHost):
        host.state.get('files', {}).pop(path, None)
        host.state.setdefault('calls', []).append(['restore-remove', path])
    else:
        try:
            os.remove(path)
        except OSError:
            pass


def load_request():
    encoded = os.environ.get('ROUTEQUAY_HARDEN_REQUEST_B64', '')
    if not encoded:
        return {'mode': 'plan', 'cidrs': [], 'sshPort': 22, 'xrayPorts': []}
    try:
        return json.loads(base64_decode(encoded))
    except (ValueError, TypeError):
        return None


def base64_decode(text):
    import base64
    return base64.b64decode(text.encode(), validate=True)


def make_host():
    path = os.environ.get('ROUTEQUAY_HARDEN_FIXTURE')
    if not path:
        return SubprocessHost()
    with open(path, encoding='utf-8') as source:
        return FixtureHost(json.load(source))


def save_fixture(host):
    path = os.environ.get('ROUTEQUAY_HARDEN_FIXTURE')
    if isinstance(host, FixtureHost) and path:
        with open(path, 'w', encoding='utf-8') as output:
            json.dump(host.state, output)


def main():
    request = load_request()
    if not isinstance(request, dict) or request.get('mode') not in ('plan', 'apply'):
        emit({'ok': False, 'code': 'HARDEN_MODE_INVALID', 'changed': False, 'cloudSecurityGroup': 'unchanged'})
        return
    host = make_host()
    try:
        result = plan_host(host, request) if request['mode'] == 'plan' else apply_host(host, request)
    except Exception:
        result = {'ok': False, 'code': 'HARDEN_REMOTE_FAILED', 'changed': False, 'cloudSecurityGroup': 'unchanged'}
    save_fixture(host)
    emit(result)


def emit(result):
    result.pop('sshSource', None)
    sys.stdout.write(json.dumps(result) + '\n')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        emit({'ok': False, 'code': 'HARDEN_REMOTE_FAILED', 'changed': False, 'cloudSecurityGroup': 'unchanged'})
