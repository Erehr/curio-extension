#!/usr/bin/env bash
# Runs the extension's end-to-end check (tools/ext.mjs) on Linux: a debug build of Curio and its sandbox on ext4 copies of both sources, with Chromium.
# From Windows: wsl -d archlinux -u root -- bash ./tools/linux_ext.sh [ext.mjs arguments]
# Curio's checkout is the folder beside this one unless CURIO_APP names another; it needs the build tools from its ./package-linux.sh --install-deps. Installs Chromium when missing.
set -euo pipefail

BUILD_USER=curio-build
ext_dir=$(cd "$(dirname "$0")/.." && pwd)
app_dir=$(cd "${CURIO_APP:-$ext_dir/../app}" && pwd)

if [ "$(id -u)" = 0 ]; then
  command -v chromium >/dev/null || pacman -S --needed --noconfirm chromium
  id "$BUILD_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$BUILD_USER"
  run() { runuser -u "$BUILD_USER" -- env XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/0}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" DISPLAY="${DISPLAY:-:0}" "$@"; }
  home=$(getent passwd "$BUILD_USER" | cut -d: -f6)
else
  run() { "$@"; }
  home=$HOME
fi

dir="$home/.cache/curio-ext"
run mkdir -p "$dir/app" "$dir/extension"
run rsync -a --delete --exclude /target --exclude /dist --exclude /web/node_modules --exclude /dev/node_modules --exclude /shots --exclude /resources/ffmpeg --exclude /.codegraph --exclude /.git "$app_dir/" "$dir/app/"
run rsync -a --delete --exclude /target --exclude /node_modules --exclude /.git "$ext_dir/" "$dir/extension/"
cd "$dir/app"
run cargo build
cd "$dir/extension"
run env CURIO_APP="$dir/app" node tools/ext.mjs "$@"
