#!/usr/bin/env node
// Sets up the local Wisp server (wisp-js) for Synthesis Spicetify and starts it at login.
//
//   node setup-wisp.mjs install [--port 6001]   install wisp-js with npm and register autostart
//   node setup-wisp.mjs uninstall               remove autostart and stop the server
//
// Needs Node.js 22.12+ (npm comes with it). Autostart: systemd (Linux), launchd (macOS),
// Task Scheduler (Windows). This script is not needed after the install.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const NAME = "synthesis-spicetify";
const WISP_PACKAGE = "@mercuryworkshop/wisp-js";
const WISP_VERSION = "0.5.3"; // pinned; bump deliberately
const HOST = "127.0.0.1";
const UNIT = `${NAME}-wisp.service`;
const LAUNCHD_LABEL = "io.github.kagamiomochi.synthesis-spicetify-wisp";
const TASK_NAME = "SynthesisSpicetifyWisp";

// Leftovers of the old socket-activated / Python launcher setup.
const OLD_UNITS = [`${NAME}-wisp-proxy.socket`, `${NAME}-wisp-proxy.service`, `${NAME}-wisp-backend.service`];
const OLD_FILES = ["wisp_ondemand.py", "wisp-ondemand.log", "wisp-backend.log", "wisp-backend.pid"];

const home = os.homedir();
const win = process.platform === "win32";
const dataDir = path.join(
  win ? (process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")) : (process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share")),
  NAME,
);
const installDir = path.join(dataDir, "wisp-js");
const packageDir = path.join(installDir, "node_modules", ...WISP_PACKAGE.split("/"));
const entry = path.join(packageDir, "src", "bin", "server_cli.mjs");

const die = (message) => {
  console.error(message);
  process.exit(1);
};

// Runs a program. With check=false, failures are ignored and the output is hidden.
function run(cmd, args, check = true) {
  if (check) console.log(`+ ${[cmd, ...args].join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: check ? "inherit" : "ignore" });
  if (check && result.status !== 0) die(`Command failed: ${cmd}`);
  return result.status === 0;
}

const quiet = (cmd, args) => run(cmd, args, false);
const unlink = (file) => fs.rmSync(file, { force: true });

function installedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function installWisp() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) die(`Node.js ${process.versions.node} is too old. Install Node.js 22.12 or newer.`);
  if (installedVersion() === WISP_VERSION && fs.existsSync(entry)) return;

  fs.mkdirSync(installDir, { recursive: true });
  // One command string so that npm(.cmd) also works on Windows. --ignore-scripts avoids a native build step.
  const command = `npm install --prefix "${installDir}" ${WISP_PACKAGE}@${WISP_VERSION} --ignore-scripts --no-audit --no-fund`;
  console.log(`+ ${command}`);
  if (spawnSync(command, { shell: true, stdio: "inherit" }).status !== 0) die("npm install failed. Is npm installed?");
  if (!fs.existsSync(entry)) die(`The Wisp server was not found in ${installDir} after npm install.`);
}

// ---------------------------------------------------------------------------
// Linux: systemd user unit
// ---------------------------------------------------------------------------

const unitDir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "systemd", "user");
const systemctl = (...args) => run("systemctl", ["--user", ...args]);
const systemctlQuiet = (...args) => quiet("systemctl", ["--user", ...args]);

// Quotes one word of an ExecStart= line.
const systemdQuote = (s) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

function removeUnits(names) {
  for (const name of names) {
    if (!fs.existsSync(path.join(unitDir, name))) continue;
    systemctlQuiet("disable", "--now", name);
    unlink(path.join(unitDir, name));
  }
  systemctlQuiet("daemon-reload");
}

function installLinux(command) {
  if (!quiet("systemctl", ["--version"])) {
    console.log(`systemd was not found. Start the server yourself, for example from your session's autostart:\n  ${command.join(" ")}`);
    return;
  }
  removeUnits(OLD_UNITS);
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(
    path.join(unitDir, UNIT),
    `[Unit]
Description=Wisp server for Synthesis Spicetify

[Service]
ExecStart=${command.map(systemdQuote).join(" ")}
Restart=on-failure

[Install]
WantedBy=default.target
`,
  );
  systemctl("daemon-reload");
  systemctl("enable", UNIT);
  systemctl("restart", UNIT); // also picks up new settings on a re-install
  console.log(`Logs: journalctl --user -u ${UNIT}`);
}

// ---------------------------------------------------------------------------
// macOS: LaunchAgent
// ---------------------------------------------------------------------------

const plistPath = path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const launchdTarget = () => `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function installMacos(command) {
  const log = path.join(dataDir, "wisp.log");
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((word) => `    <string>${escapeXml(word)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict>
</plist>
`,
  );
  quiet("launchctl", ["bootout", launchdTarget()]); // replaces an older install, ignored when not loaded
  // bootout can return before the job is gone, and bootstrap then fails; retry briefly.
  for (let i = 0; i < 5; i++) {
    if (quiet("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath])) return;
    sleep(500);
  }
  run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath]); // last try, with its error shown
  console.log(`Log: ${log}`);
}

// ---------------------------------------------------------------------------
// Windows: scheduled task that runs at login
// ---------------------------------------------------------------------------

function stopWindows() {
  quiet("schtasks", ["/End", "/TN", TASK_NAME]);
  // The old launcher left its Wisp server running when its task was ended.
  const pidFile = path.join(dataDir, "wisp-backend.pid");
  if (fs.existsSync(pidFile)) quiet("taskkill", ["/PID", fs.readFileSync(pidFile, "utf8").trim(), "/T", "/F"]);
}

function installWindows(command) {
  stopWindows();
  const user = escapeXml(process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME);
  // PowerShell with a hidden window, so that no console window stays open.
  const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
  const psCommand = `& ${command.map(psQuote).join(" ")}`;
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>${escapeXml(`-NoProfile -NonInteractive -WindowStyle Hidden -Command "${psCommand}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
  const xmlPath = path.join(os.tmpdir(), `${TASK_NAME}.xml`);
  // schtasks wants UTF-16 with a byte order mark.
  fs.writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
  try {
    run("schtasks", ["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]);
  } finally {
    unlink(xmlPath);
  }
  run("schtasks", ["/Run", "/TN", TASK_NAME]);
}

// ---------------------------------------------------------------------------

function install(port) {
  installWisp();
  const command = [process.execPath, entry, "-H", HOST, "-P", String(port), "-L", "WARN"];
  if (process.platform === "darwin") installMacos(command);
  else if (win) installWindows(command);
  else if (process.platform === "linux") installLinux(command);
  else die(`Unsupported platform: ${process.platform}. Start the server yourself:\n  ${command.join(" ")}`);
  for (const file of OLD_FILES) unlink(path.join(dataDir, file));
  console.log(`Installed. The Wisp server starts at login and listens on ws://localhost:${port}/`);
  console.log("The Node.js path is recorded now, so run install again after moving or replacing Node.js.");
}

function uninstall() {
  if (process.platform === "darwin") {
    quiet("launchctl", ["bootout", launchdTarget()]);
    unlink(plistPath);
  } else if (win) {
    stopWindows();
    quiet("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
  } else if (process.platform === "linux") {
    removeUnits([UNIT, ...OLD_UNITS]);
  }
  console.log("Removed the autostart entry and stopped the server.");
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { port: { type: "string", default: "6001" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) die(`Invalid port: ${values.port}`);

if (positionals[0] === "install") install(port);
else if (positionals[0] === "uninstall") uninstall();
else die("Usage: node setup-wisp.mjs install [--port 6001] | uninstall");
