#!/usr/bin/env bash
# SIGTERM the session omp (not the worker broker) and start it again on the
# same terminal with --continue. Does not send /goal resume.
set -euo pipefail

if [[ ! -x /opt/host-omp/omp ]]; then
  echo "restart-session runs inside imagelxc" >&2
  exit 1
fi

exec python3 - << 'PY'
import ctypes, os, time

def session_pid():
    for line in os.popen("ps -eo pid,cmd").read().splitlines():
        if "/opt/host-omp/omp --continue" in line and "awk" not in line:
            return int(line.split(None, 1)[0])
    return None

pid = session_pid()
if pid is None:
    print("no session omp")
    raise SystemExit(0)

tty = os.readlink(f"/proc/{pid}/fd/0")
if not tty.startswith("/dev/pts/"):
    raise SystemExit(f"unexpected tty {tty}")
index = tty.rsplit("/", 1)[1]
print(f"omp {pid} on {tty}")

master = None
for ent in os.listdir("/proc"):
    if not ent.isdigit():
        continue
    fd_dir = f"/proc/{ent}/fd"
    try:
        fds = os.listdir(fd_dir)
    except PermissionError:
        continue
    for fd in fds:
        try:
            info = open(f"/proc/{ent}/fdinfo/{fd}").read()
            link = os.readlink(f"{fd_dir}/{fd}")
        except OSError:
            continue
        if f"tty-index:\t{index}\n" not in info:
            continue
        if link == tty:
            continue
        master = (int(ent), int(fd))
        break
    if master:
        break
if master is None:
    raise SystemExit(f"no pty master for {tty}")
print(f"master pid {master[0]} fd {master[1]}")

os.kill(pid, 15)
for _ in range(50):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        break
    time.sleep(0.2)
else:
    raise SystemExit("omp still alive")

rc = os.system(f"stty icanon echo icrnl isig < {tty}")
if rc != 0:
    raise SystemExit(f"stty failed {rc}")

libc = ctypes.CDLL(None, use_errno=True)
pidfd = libc.syscall(434, master[0], 0)
if pidfd < 0:
    raise SystemExit(f"pidfd_open {ctypes.get_errno()}")
got = libc.syscall(438, pidfd, master[1], 0)
if got < 0:
    raise SystemExit(f"pidfd_getfd {ctypes.get_errno()}")
os.write(got, b"\x15cd /home/jay/dev/strata/omp && /opt/host-omp/omp --continue --auto-approve --no-title\r")
print("relaunched")
PY
