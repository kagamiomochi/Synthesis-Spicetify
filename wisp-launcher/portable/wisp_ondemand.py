#!/usr/bin/env python3
"""Cross-platform on-demand launcher for the Wisp server used by Synthesis Spotify.

It listens on 127.0.0.1:6001 and starts the real Wisp server (127.0.0.1:6002) when
the first connection arrives. Connections are forwarded to the backend, and the
backend is stopped again after it has been idle for a while. Spotify keeps
connecting to ws://localhost:6001/ as usual.

The setup is the same on every OS (Linux, macOS, Windows): run "install" once.

- Linux: systemd user units. systemd owns the listening socket and uses
  systemd-socket-proxyd to forward connections, so nothing runs until the first connection.
- macOS: a LaunchAgent with launchd socket activation, so nothing runs until the first
  connection, and the launcher exits again when idle.
- Windows: a scheduled task starts a small launcher process at login, and only the Wisp
  server is started on demand.

The launcher itself only uses the Python standard library (3.9+). The Wisp server is
wisp-js (Node.js), installed with npm, so Node.js 22.18+ (or 24.11+) and npm are required.

Usage:
  python wisp_ondemand.py install     # setup + register autostart (Linux / macOS / Windows)
  python wisp_ondemand.py uninstall   # remove autostart and stop the backend
  python wisp_ondemand.py setup       # only install wisp-js with npm
  python wisp_ondemand.py run         # run the launcher in the foreground
"""

import argparse
import asyncio
import ctypes
import json
import logging
import logging.handlers
import os
import plistlib
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from xml.sax.saxutils import escape

APP_NAME = "synthesis-spotify"
TASK_NAME = "SynthesisSpotifyWisp"
LAUNCHD_LABEL = "io.github.kagamiomochi.synthesis-spotify-wisp"
WISP_PACKAGE = "@mercuryworkshop/wisp-js"
WISP_VERSION = "0.5.3"  # pinned; bump deliberately
HOST = "127.0.0.1"
IS_WINDOWS = os.name == "nt"


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def default_install_dir():
    if IS_WINDOWS:
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / APP_NAME / "wisp-js"


def package_dir(install_dir):
    return install_dir / "node_modules" / "@mercuryworkshop" / "wisp-js"


def entry_script(install_dir):
    return package_dir(install_dir) / "src" / "bin" / "server_cli.mjs"


def state_dir(install_dir):
    # Logs and the pid file live next to the wisp-js directory.
    return install_dir.parent


def pid_file(install_dir):
    return state_dir(install_dir) / "wisp-backend.pid"


def fixed_script_path(install_dir):
    # The autostart entries (launchd, Task Scheduler) record the path of this script,
    # so it has to live at a path that never changes.
    return state_dir(install_dir) / "wisp_ondemand.py"


def install_self(install_dir):
    """Copy this script to its fixed path and return that path.

    Autostart entries must not point at a download folder or a clone that may be moved
    or deleted. Does nothing when this script already is the fixed copy.
    """
    source = Path(__file__).resolve()
    target = fixed_script_path(install_dir)
    if target.exists() and os.path.samefile(source, target):
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    # Copy to a temporary name first, so an interrupted copy never leaves a broken script.
    tmp = target.with_name(target.name + ".tmp")
    shutil.copyfile(source, tmp)
    os.replace(tmp, target)
    print(f"Copied this script to {target}")
    return target


# ---------------------------------------------------------------------------
# Setup: install wisp-js with npm
# ---------------------------------------------------------------------------

def run_checked(cmd):
    print("+ " + subprocess.list2cmdline([str(c) for c in cmd]), flush=True)
    subprocess.check_call([str(c) for c in cmd])


def node_version(node):
    try:
        out = subprocess.run([str(node), "--version"], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, timeout=20).stdout
        return tuple(int(part) for part in out.strip().lstrip("v").split(".")[:3])
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def node_supported(version):
    # wisp-js (through its dependencies) needs Node.js ^22.18.0 || >=24.11.0.
    major, minor = version[0], version[1]
    return (major == 22 and minor >= 18) or (major == 24 and minor >= 11) or major >= 25


