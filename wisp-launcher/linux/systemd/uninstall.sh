#!/usr/bin/env bash
# Remove the socket-activated Wisp units installed by install.sh.

set -eu

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

systemctl --user disable --now synthesis-spotify-wisp-proxy.socket 2>/dev/null || true
systemctl --user stop synthesis-spotify-wisp-proxy.service synthesis-spotify-wisp-backend.service 2>/dev/null || true
rm -f "$UNIT_DIR/synthesis-spotify-wisp-backend.service" \
  "$UNIT_DIR/synthesis-spotify-wisp-proxy.service" \
  "$UNIT_DIR/synthesis-spotify-wisp-proxy.socket"
systemctl --user daemon-reload
echo "Removed the socket-activated Wisp units."
