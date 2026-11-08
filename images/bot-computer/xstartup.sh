#!/bin/sh
# Xfce session for the bot desktop.
unset SESSION_MANAGER
export XDG_SESSION_TYPE=x11
exec dbus-launch --exit-with-session startxfce4
