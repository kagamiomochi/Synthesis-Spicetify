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

Only the Python standard library is used. Python 3.9+ and git are required.

Usage:
  python wisp_ondemand.py install     # setup + register autostart (Linux / macOS / Windows)
  python wisp_ondemand.py uninstall   # remove autostart and stop the backend
  python wisp_ondemand.py setup       # only clone libcurl.js and prepare the venv
  python wisp_ondemand.py run         # run the launcher in the foreground
"""

import argparse
import asyncio
import ctypes
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
LIBCURL_REPO = "https://github.com/ading2210/libcurl.js"
HOST = "127.0.0.1"
IS_WINDOWS = os.name == "nt"


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def default_libcurl_dir():
    if IS_WINDOWS:
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / APP_NAME / "libcurl.js"


def server_dir(libcurl_dir):
    return libcurl_dir / "server" / "wisp_server"


def venv_python(libcurl_dir):
    venv = server_dir(libcurl_dir) / ".venv"
    return venv / ("Scripts/python.exe" if IS_WINDOWS else "bin/python")


def state_dir(libcurl_dir):
    # Logs and the pid file live next to the libcurl.js checkout.
    return libcurl_dir.parent


def pid_file(libcurl_dir):
    return state_dir(libcurl_dir) / "wisp-backend.pid"


# ---------------------------------------------------------------------------
# Setup: clone libcurl.js and prepare the Python virtual environment
# ---------------------------------------------------------------------------

def run_checked(cmd):
    print("+ " + subprocess.list2cmdline([str(c) for c in cmd]), flush=True)
    subprocess.check_call([str(c) for c in cmd])


def ensure_checkout(libcurl_dir):
    if (server_dir(libcurl_dir) / "pyproject.toml").is_file():
        return
    if shutil.which("git") is None:
        raise SystemExit("git is required to clone libcurl.js.")
    if libcurl_dir.exists() and any(libcurl_dir.iterdir()):
        if (libcurl_dir / ".git").exists():
            # A clone made without --recursive lacks the Wisp server submodule.
            run_checked(["git", "-C", libcurl_dir, "submodule", "update",
                         "--init", "--depth", "1", "--recursive"])
        else:
            raise SystemExit(f"{libcurl_dir} exists but is not a libcurl.js git clone.")
    else:
        libcurl_dir.parent.mkdir(parents=True, exist_ok=True)
        run_checked(["git", "clone", "--depth", "1", "--recurse-submodules",
                     "--shallow-submodules", LIBCURL_REPO, libcurl_dir])
    if not (server_dir(libcurl_dir) / "pyproject.toml").is_file():
        raise SystemExit(f"The Wisp server was not found in {libcurl_dir}.")


def ensure_venv(libcurl_dir):
    python = venv_python(libcurl_dir)
    if not python.is_file():
        try:
            run_checked([sys.executable, "-m", "venv", server_dir(libcurl_dir) / ".venv"])
        except subprocess.CalledProcessError:
            raise SystemExit("Failed to create the Python virtual environment. "
                             "On Debian/Ubuntu, install the python3-venv package and try again.")
    probe = subprocess.run([str(python), "-c", "import wisp.server.cli"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if probe.returncode != 0:
        run_checked([python, "-m", "pip", "install", "-e", server_dir(libcurl_dir)])


def cmd_setup(args):
    ensure_checkout(args.libcurl_dir)
    ensure_venv(args.libcurl_dir)
    print(f"Wisp server is ready in {args.libcurl_dir}")


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

    def __init__(self, libcurl_dir, port, startup_timeout):
        self.libcurl_dir = libcurl_dir
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
        python = venv_python(self.libcurl_dir)
        if not python.is_file():
            raise RuntimeError(f"{python} not found. Run: wisp_ondemand.py setup")
        cmd = [str(python), "-m", "wisp.server", "--host", HOST, "--port", str(self.port),
               "--log-level", "warning"]
        kwargs = {}
        if IS_WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        else:
            # One worker is plenty for a single local user (the default is one per CPU core).
            # Not passed on Windows: the server only supports the option where SO_REUSEPORT
            # exists, and elsewhere it calls logging.warn(), which Python 3.13 removed.
            cmd += ["--threads", "1"]
            # Own process group, so that worker processes can be stopped together with it.
            kwargs["start_new_session"] = True
        log_path = state_dir(self.libcurl_dir) / "wisp-backend.log"
        logging.info("starting the Wisp server on %s:%d", HOST, self.port)
        with open(log_path, "wb") as log:
            self.proc = await asyncio.create_subprocess_exec(
                *cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, **kwargs)
        pid_file(self.libcurl_dir).write_text(str(self.proc.pid))

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
            pid_file(self.libcurl_dir).unlink(missing_ok=True)
            return
        if IS_WINDOWS:
            # The venv python.exe is a redirector that starts the real interpreter
            # as a child, so the whole process tree has to be killed.
            kill_tree_windows(proc.pid)
        else:
            signal_group(proc.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(proc.wait(), 5)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
        if not IS_WINDOWS:
            # Worker processes may outlive the parent for a moment and keep the port open.
            signal_group(proc.pid, signal.SIGKILL)
        pid_file(self.libcurl_dir).unlink(missing_ok=True)


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
    backend = Backend(args.libcurl_dir, args.backend_port, args.startup_timeout)
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


def setup_logging(libcurl_dir):
    state_dir(libcurl_dir).mkdir(parents=True, exist_ok=True)
    handlers = [logging.handlers.RotatingFileHandler(
        state_dir(libcurl_dir) / "wisp-ondemand.log", maxBytes=256 * 1024, backupCount=1,
        encoding="utf-8")]
    # pythonw.exe has no console, so only log to stderr when there is a terminal.
    if sys.stderr is not None and sys.stderr.isatty():
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, handlers=handlers,
                        format="%(asctime)s %(levelname)s %(message)s")


def cmd_run(args):
    setup_logging(args.libcurl_dir)
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
    return ["run", "--libcurl-dir", str(args.libcurl_dir),
            "--listen-port", str(args.listen_port), "--backend-port", str(args.backend_port),
            "--idle-minutes", str(args.idle_minutes)] + list(extra)


def macos_plist_path():
    return Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"


def macos_plist(args):
    script = [sys.executable, str(Path(__file__).resolve())]
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
    arguments = subprocess.list2cmdline([str(Path(__file__).resolve())] + run_arguments(args))
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
    pid_path = pid_file(args.libcurl_dir)
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
    python = venv_python(args.libcurl_dir)
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
ExecStart={systemd_quote(python)} -m wisp.server --host {HOST} --port {args.backend_port} --log-level warning --threads 1
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
        install_macos(args)
    elif IS_WINDOWS:
        cmd_setup(args)
        install_windows(args)
    elif sys.platform.startswith("linux"):
        proxyd = check_linux(args)
        cmd_setup(args)
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
        p.add_argument("--libcurl-dir", type=Path, default=default_libcurl_dir(),
                       help="Where libcurl.js (with its Wisp server) is or will be cloned.")
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
    args.libcurl_dir = args.libcurl_dir.expanduser().resolve()
    args.func(args)


if __name__ == "__main__":
    main()
