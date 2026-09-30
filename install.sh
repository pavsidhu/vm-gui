#!/bin/bash
# Downloads (or updates) VM GUI into ~/vm-gui, then starts it:
#   curl -fsSL https://raw.githubusercontent.com/pavsidhu/vm-gui/main/install.sh | bash
set -euo pipefail

# Wrapped in a function so nothing runs until the whole script has downloaded
main() {
  if curl -fs -o /dev/null --max-time 2 http://localhost:4870/; then
    echo "VM GUI is already running."
    open http://localhost:4870
    exit 0
  fi

  local dir="$HOME/vm-gui"
  if [ -e "$dir" ] && [ ! -f "$dir/start-mac.command" ]; then
    echo "$dir already exists and isn't VM GUI. Move it somewhere else and run this again." >&2
    exit 1
  fi

  echo "Downloading VM GUI…"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL https://github.com/pavsidhu/vm-gui/archive/refs/heads/main.tar.gz | tar -xz -C "$tmp"
  rm -rf "$dir"
  mv "$tmp/vm-gui-main" "$dir"
  rm -rf "$tmp"

  # Read from the terminal, not this download, so password prompts work
  exec bash "$dir/start-mac.command" < /dev/tty
}

main
