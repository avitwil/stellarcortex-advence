#!/bin/sh
# Install Chromium from Debian stable + security on the Ubuntu base, pinned so that
# only the Chromium packages come from Debian. Chromium keeps its sandbox on.
set -eu
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg
curl -fsSL https://ftp-master.debian.org/keys/archive-key-13.asc | gpg --dearmor -o /usr/share/keyrings/debian-13.gpg
curl -fsSL https://ftp-master.debian.org/keys/archive-key-13-security.asc | gpg --dearmor -o /usr/share/keyrings/debian-13-security.gpg
cat > /etc/apt/sources.list.d/debian-chromium.list <<LIST
deb [signed-by=/usr/share/keyrings/debian-13.gpg] https://deb.debian.org/debian trixie main
deb [signed-by=/usr/share/keyrings/debian-13-security.gpg] https://deb.debian.org/debian-security trixie-security main
LIST
cat > /etc/apt/preferences.d/debian-chromium <<PREF
Package: *
Pin: release o=Debian
Pin-Priority: 1

Package: chromium chromium-common chromium-sandbox chromium-l10n
Pin: release o=Debian
Pin-Priority: 500
PREF
apt-get update
apt-get install -y --no-install-recommends chromium chromium-sandbox
rm -rf /var/lib/apt/lists/*
