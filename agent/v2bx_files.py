"""Replace Xray auxiliary files, rolling back every touched file on failure."""
import json
import base64
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import signal
import shlex
import uuid
try:
    import fcntl
except ImportError:  # The Linux worker is also unit-tested on Windows.
    fcntl = None

TRANSACTION_ROOT = Path('/var/lib/nodeguard/v2bx-file-transactions')

# This recovery program is also saved beside each transaction. systemd can
# restore the previous configuration even if the SSH worker disappears.
RECOVERY_PROGRAM = r'''
import base64,json,os,pathlib,signal,subprocess,sys,tempfile,time
try:import fcntl
except ImportError:fcntl=None

def ctl(*args):
    return subprocess.check_output(['/usr/bin/systemctl',*args],text=True,stderr=subprocess.DEVNULL,timeout=60)

def replace(path,data,mode=0o600):
    path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())
        os.chmod(name,mode);os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)

def pid_token(pid):
    try:return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
    except (OSError,IndexError):return None

def listening(unit,run=ctl):
    raw=run('show','--property=MainPID','--value','--',unit)
    if not isinstance(raw,str) or not raw.strip().isdigit():return []
    pid=int(raw.strip())
    if not pid:return []
    inodes=set()
    try:
        for fd in pathlib.Path('/proc/'+str(pid)+'/fd').iterdir():
            try:
                value=os.readlink(fd)
                if value.startswith('socket:['):inodes.add(value[8:-1])
            except OSError:pass
    except OSError:return []
    ports=set()
    for name in ('tcp','tcp6'):
        try:
            for line in pathlib.Path('/proc/'+str(pid)+'/net/'+name).read_text().splitlines()[1:]:
                fields=line.split()
                if len(fields)>9 and fields[3]=='0A' and fields[9] in inodes:ports.add(int(fields[1].rsplit(':',1)[1],16))
        except OSError:pass
    return sorted(ports)

def healthy(unit,ports,run=ctl,sleep=time.sleep):
    stable=0;last_pid=None
    for attempt in range(20):
        run('is-active','--quiet','--',unit)
        raw=run('show','--property=MainPID','--value','--',unit)
        if isinstance(raw,str) and raw.strip().isdigit():
            pid=int(raw.strip())
            if not pid or last_pid is not None and pid!=last_pid:raise RuntimeError('V2bX restarted during verification')
            last_pid=pid
        if set(ports)<=set(listening(unit,run)):
            stable+=1
            if stable>=6:return
        else:stable=0
        sleep(2)
    raise RuntimeError('V2bX did not restore its listening ports')

def restore(state,run=ctl,sleep=time.sleep):
    errors=[]
    for name,old in state['files'].items():
        try:
            if old is None:pathlib.Path(name).unlink(missing_ok=True)
            else:replace(name,base64.b64decode(old['data']),old['mode'])
        except Exception:errors.append('file restoration failed')
    try:run('daemon-reload')
    except Exception:errors.append('daemon reload failed')
    for unit in state['units']:
        if unit['active']:
            for attempt in range(3):
                try:
                    try:run('reset-failed','--',unit['name'])
                    except subprocess.CalledProcessError:pass
                    run('restart','--',unit['name'])
                    healthy(unit['name'],unit['ports'],run,sleep);break
                except Exception as error:
                    if attempt==2:errors.append('service restoration failed: '+unit['name']+' ('+type(error).__name__+': '+str(error)[:180]+')')
                    else:sleep(2)
        elif state['restartStopped']:
            try:run('stop','--',unit['name'])
            except Exception:errors.append('service state restoration failed')
    if errors:raise RuntimeError('; '.join(errors))

def recover(folder,run=ctl,sleep=time.sleep,locked=False):
    folder=pathlib.Path(folder);path=folder/'state.json';state=json.loads(path.read_text())
    if state['phase'] in ('committed','rolled_back'):
        subprocess.run(['/usr/bin/systemctl','stop',state['timer']+'.timer'],check=False);return
    if state.get('pidToken') and pid_token(state['pid'])==state['pidToken']:
        try:os.kill(state['pid'],signal.SIGTERM)
        except ProcessLookupError:pass
        for _ in range(10):
            sleep(1)
            if pid_token(state['pid'])!=state['pidToken']:break
        if pid_token(state['pid'])==state['pidToken']:
            try:os.kill(state['pid'],signal.SIGKILL)
            except ProcessLookupError:pass
    with (folder.parent/'operation.lock').open('a') as operation,(folder/'lock').open('a') as lock:
        if fcntl is not None:
            if not locked:fcntl.flock(operation,fcntl.LOCK_EX)
            fcntl.flock(lock,fcntl.LOCK_EX)
        state=json.loads(path.read_text())
        if state['phase'] not in ('committed','rolled_back'):
            restore(state,run,sleep);state['phase']='rolled_back';replace(path,json.dumps(state).encode())
    subprocess.run(['/usr/bin/systemctl','stop',state['timer']+'.timer'],check=False)

if __name__=='__main__':recover(pathlib.Path(__file__).parent)
'''

