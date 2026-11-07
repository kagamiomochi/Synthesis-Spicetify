#!/usr/bin/env bash
# Install socket-activated Wisp units for the current user (systemd).
#
# systemd listens on 127.0.0.1:6001. The first connection starts the real Wisp
# server on 127.0.0.1:6002 and the connection is forwarded to it. After 5 idle
# minutes both stop again. Nothing in Spotify has to launch anything.
#
# libcurl.js (which contains the Wisp server) is cloned automatically when it is
# not at the given path yet.
#
# Usage: ./install.sh [path/to/libcurl.js]

set -eu

HERE="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
LIBCURL_DIR="${1:-$HOME/.local/share/synthesis-spotify/libcurl.js}"
RUN_SH="$LIBCURL_DIR/server/run.sh"
LIBCURL_REPO="https://github.com/ading2210/libcurl.js"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

# Clone libcurl.js together with its Wisp server submodule if it is not there yet.
if [ ! -e "$LIBCURL_DIR" ] || { [ -d "$LIBCURL_DIR" ] && [ -z "$(ls -A "$LIBCURL_DIR")" ]; }; then
  command -v git >/dev/null 2>&1 || { echo "git is required to clone libcurl.js." >&2; exit 1; }
  echo "Cloning libcurl.js into $LIBCURL_DIR ..."
  mkdir -p "$(dirname "$LIBCURL_DIR")"
  git clone --depth 1 --recurse-submodules --shallow-submodules "$LIBCURL_REPO" "$LIBCURL_DIR"
fi

if [ ! -f "$RUN_SH" ]; then
  echo "server/run.sh was not found at: $RUN_SH" >&2
  echo "That directory exists but does not look like libcurl.js." >&2
  exit 1
fi

# A clone made without --recursive lacks the Wisp server submodule.
if [ ! -f "$LIBCURL_DIR/server/wisp_server/pyproject.toml" ]; then
  if [ -e "$LIBCURL_DIR/.git" ]; then
    echo "Fetching the Wisp server submodule ..."
    git -C "$LIBCURL_DIR" submodule update --init --depth 1 --recursive
  else
    echo "The Wisp server submodule is missing and $LIBCURL_DIR is not a git clone." >&2
    exit 1
  fi
fi
RUN_SH="$(realpath "$RUN_SH")"
chmod +x "$RUN_SH"

PROXYD=""
for candidate in /usr/lib/systemd/systemd-socket-proxyd /lib/systemd/systemd-socket-proxyd; do
  [ -x "$candidate" ] && PROXYD="$candidate" && break
done
if [ -z "$PROXYD" ]; then
  echo "systemd-socket-proxyd was not found." >&2
  exit 1
fi

# The older always-on example service from the README would occupy port 6001.
if systemctl --user is-enabled synthesis-spotify-wisp.service >/dev/null 2>&1; then
  echo "Note: synthesis-spotify-wisp.service is enabled and would conflict on port 6001." >&2
  echo "  systemctl --user disable --now synthesis-spotify-wisp.service" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
sed "s|@RUN_SH@|$RUN_SH|" "$HERE/synthesis-spotify-wisp-backend.service.in" >"$UNIT_DIR/synthesis-spotify-wisp-backend.service"
sed "s|@PROXYD@|$PROXYD|" "$HERE/synthesis-spotify-wisp-proxy.service.in" >"$UNIT_DIR/synthesis-spotify-wisp-proxy.service"
cp "$HERE/synthesis-spotify-wisp-proxy.socket.in" "$UNIT_DIR/synthesis-spotify-wisp-proxy.socket"

systemctl --user daemon-reload
systemctl --user enable --now synthesis-spotify-wisp-proxy.socket

echo "Installed. The socket is listening on 127.0.0.1:6001; the server starts on the first connection."
echo "Run $RUN_SH once by hand so the Python virtualenv is created."
echo "Status: systemctl --user status synthesis-spotify-wisp-proxy.socket synthesis-spotify-wisp-backend.service"
