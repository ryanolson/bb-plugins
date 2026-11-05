"""The contract test's cluster world, built from k8s-guard's own test fixtures.

Run: python3 -I world.py <guard repo> <world dir> <command> [json]

The guard's test module (test/test-k8s-guard.py in the guard repo) holds the
stateful fake kubectl, the tbot-style bot kubeconfig, the profiles and the
runner. This file reuses them, so the guard runs here exactly as its own tests
run it. It never touches a real cluster: kubectl is the fake.
"""
import importlib.util
import json
import os
import sys
from pathlib import Path

repo, world, command = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
args = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}

spec = importlib.util.spec_from_file_location('guard_tests', repo / 'test/test-k8s-guard.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

state = world / 'k8s.json'


def load():
    return json.loads(state.read_text())


def save(st):
    state.write_text(json.dumps(st))


def write_exec(path, body):
    path.write_text(body)
    path.chmod(0o755)


if command == 'init':
    home = world / 'home'
    bot = home / '.local/share/tbot/example/kube/kubeconfig.yaml'
    bot.parent.mkdir(parents=True)
    # tbot as the dotfiles install it for one user, in the (fake) passwd home, as the guard's own tests do.
    tbot = home / '.local/bin/tbot'
    tbot.parent.mkdir(parents=True)
    # The guard's fake tbot, which prints an ExecCredential, where it has one; else a stub.
    write_exec(tbot, getattr(g, 'FAKE_TBOT', '#!/bin/sh\nexit 0\n'))
    bot.write_text(g.kubeconfig(str(tbot), destination=bot.parent))
    (world / 'runner.py').write_text(g.RUNNER)
    bin_dir = world / 'bin'
    bin_dir.mkdir()
    write_exec(bin_dir / 'kubectl-fake', g.FAKE_KUBECTL)
    # kubectl: the guard's fake, held at its first `replace` while a hold file exists. The guard runs
    # kubectl only from a pinned path, checked against the sha256 in the profiles (as its own tests do).
    pinned = world / 'pinned/kubectl'
    pinned.parent.mkdir()
    write_exec(pinned, f'''#!/usr/bin/env python3
import os, sys, time
world = {str(world)!r}
if 'replace' in sys.argv and os.path.exists(os.path.join(world, 'hold-replace')) and not os.path.exists(os.path.join(world, 'held')):
    open(os.path.join(world, 'held'), 'w').close()
    while not os.path.exists(os.path.join(world, 'release-replace')):
        time.sleep(0.05)
os.execv(sys.executable, [sys.executable, {str(bin_dir / 'kubectl-fake')!r}, *sys.argv[1:]])
''')
    (bin_dir / 'kubectl').symlink_to(pinned)
    write_exec(bin_dir / 'tsh', g.FAKE_TSH)
    write_exec(bin_dir / 'k8s-guard', f'#!/bin/sh\nexec python3 -I {world / "runner.py"} {g.GUARD} "$@"\n')
    profiles = world / 'profiles.toml'
    import hashlib, re
    pin = hashlib.sha256(pinned.read_bytes()).hexdigest()
    profiles.write_text(re.sub(r'kubectl_sha256 = "[0-9a-f]*"', f'kubectl_sha256 = "{pin}"', g.EXAMPLE.read_text() + g.EXTRA_PROFILE))
    save({'namespaces': {}, 'objects': {}, 'pods': {}})
    print(json.dumps({
        'env': {
            'HOME': str(home), 'FAKE_PW_DIR': str(home), 'K8S_CLUSTERS_PROFILES': str(profiles),
            'XDG_STATE_HOME': str(world / 'state'), 'FAKE_K8S_STATE': str(state),
            'FAKE_KUBECTL_LOG': str(world / 'kubectl.log'), 'FAKE_TSH_LOG': str(world / 'tsh.log'),
            'K8S_GUARD_DOWN_WAIT_SECONDS': '0', 'K8S_GUARD_POLL_SECONDS': '0',
            'FAKE_KUBECTL': str(pinned), 'FAKE_TBOT_LOG': str(world / 'tbot.log'),
        },
        'bin': str(bin_dir), 'guard': str(bin_dir / 'k8s-guard'), 'kubeconfig': str(bot),
        'check': str(repo / 'dot_agents/skills/k8s-clusters/scripts/executable_k8s-check'),
        'ctx': g.CTX, 'profile': g.PROFILE, 'prefix': g.PREFIX, 'me': g.ME, 'other': g.OTHER,
    }))
elif command == 'add-ns':
    st = load()
    st['namespaces'][args['name']] = g.namespace(args['name'], args['thread'], args['uid'], args.get('expires_at'))
    st['objects'].setdefault(args['name'], {})
    st['pods'].setdefault(args['name'], [])
    save(st)
    if args.get('ledger'):
        # The thread ledger line `k8s-guard ns create` writes, so owner commands find their namespace.
        ledger = Path(args['ledger'])
        ledger.parent.mkdir(parents=True, exist_ok=True)
        line = {'time': g.iso_ms(g.hours_from_now(0)), 'thread': args['thread'], 'cluster': g.PROFILE, 'context': g.CTX,
                'namespace': args['name'], 'uid': args['uid'], 'object': f'Namespace/{args["name"]}', 'gpus': 0,
                'direction': 'up', 'lease': None, 'issue': args.get('issue', '12'), 'created': True}
        with open(ledger, 'a') as f:
            f.write(json.dumps(line) + '\n')
elif command == 'add-dgd':
    st = load()
    obj = g.gpu_dgd(args['name'], args['gpus'], args['lease'])
    obj['metadata'].update(namespace=args['ns'], uid=args.get('uid', f'uid-{args["name"]}'), resourceVersion='30')
    # As k8s-guard apply leaves it: labelled with the UID of the namespace it was applied in.
    obj['metadata'].setdefault('labels', {})[g.NS_UID] = st['namespaces'][args['ns']]['metadata']['uid']
    st['objects'][args['ns']]['DynamoGraphDeployment/' + args['name']] = obj
    st['pods'][args['ns']].append(g.pod(args['name'], args['gpus']))
    save(st)
elif command == 'state':
    print(json.dumps(load()))
elif command == 'set':
    save(args)
else:
    sys.exit(f'unknown command {command}')