_recovery = {'__name__': 'nodeguard_v2bx_recovery'}
exec(RECOVERY_PROGRAM, _recovery)


def call(*args):
    return subprocess.check_output(["/usr/bin/systemctl", *args], text=True, stderr=subprocess.DEVNULL, timeout=90)


def parse(raw):
    quoted = r'("(?:[^"\\]|\\.)*")'
    text = re.sub(quoted + r"|//[^\r\n]*|/\*.*?\*/", lambda m: m[1] or " ", raw.decode("utf-8-sig"), flags=re.DOTALL)
    return json.loads(re.sub(quoted + r"|,(?=\s*[}\]])", lambda m: m[1] or "", text))


def atomic(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class FileTransaction:
    def __init__(self, files, restart_stopped):
        TRANSACTION_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(TRANSACTION_ROOT, 0o700)
        self.lock = None
        self.operation_lock = (TRANSACTION_ROOT / 'operation.lock').open('a')
        try:
            if fcntl is not None:
                fcntl.flock(self.operation_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for folder in TRANSACTION_ROOT.iterdir():
                if folder.is_dir() and re.fullmatch('[a-f0-9]{32}', folder.name) and (folder/'state.json').exists():
                    previous = json.loads((folder/'state.json').read_text())
                    if previous['phase'] not in ('committed', 'rolled_back'):
                        _recovery['recover'](folder, call, time.sleep, locked=True)
            # A previous interrupted operation may have left a failed unit.
            # Re-read its configuration and active state after recovery.
            self.operations = plans(files)
            self.prepare(self.operations, restart_stopped)
        except BaseException:
            self.close()
            raise

    def prepare(self, operations, restart_stopped):
        self.folder = TRANSACTION_ROOT / uuid.uuid4().hex
        self.folder.mkdir(mode=0o700)
        self.timer = 'ng-v2bx-recover-' + self.folder.name
        self.lock = (self.folder / 'lock').open('a')
        if fcntl is not None:
            fcntl.flock(self.lock, fcntl.LOCK_EX)
        snapshots = {}
        units = []
        for unit, active, writes in operations:
            units.append({'name': unit, 'active': active, 'ports': _recovery['listening'](unit, call) if active else []})
            for path in writes:
                if str(path) not in snapshots:
                    snapshots[str(path)] = {'data': base64.b64encode(path.read_bytes()).decode(),
                                            'mode': path.stat().st_mode & 0o777} if path.exists() else None
        self.state = {'phase': 'prepared', 'pid': os.getpid(), 'pidToken': _recovery['pid_token'](os.getpid()),
                      'restartStopped': restart_stopped, 'files': snapshots, 'units': units, 'timer': self.timer}
        self.record('prepared')
        atomic(self.folder / 'recover.py', RECOVERY_PROGRAM.encode())
        try:
            subprocess.run(['/usr/bin/systemd-run', '--quiet', '--unit=' + self.timer,
                            '--on-active=' + str(180 + 120 * len(units)) + 's',
                            '--timer-property=AccuracySec=1s',
                            '--property=Type=exec', '--property=TimeoutStartSec=0',
                            '--property=Restart=on-failure', '--property=RestartSec=30s',
                            '/usr/bin/python3', str(self.folder / 'recover.py')],
                           check=True, capture_output=True, timeout=15)
        except BaseException:
            self.close()
            raise

    def record(self, phase):
        self.state['phase'] = phase
        atomic(self.folder / 'state.json', json.dumps(self.state).encode())

    def disarm(self):
        try:
            subprocess.run(['/usr/bin/systemctl', 'stop', self.timer + '.timer'], capture_output=True, timeout=15)
        except Exception:
            pass  # A committed/rolled-back journal makes a late watchdog harmless.

    def close(self):
        if self.lock is not None:
            self.lock.close()
        self.operation_lock.close()


def require_assets(files, unit_text):
    assets = set()
    def visit(value):
        if isinstance(value, dict):
            for item in value.values(): visit(item)
        elif isinstance(value, list):
            for item in value: visit(item)
        elif isinstance(value, str):
            if value.startswith('geoip:'): assets.add('geoip.dat')
            elif value.startswith('geosite:'): assets.add('geosite.dat')
    for content in files.values():
        if content is not None: visit(json.loads(content.lstrip('\ufeff')))
    directory = Path('/etc/V2bX')
    for line in unit_text.splitlines():
        if line.startswith('Environment='):
            for assignment in shlex.split(line[len('Environment='):]):
                if assignment.startswith('XRAY_LOCATION_ASSET='):
                    directory = Path(assignment.split('=', 1)[1])
    for name in assets:
        if not (directory / name).is_file() or (directory / name).stat().st_size == 0:
            raise FileNotFoundError('Required Xray geodata missing: ' + name)


def plans(files):
    result = []
    seen = set()
    candidates = {"V2bX.service", "v2bx.service"}
    candidates.update(p.name for p in Path("/etc/systemd/system").glob("nodeguard-svc-*.service"))
    for candidate in sorted(candidates):
        try:
            props = dict(line.split("=", 1) for line in call("show", "--property=Id,LoadState,ActiveState", "--", candidate).splitlines() if "=" in line)
            unit = props.get("Id", candidate)
            if props.get("LoadState") != "loaded" or unit in seen:
                continue
            text = call("cat", "--", unit)
        except subprocess.CalledProcessError:
            continue
        managed = re.fullmatch(r"nodeguard-(svc-[a-f0-9]{24})\.service", unit)
        if managed:
            if "Description=NodeGuard managed V2bX service" not in text:
                continue
            match = re.search(r"(?m)^LoadCredential=(?:config|service)\.json:(\S+)\s*$", text)
            if not match:
                raise ValueError("Missing managed config credential")
            path = Path(match[1])
            if path.parent != Path("/etc/nodeguard/components") / managed[1] or path.name not in ("config.json", "service.json"):
                raise ValueError("Unsupported managed config path")
        else:
            if unit not in ("V2bX.service", "v2bx.service"):
                continue
            path = Path("/etc/V2bX/config.json")
            if str(path) not in text:
                raise ValueError("Unsupported stock config path")
        seen.add(unit)
        config = parse(path.read_bytes())
        cores = [c for c in config.get("Cores", []) if c.get("Type") == "xray"]
        if not cores:
            if any(v is not None for v in files.values()):
                raise ValueError("Auxiliary files require Xray")
            continue
        require_assets(files, text)
        writes = {}
        credentials = []
        for key, field, name in (("route", "RouteConfigPath", "route.json"), ("outbound", "OutboundConfigPath", "custom_outbound.json")):
            # Only delete files owned by this feature; arbitrary old paths are never removed.
            target = path.parent / name
            content = files[key]
            writes[target] = None if content is None else json.dumps(json.loads(content.lstrip("\ufeff")), ensure_ascii=False).encode()
            for core in cores:
                core[field] = "" if content is None else (f"/run/credentials/{unit}/{name}" if managed else str(target))
            if managed and content is not None:
                credentials.append(f"LoadCredential={name}:{target}")
        if managed:
            dropin = Path("/etc/systemd/system") / (unit + ".d") / "90-nodeguard-files.conf"
            kept = {}
            for line in text.splitlines():
                if line == "LoadCredential=":
                    kept.clear()
                elif line.startswith("LoadCredential="):
                    value = line[len("LoadCredential="):]
                    kept[value.split(":", 1)[0]] = line
            for name in ("route.json", "custom_outbound.json"):
                kept.pop(name, None)
            writes[dropin] = ("[Service]\nLoadCredential=\n" + "\n".join([*kept.values(), *credentials]) + "\n").encode()
        writes[path] = json.dumps(config, ensure_ascii=False, indent=2).encode()
        result.append((unit, props.get("ActiveState") == "active", writes))
    if not result:
        raise ValueError("No supported Xray service found")
    return result


def apply(files, restart_stopped=False):
    transaction = FileTransaction(files, restart_stopped)
    operations = transaction.operations
    previous_handlers = {}
    def interrupted(signum, frame):
        raise InterruptedError('V2bX configuration update interrupted')
    for name in ('SIGTERM', 'SIGINT', 'SIGHUP'):
        value = getattr(signal, name, None)
        if value is not None:
            previous_handlers[value] = signal.signal(value, interrupted)
    try:
        transaction.record('applying')
        for _, _, writes in operations:
            for path, data in writes.items():
                # Removed credentials are deleted after successful restarts.
                if data is not None:
                    atomic(path, data)
        call("daemon-reload")
        for (unit, active, _), before in zip(operations, transaction.state['units']):
            if active or restart_stopped:
                try:
                    call('reset-failed', '--', unit)
                except subprocess.CalledProcessError:
                    pass  # An inactive unloaded unit can still be started normally.
                call("restart", "--", unit)
                _recovery['healthy'](unit, before['ports'], call, time.sleep)
        for _, _, writes in operations:
            for path, data in writes.items():
                if data is None:
                    path.unlink(missing_ok=True)
        transaction.record('committed')
        transaction.disarm()
        print('NODEGUARD_V2BX_FILES:applied', file=sys.stderr)
    except BaseException:
        transaction.record('rolling_back')
        try:
            _recovery['restore'](transaction.state, call, time.sleep)
            transaction.record('rolled_back')
            transaction.disarm()
            print('NODEGUARD_V2BX_FILES:rolled_back', file=sys.stderr)
        except BaseException:
            print('NODEGUARD_V2BX_FILES:rollback_failed', file=sys.stderr)
            # Keep the timer armed; it retries recovery independently of SSH.
            raise
        raise
    finally:
        for value, handler in previous_handlers.items():
            signal.signal(value, handler)
        transaction.close()


if __name__ == "__main__":
    print("NODEGUARD_PHASE:installation", file=sys.stderr)
    payload = json.load(sys.stdin)
    restart_stopped = payload.pop("restartStopped", False)
    apply(payload, restart_stopped)