def find_node(explicit=None):
    """Return the absolute path of a usable Node.js binary."""
    found = str(explicit) if explicit else shutil.which("node")
    if not found:
        raise SystemExit("Node.js was not found. Install Node.js 22.18+ (or 24.11+), "
                         "or pass --node PATH.")
    version = node_version(found)
    if version is None:
        raise SystemExit(f"Could not run `{found} --version`.")
    if not node_supported(version):
        raise SystemExit(f"Node.js {'.'.join(map(str, version))} is not supported by wisp-js. "
                         "Install Node.js 22.18+ (or 24.11+), or pass --node PATH.")
    return Path(os.path.abspath(found))


def installed_version(install_dir):
    try:
        data = json.loads((package_dir(install_dir) / "package.json").read_text(encoding="utf-8"))
        return data.get("version")
    except (OSError, ValueError):
        return None


def ensure_install(install_dir):
    if entry_script(install_dir).is_file() and installed_version(install_dir) == WISP_VERSION:
        return
    npm = shutil.which("npm")
    if npm is None:
        raise SystemExit("npm was not found. It comes with Node.js; install it and try again.")
    install_dir.mkdir(parents=True, exist_ok=True)
    run_checked([npm, "install", "--prefix", install_dir, f"{WISP_PACKAGE}@{WISP_VERSION}",
                 "--save-exact", "--omit=dev", "--no-audit", "--no-fund"])
    if not entry_script(install_dir).is_file():
        raise SystemExit(f"The Wisp server was not found in {install_dir} after npm install.")


def cmd_setup(args):
    # Resolved once and recorded in the autostart entries, because launchd, Task Scheduler
    # and systemd do not see the PATH of an interactive shell.
    args.node = find_node(args.node)
    ensure_install(args.install_dir)
    print(f"Wisp server (wisp-js {WISP_VERSION}) is ready in {args.install_dir}")
    print(f"Node.js: {args.node}")


# ---------------------------------------------------------------------------
# launchd socket activation (macOS)
# ---------------------------------------------------------------------------

def launchd_sockets(name):
    """Return the listening sockets launchd opened for the plist key Sockets/<name>."""
    lib = ctypes.CDLL(None)  # launch_activate_socket lives in libSystem
    lib.launch_activate_socket.argtypes = [
        ctypes.c_char_p, ctypes.POINTER(ctypes.POINTER(ctypes.c_int)),
        ctypes.POINTER(ctypes.c_size_t)]
    lib.launch_activate_socket.restype = ctypes.c_int
    lib.free.argtypes = [ctypes.c_void_p]
    fds = ctypes.POINTER(ctypes.c_int)()
    count = ctypes.c_size_t()
    rc = lib.launch_activate_socket(name.encode(), ctypes.byref(fds), ctypes.byref(count))
    if rc != 0:
        raise OSError(rc, f"launch_activate_socket({name!r}) failed; "
                          "this mode only works when started by launchd")
    try:
        return [socket.socket(fileno=fds[i]) for i in range(count.value)]
    finally:
        lib.free(ctypes.cast(fds, ctypes.c_void_p))


# ---------------------------------------------------------------------------
# The on-demand proxy
# ---------------------------------------------------------------------------

async def port_open(port):
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(HOST, port), 1)
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    return True


