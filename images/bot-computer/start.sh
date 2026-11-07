#!/bin/bash
# Bot computer entrypoint: TigerVNC (loopback inside the container) + Xfce + websockify/noVNC.
set -euo pipefail
GEOMETRY="${BOT_GEOMETRY:-1600x900}"
mkdir -p "$HOME/.vnc" "$HOME/workspace" "$HOME/.local/bin"
umask 077
# The VNC password is injected at start as a secret file; it is never in the image (FR-CODE-05).
if [ -r /run/secrets/vnc_password ]; then
  vncpasswd -f < /run/secrets/vnc_password > "$HOME/.vnc/passwd"
  SEC=(-SecurityTypes VncAuth -PasswordFile "$HOME/.vnc/passwd")
else
  echo "bot-computer: no VNC password secret; refusing to start an open VNC server" >&2
  exit 64
fi
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xtigervnc :1 -geometry "$GEOMETRY" -depth 24 -rfbport 5901 -localhost=1 -AlwaysShared \
  -FrameRate=60 -CompareFB=1 "${SEC[@]}" &
XPID=$!
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
DISPLAY=:1 /usr/local/bin/bot-computer-xstartup >/tmp/xsession.log 2>&1 &
websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5901 >/tmp/websockify.log 2>&1 &
WPID=$!
echo "bot-computer: ready" >&2
wait -n "$XPID" "$WPID"
