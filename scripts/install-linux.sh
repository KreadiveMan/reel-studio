#!/usr/bin/env bash
# One-command Reel Studio install for an Ubuntu/Debian x64 server.
#   curl -fsSL https://raw.githubusercontent.com/KreadiveMan/reel-studio/claude/sleepy-cori-atlhr0/scripts/install-linux.sh | bash
# or, inside an existing clone:  bash scripts/install-linux.sh
# Installs the system packages the studio needs (asks sudo), a pinned portable Node if the system one is older
# than 22.20, then runs the studio's own setup and quick check. Safe to run again: finished steps are skipped.
set -euo pipefail

REPO="${REEL_STUDIO_REPO:-https://github.com/KreadiveMan/reel-studio.git}"
BRANCH="${REEL_STUDIO_BRANCH:-claude/sleepy-cori-atlhr0}"
NODE_VERSION="22.20.0"
NODE_SHA256="00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nXX %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail "Reel Studio on Linux needs an x86_64 (64-bit Intel/AMD) machine."
command -v apt-get >/dev/null || fail "This installer supports Ubuntu/Debian (apt-get). On other systems install git, cmake, a C++ compiler and FFmpeg, then run: node scripts/studio.mjs setup"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then command -v sudo >/dev/null || fail "Run as root or install sudo."; SUDO="sudo"; fi

PACKAGES=(git cmake build-essential ffmpeg curl ca-certificates xz-utils)
MISSING=()
for pkg in "${PACKAGES[@]}"; do dpkg -s "$pkg" >/dev/null 2>&1 || MISSING+=("$pkg"); done
if [ "${#MISSING[@]}" -gt 0 ]; then
  say "Installing system packages: ${MISSING[*]}"
  $SUDO apt-get update -y
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y "${MISSING[@]}"
else
  say "System packages already installed"
fi

# Use the current folder when it is already a studio clone; otherwise clone into REEL_STUDIO_DIR.
if [ -f scripts/studio.mjs ] && [ -f versions.lock.json ]; then
  DIR="$(pwd)"
else
  DIR="${REEL_STUDIO_DIR:-$HOME/ReelStudio}"
  if [ -d "$DIR/.git" ]; then
    say "Studio already in $DIR"
  else
    [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ] && fail "$DIR exists and is not empty; set REEL_STUDIO_DIR to another folder."
    say "Downloading Reel Studio into $DIR"
    git clone -b "$BRANCH" "$REPO" "$DIR"
  fi
fi
cd "$DIR"

node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=20)?0:1)' 2>/dev/null; }
NODE=""
if [ "${REEL_STUDIO_PORTABLE_NODE:-0}" != 1 ] && command -v node >/dev/null && node_ok node; then
  NODE="$(command -v node)"
elif [ -x Tools/node/bin/node ] && node_ok Tools/node/bin/node; then
  NODE="$DIR/Tools/node/bin/node"
else
  say "Installing Node $NODE_VERSION inside the studio (Tools/node)"
  mkdir -p state/downloads Tools
  archive="state/downloads/node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$archive.partial"
  echo "$NODE_SHA256  $archive.partial" | sha256sum -c --quiet - || { rm -f "$archive.partial"; fail "Node download failed its SHA-256 check."; }
  rm -rf Tools/node && mkdir -p Tools/node
  tar -xJf "$archive.partial" -C Tools/node --strip-components 1
  rm -f "$archive.partial"
  NODE="$DIR/Tools/node/bin/node"
fi
say "Using Node $("$NODE" --version) at $NODE"

say "Running studio setup (first time: a few minutes, about 2 GB)"
"$NODE" scripts/studio.mjs setup --foreground

say "Quick check"
"$NODE" scripts/studio.mjs doctor --quick | head -1 || true

cat <<EOF

Reel Studio is installed in: $DIR
Node: $NODE

Next:
  1. Install Claude Code on this server:   curl -fsSL https://claude.ai/install.sh | bash
  2. Start it in the studio folder:        cd "$DIR" && claude
  3. Say «افتح إعداداتي» to save your name and colours, then «افحص النظام».

The settings screen and live editor listen on 127.0.0.1 only. To open them from your own computer, connect with
  ssh -L 4380:127.0.0.1:4380 -L 4381:127.0.0.1:4381 -L 4382:127.0.0.1:4382 <user>@<server>
then keep the dashboard running on the server (it survives logout and reboots) and open the link it prints:
  bash "$DIR/scripts/dashboard-service.sh" install
Dashboard 4382, editor 4380, settings 4381. Optional password: "$NODE" "$DIR/scripts/dashboard.mjs" --set-password
EOF