class Backend:
    """Owns the real Wisp server process."""

    def __init__(self, install_dir, node, port, startup_timeout):
        self.install_dir = install_dir
        self.node = node
        self.port = port
        self.startup_timeout = startup_timeout
        self.proc = None
        self.lock = asyncio.Lock()

    def running(self):
        return self.proc is not None and self.proc.returncode is None

    async def ensure_running(self):
        async with self.lock:
            if self.running():
                return
            if await port_open(self.port):
                # Something (e.g. an orphan from a crashed launcher) already serves the port.
                logging.warning("port %d is already in use, using that server as is", self.port)
                return
            await self._start()

    async def _start(self):
        entry = entry_script(self.install_dir)
        if not entry.is_file():
            raise RuntimeError(f"{entry} not found. Run: wisp_ondemand.py setup")
        cmd = [str(self.node), str(entry), "-H", HOST, "-P", str(self.port), "-L", "WARN"]
        kwargs = {}
        if IS_WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        else:
            # Own process group, so that it can be stopped together with any children.
            kwargs["start_new_session"] = True
        log_path = state_dir(self.install_dir) / "wisp-backend.log"
        logging.info("starting the Wisp server on %s:%d", HOST, self.port)
        with open(log_path, "wb") as log:
            self.proc = await asyncio.create_subprocess_exec(
                *cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, **kwargs)
        pid_file(self.install_dir).write_text(str(self.proc.pid))

        deadline = time.monotonic() + self.startup_timeout
        while time.monotonic() < deadline:
            if self.proc.returncode is not None:
                raise RuntimeError(f"the Wisp server exited with code {self.proc.returncode} "
                                   f"(see {log_path})")
            if await port_open(self.port):
                return
            await asyncio.sleep(0.2)
        await self._stop()
        raise RuntimeError("the Wisp server did not start in time")

    async def stop_if_idle(self, is_idle):
        async with self.lock:
            if self.running() and is_idle():
                logging.info("idle, stopping the Wisp server")
                await self._stop()

    async def stop(self):
        async with self.lock:
            await self._stop()

    async def _stop(self):
        proc, self.proc = self.proc, None
        if proc is None or proc.returncode is not None:
            pid_file(self.install_dir).unlink(missing_ok=True)
            return
        if IS_WINDOWS:
            # Kill the whole process tree, in case the server left children behind.
            kill_tree_windows(proc.pid)
        else:
            signal_group(proc.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
        if not IS_WINDOWS:
            # Make sure nothing outlives the parent and keeps the port open.
            signal_group(proc.pid, signal.SIGKILL)
        pid_file(self.install_dir).unlink(missing_ok=True)


def signal_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def kill_tree_windows(pid):
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   creationflags=subprocess.CREATE_NO_WINDOW)


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (OSError, asyncio.IncompleteReadError):
        pass


async def close_writer(writer):
    try:
        writer.close()
        await writer.wait_closed()
    except OSError:
        pass


class Proxy:
    def __init__(self, backend, backend_port, idle_seconds, exit_event=None):
        self.backend = backend
        self.backend_port = backend_port
        self.idle_seconds = idle_seconds
        # When set, the whole launcher exits once idle (launchd starts it again on demand).
        self.exit_event = exit_event
        self.active = 0
        self.last_activity = time.monotonic()

    async def handle(self, reader, writer):
        self.active += 1
        backend_writer = None
        try:
            await self.backend.ensure_running()
            backend_reader, backend_writer = await asyncio.open_connection(HOST, self.backend_port)
            tasks = [asyncio.ensure_future(pipe(reader, backend_writer)),
                     asyncio.ensure_future(pipe(backend_reader, writer))]
            # When either side closes, tear down both directions.
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
        except Exception as exc:  # keep the launcher alive whatever happens to one connection
            logging.warning("connection failed: %s", exc)
        finally:
            self.active -= 1
            self.last_activity = time.monotonic()
            await close_writer(writer)
            if backend_writer is not None:
                await close_writer(backend_writer)

    async def watch_idle(self):
        interval = min(10.0, max(1.0, self.idle_seconds / 4))
        while True:
            await asyncio.sleep(interval)
            if self.active == 0 and time.monotonic() - self.last_activity >= self.idle_seconds:
                await self.backend.stop_if_idle(lambda: self.active == 0)
                if self.exit_event is not None and self.active == 0:
                    logging.info("idle, exiting; launchd starts the launcher again on demand")
                    self.exit_event.set()


async def serve(args):
    backend = Backend(args.install_dir, args.node, args.backend_port, args.startup_timeout)
    stop_event = asyncio.Event()
    if args.launchd_socket:
        proxy = Proxy(backend, args.backend_port, args.idle_minutes * 60, exit_event=stop_event)
        servers = [await asyncio.start_server(proxy.handle, sock=sock)
                   for sock in launchd_sockets(args.launchd_socket)]
        logging.info("using %d socket(s) from launchd (backend port %d, idle %.1f min)",
                     len(servers), args.backend_port, args.idle_minutes)
    else:
        proxy = Proxy(backend, args.backend_port, args.idle_minutes * 60)
        servers = [await asyncio.start_server(proxy.handle, HOST, args.listen_port)]
        logging.info("listening on %s:%d (backend port %d, idle %.1f min)",
                     HOST, args.listen_port, args.backend_port, args.idle_minutes)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass  # Windows: Ctrl+C is handled by asyncio.run instead

    watcher = asyncio.ensure_future(proxy.watch_idle())
    try:
        await stop_event.wait()
    finally:
        watcher.cancel()
        for server in servers:
            server.close()
        await backend.stop()


