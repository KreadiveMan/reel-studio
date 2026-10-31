#!/usr/bin/env bash
# Keeps the studio dashboard running on a Linux server as a systemd user service: it starts on boot, restarts
# after a crash, and keeps running after you close SSH. Only this user's account is involved (no root service).
#   bash scripts/dashboard-service.sh install | restart | stop | status | logs | link | uninstall
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="reel-studio-dashboard.service"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"

node_bin() {
  if [ -x "$DIR/Tools/node/bin/node" ]; then echo "$DIR/Tools/node/bin/node"; else command -v node || { echo "Node is missing; run bash scripts/install-linux.sh first." >&2; exit 1; }; fi
}
claude_bin() {
  command -v claude && return
  for candidate in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /usr/local/bin/claude; do [ -x "$candidate" ] && { echo "$candidate"; return; }; done
  echo "Claude Code is not installed for this user (curl -fsSL https://claude.ai/install.sh | bash)." >&2; exit 1
}
need_systemd() { command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 || { echo "systemd user services are not available here; run the dashboard with nohup instead (see instructions/SETUP.md)." >&2; exit 1; }; }

case "${1:-}" in
  install)
    need_systemd
    NODE="$(node_bin)"; CLAUDE="$(claude_bin)"
    mkdir -p "$(dirname "$UNIT_FILE")"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Reel Studio dashboard
After=network.target

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/scripts/dashboard.mjs --port 4382
Environment=REEL_STUDIO_CLAUDE=$CLAUDE
Environment=PATH=$(dirname "$CLAUDE"):$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT"
    # Without lingering, user services stop when the last SSH session closes.
    if ! loginctl enable-linger "$USER" 2>/dev/null; then
      echo "Note: to keep it running after you log out, run once: sudo loginctl enable-linger $USER"
    fi
    sleep 2
    systemctl --user --no-pager status "$UNIT" | head -5 || true
    echo; echo "Dashboard link:"; "$NODE" "$DIR/scripts/dashboard.mjs" --link
    ;;
  restart) need_systemd; systemctl --user restart "$UNIT"; echo "restarted" ;;
  stop) need_systemd; systemctl --user stop "$UNIT"; echo "stopped" ;;
  status) need_systemd; systemctl --user --no-pager status "$UNIT" ;;
  logs) need_systemd; journalctl --user -u "$UNIT" -n 80 --no-pager ;;
  link) "$(node_bin)" "$DIR/scripts/dashboard.mjs" --link ;;
  uninstall)
    need_systemd
    systemctl --user disable --now "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_FILE"; systemctl --user daemon-reload; echo "removed"
    ;;
  *) echo "Usage: bash scripts/dashboard-service.sh install|restart|stop|status|logs|link|uninstall" >&2; exit 2 ;;
esac
