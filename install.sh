#!/bin/sh
# Install the latest OpenDM release on Linux or macOS:
#   curl -fsSL https://raw.githubusercontent.com/Chanthul4054/download-manager/main/install.sh | sh
set -eu

REPO=Chanthul4054/download-manager
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Pick the release asset whose name ends in $1.
asset_url() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
    grep -o '"browser_download_url": *"[^"]*'"$1"'"' | head -n 1 | sed 's/.*"\(https[^"]*\)"/\1/'
}

fetch() {
  url=$(asset_url "$1")
  [ -n "$url" ] || { echo "No $1 file in the latest release." >&2; exit 1; }
  echo "Downloading $url"
  curl -fL --progress-bar -o "$tmp/$2" "$url"
}

case "$(uname -s)" in
  Linux)
    [ "$(uname -m)" = x86_64 ] || { echo "Only x86_64 Linux builds are published." >&2; exit 1; }
    if command -v apt-get >/dev/null 2>&1; then
      fetch .deb opendm.deb
      sudo apt-get install -y "$tmp/opendm.deb"
    else
      fetch .AppImage OpenDM.AppImage
      mkdir -p "$HOME/.local/bin"
      install -m 755 "$tmp/OpenDM.AppImage" "$HOME/.local/bin/opendm"
      echo "Installed to ~/.local/bin/opendm"
    fi
    ;;
  Darwin)
    fetch .dmg OpenDM.dmg
    mnt=$(hdiutil attach -nobrowse -readonly "$tmp/OpenDM.dmg" | awk -F'\t' '/\/Volumes\//{print $NF; exit}')
    rm -rf /Applications/OpenDM.app
    cp -R "$mnt/OpenDM.app" /Applications/
    hdiutil detach "$mnt" -quiet
    # The app is unsigned; drop the quarantine flag so Gatekeeper lets it open.
    xattr -dr com.apple.quarantine /Applications/OpenDM.app 2>/dev/null || true
    echo "Installed to /Applications/OpenDM.app"
    ;;
  *)
    echo "On Windows, download OpenDM-Setup-<version>.exe from https://github.com/$REPO/releases/latest" >&2
    exit 1
    ;;
esac