def setup_logging(install_dir):
    state_dir(install_dir).mkdir(parents=True, exist_ok=True)
    handlers = [logging.handlers.RotatingFileHandler(
        state_dir(install_dir) / "wisp-ondemand.log", maxBytes=256 * 1024, backupCount=1,
        encoding="utf-8")]
    # pythonw.exe has no console, so only log to stderr when there is a terminal.
    if sys.stderr is not None and sys.stderr.isatty():
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, handlers=handlers,
                        format="%(asctime)s %(levelname)s %(message)s")


def cmd_run(args):
    args.node = find_node(args.node)
    setup_logging(args.install_dir)
    try:
        asyncio.run(serve(args))
    except OSError as exc:
        logging.error("cannot listen on %s:%d: %s", HOST, args.listen_port, exc)
        raise SystemExit(1)
    except KeyboardInterrupt:
        pass


# ---------------------------------------------------------------------------
# Autostart: launchd (macOS) and Task Scheduler (Windows)
# ---------------------------------------------------------------------------

def run_arguments(args, extra=()):
    return ["run", "--install-dir", str(args.install_dir), "--node", str(args.node),
            "--listen-port", str(args.listen_port), "--backend-port", str(args.backend_port),
            "--idle-minutes", str(args.idle_minutes)] + list(extra)


def macos_plist_path():
    return Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"


def macos_plist(args):
    script = [sys.executable, str(args.script)]
    if args.resident:
        # Fallback: a launcher that stays resident and only starts the Wisp server on demand.
        return {
            "Label": LAUNCHD_LABEL,
            "ProgramArguments": script + run_arguments(args),
            "RunAtLoad": True,
            "KeepAlive": True,
            "ThrottleInterval": 10,
            "ProcessType": "Background",
        }
    # Socket activation: launchd owns the port and starts the launcher on the first connection.
    # There is no RunAtLoad/KeepAlive, so the launcher may exit when idle.
    return {
        "Label": LAUNCHD_LABEL,
        "ProgramArguments": script + run_arguments(args, ["--launchd-socket", "Listeners"]),
        "Sockets": {
            "Listeners": {
                "SockNodeName": HOST,
                "SockServiceName": str(args.listen_port),
                "SockFamily": "IPv4",
                "SockType": "stream",
            },
        },
        "ProcessType": "Background",
    }


