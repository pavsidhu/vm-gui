#!/bin/bash
# Installs anything missing (Node.js, Google Cloud CLI, Windows App), signs in to
# Google Cloud, then starts VM GUI. Double-click it in Finder or run it in Terminal.
set -euo pipefail
cd "$(dirname "$0")"

export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/google-cloud-sdk/bin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

download() { curl -fL --progress-bar -o "$1" "$2"; }

# A Python that the Google Cloud CLI supports (3.10 to 3.14)
find_python() {
  for version in 3.14 3.13 3.12 3.11 3.10; do
    for python in "/Library/Frameworks/Python.framework/Versions/$version/bin/python3" "/opt/homebrew/bin/python$version" "/usr/local/bin/python$version"; do
      if [ -x "$python" ]; then echo "$python"; return; fi
    done
  done
}

# Node.js 18+ (checked by running it, since an old Intel-only node can't run on Apple silicon)
node_ok() { [ "$("$1" -p 'process.versions.node.split(".")[0] >= 18' 2>/dev/null)" = true ]; }
NODE=""
for candidate in "$(command -v node || true)" /usr/local/bin/node /opt/homebrew/bin/node; do
  if [ -n "$candidate" ] && node_ok "$candidate"; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  step "Installing Node.js (you may be asked for your Mac password)…"
  pkg="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk '/\.pkg$/ { print $2 }')"
  download "$TMP/node.pkg" "https://nodejs.org/dist/latest-v24.x/$pkg"
  sudo installer -pkg "$TMP/node.pkg" -target /
  NODE=/usr/local/bin/node
fi

# Google Cloud CLI
if ! gcloud --version >/dev/null 2>&1; then
  if [ -z "$(find_python)" ]; then
    step "Installing Python for the Google Cloud CLI (you may be asked for your Mac password)…"
    download "$TMP/python.tar.gz" https://dl.google.com/dl/cloudsdk/channels/rapid/python-3.14.6-macos11.tar.gz
    tar -xzf "$TMP/python.tar.gz" -C "$TMP"
    sudo installer -pkg "$(ls "$TMP"/python-*.pkg)" -target /
  fi

  step "Installing the Google Cloud CLI…"
  arch="$([ "$(uname -m)" = arm64 ] && echo arm || echo x86_64)"
  download "$TMP/gcloud.tar.gz" "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-darwin-$arch.tar.gz"
  tar -xzf "$TMP/gcloud.tar.gz" -C "$HOME"
  CLOUDSDK_PYTHON="$(find_python)" "$HOME/google-cloud-sdk/install.sh" --quiet \
    --usage-reporting=false --path-update=true --command-completion=false --install-python=false
  export PATH="$HOME/google-cloud-sdk/bin:$PATH"
fi

# Windows App, Microsoft's Remote Desktop app
if [ ! -d "/Applications/Windows App.app" ] && [ ! -d "/Applications/Microsoft Remote Desktop.app" ]; then
  step "Installing Windows App (you may be asked for your Mac password)…"
  download "$TMP/windows-app.pkg" "https://go.microsoft.com/fwlink/?linkid=868963"
  sudo installer -pkg "$TMP/windows-app.pkg" -target /
fi

# Google Cloud sign-in
if [ -z "$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null)" ]; then
  step "Sign in to Google Cloud in the browser window that opens…"
  gcloud auth login --brief
fi

step "Starting VM GUI…"
exec "$NODE" server.js