def install_macos(args):
    plist = macos_plist(args)
    path = macos_plist_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        plistlib.dump(plist, f)
    domain = f"gui/{os.getuid()}"
    # Reload if it was installed before; ignore the error when it was not loaded.
    subprocess.run(["launchctl", "bootout", f"{domain}/{LAUNCHD_LABEL}"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run_checked(["launchctl", "bootstrap", domain, path])


def uninstall_macos(args):
    domain = f"gui/{os.getuid()}"
    # SIGTERM lets the launcher stop the backend cleanly.
    subprocess.run(["launchctl", "bootout", f"{domain}/{LAUNCHD_LABEL}"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    macos_plist_path().unlink(missing_ok=True)


def windows_user():
    name = os.environ.get("USERNAME", "")
    domain = os.environ.get("USERDOMAIN", "")
    return f"{domain}\\{name}" if domain else name


def install_windows(args):
    python = Path(sys.executable)
    pythonw = python.with_name("pythonw.exe")  # no console window
    command = str(pythonw if pythonw.is_file() else python)
    arguments = subprocess.list2cmdline([str(args.script)] + run_arguments(args))
    user = escape(windows_user())
    xml = f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{escape(command)}</Command>
      <Arguments>{escape(arguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
"""
    with tempfile.TemporaryDirectory() as tmp:
        xml_path = Path(tmp) / "task.xml"
        xml_path.write_text(xml, encoding="utf-16")
        run_checked(["schtasks", "/Create", "/TN", TASK_NAME, "/XML", xml_path, "/F"])
    run_checked(["schtasks", "/Run", "/TN", TASK_NAME])


def uninstall_windows(args):
    quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    subprocess.run(["schtasks", "/End", "/TN", TASK_NAME], **quiet)
    subprocess.run(["schtasks", "/Delete", "/TN", TASK_NAME, "/F"], **quiet)
    # Ending the task kills the launcher without letting it stop the backend.
    pid_path = pid_file(args.install_dir)
    if pid_path.is_file():
        pid = pid_path.read_text().strip()
        if pid.isdigit():
            kill_tree_windows(int(pid))
        pid_path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Autostart: systemd user units (Linux)
# ---------------------------------------------------------------------------

SYSTEMD_SOCKET = f"{APP_NAME}-wisp-proxy.socket"
SYSTEMD_PROXY = f"{APP_NAME}-wisp-proxy.service"
SYSTEMD_BACKEND = f"{APP_NAME}-wisp-backend.service"
# The always-on example unit from old versions of the README. It would occupy the port.
SYSTEMD_LEGACY = f"{APP_NAME}-wisp.service"


def systemd_unit_dir():
    config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return config / "systemd" / "user"


def systemctl(*cmd, check=True):
    full = ["systemctl", "--user", *cmd]
    if check:
        run_checked(full)
    elif shutil.which("systemctl") is not None:
        subprocess.run(full, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def systemd_quote(value):
    """Quote one word of an ExecStart= line."""
    text = str(value).replace("\\", "\\\\").replace('"', '\\"')
    text = text.replace("%", "%%").replace("$", "$$")
    return f'"{text}"'


def find_socket_proxyd():
    for candidate in ("/usr/lib/systemd/systemd-socket-proxyd",
                      "/lib/systemd/systemd-socket-proxyd"):
        if os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which("systemd-socket-proxyd")
    if found:
        return found
    raise SystemExit("systemd-socket-proxyd was not found.")


def check_linux(args):
    """Check the prerequisites before the (slow) setup. Returns the proxyd path."""
    if shutil.which("systemctl") is None:
        raise SystemExit("systemctl was not found. Without systemd, run "
                         "`wisp_ondemand.py run` yourself, for example from your session's autostart.")
    legacy = subprocess.run(["systemctl", "--user", "is-enabled", SYSTEMD_LEGACY],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if legacy.returncode == 0:
        raise SystemExit(f"{SYSTEMD_LEGACY} is enabled and would conflict on port "
                         f"{args.listen_port}.\n  systemctl --user disable --now {SYSTEMD_LEGACY}")
    return find_socket_proxyd()


def linux_units(args, proxyd):
    """Return {unit file name: content} for the socket-activated setup."""
    node = systemd_quote(args.node)
    entry = systemd_quote(entry_script(args.install_dir))
    idle = max(1, round(args.idle_minutes * 60))
    # Report "started" only once the port accepts connections, so the proxy never
    # connects to a server that is still booting. ($$ is a literal $ in unit files.)
    wait = (f"for i in $$(seq 150); do (exec 3<>/dev/tcp/{HOST}/{args.backend_port}) "
            "2>/dev/null && exit 0; sleep 0.2; done; exit 1")
    backend = f"""[Unit]
Description=Wisp server for Synthesis Spotify (backend on {HOST}:{args.backend_port})
# Stop as soon as the proxy service that needs this unit is gone.
StopWhenUnneeded=yes

[Service]
ExecStart={node} {entry} -H {HOST} -P {args.backend_port} -L WARN
ExecStartPost=/usr/bin/env bash -c '{wait}'
"""
    proxy = f"""[Unit]
Description=Wisp proxy for Synthesis Spotify (starts the backend on demand)
Requires={SYSTEMD_BACKEND}
After={SYSTEMD_BACKEND}

[Service]
# Exits after being idle, which in turn stops the backend (StopWhenUnneeded).
ExecStart={systemd_quote(proxyd)} --exit-idle-time={idle}s {HOST}:{args.backend_port}
"""
    socket_unit = f"""[Unit]
Description=Wisp socket for Synthesis Spotify ({HOST}:{args.listen_port})

[Socket]
ListenStream={HOST}:{args.listen_port}

[Install]
WantedBy=sockets.target
"""
    return {SYSTEMD_BACKEND: backend, SYSTEMD_PROXY: proxy, SYSTEMD_SOCKET: socket_unit}


def install_linux(args, proxyd):
    unit_dir = systemd_unit_dir()
    unit_dir.mkdir(parents=True, exist_ok=True)
    for name, content in linux_units(args, proxyd).items():
        (unit_dir / name).write_text(content, encoding="utf-8")
    systemctl("daemon-reload")
    # Stop old instances first, so that a re-install picks up new settings.
    systemctl("stop", SYSTEMD_SOCKET, SYSTEMD_PROXY, SYSTEMD_BACKEND, check=False)
    systemctl("enable", "--now", SYSTEMD_SOCKET)
    print(f"Logs: journalctl --user -u {SYSTEMD_BACKEND} -u {SYSTEMD_PROXY}")


def uninstall_linux(args):
    systemctl("disable", "--now", SYSTEMD_SOCKET, check=False)
    systemctl("stop", SYSTEMD_PROXY, SYSTEMD_BACKEND, check=False)
    for name in (SYSTEMD_BACKEND, SYSTEMD_PROXY, SYSTEMD_SOCKET):
        (systemd_unit_dir() / name).unlink(missing_ok=True)
    systemctl("daemon-reload", check=False)


def cmd_install(args):
    if sys.platform == "darwin":
        cmd_setup(args)
        args.script = install_self(args.install_dir)
        install_macos(args)
    elif IS_WINDOWS:
        cmd_setup(args)
        args.script = install_self(args.install_dir)
        install_windows(args)
    elif sys.platform.startswith("linux"):
        proxyd = check_linux(args)
        cmd_setup(args)
        # The systemd units do not reference this script, but keep the same fixed copy
        # on every OS so that `run` can always be started from the same path.
        args.script = install_self(args.install_dir)
        install_linux(args, proxyd)
    else:
        raise SystemExit(f"Unsupported platform: {sys.platform}. "
                         "Run `wisp_ondemand.py run` yourself.")
    print(f"Installed. The launcher listens on {HOST}:{args.listen_port} "
          "and starts the Wisp server on the first connection.")


def cmd_uninstall(args):
    if sys.platform == "darwin":
        uninstall_macos(args)
    elif IS_WINDOWS:
        uninstall_windows(args)
    elif sys.platform.startswith("linux"):
        uninstall_linux(args)
    else:
        raise SystemExit(f"Unsupported platform: {sys.platform}.")
    print("Removed the autostart entry and stopped the launcher.")


def main():
    parser = argparse.ArgumentParser(description="On-demand Wisp launcher for Synthesis Spotify")
    sub = parser.add_subparsers(dest="command", required=True)
    commands = {"run": cmd_run, "setup": cmd_setup, "install": cmd_install,
                "uninstall": cmd_uninstall}
    for name, func in commands.items():
        p = sub.add_parser(name)
        p.set_defaults(func=func)
        p.add_argument("--install-dir", type=Path, default=default_install_dir(),
                       help="Where wisp-js is or will be installed with npm.")
        if name in ("run", "setup", "install"):
            p.add_argument("--node", type=Path, default=None,
                           help="Node.js binary to use (default: node from PATH).")
        if name in ("run", "install"):
            p.add_argument("--listen-port", type=int, default=6001)
            p.add_argument("--backend-port", type=int, default=6002)
            p.add_argument("--idle-minutes", type=float, default=5.0)
        if name == "run":
            p.add_argument("--startup-timeout", type=float, default=30.0)
            p.add_argument("--launchd-socket", metavar="NAME",
                           help="macOS: take the listening socket from launchd (plist key "
                                "Sockets/NAME) and exit when idle.")
        if name == "install":
            p.add_argument("--resident", action="store_true",
                           help="macOS: keep the launcher resident instead of using launchd "
                                "socket activation.")
    args = parser.parse_args()
    args.install_dir = args.install_dir.expanduser().resolve()
    args.func(args)


if __name__ == "__main__":
    main()
