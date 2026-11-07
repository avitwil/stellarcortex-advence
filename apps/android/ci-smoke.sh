#!/usr/bin/env bash
# Emulator smoke test for the Android shell (FR-CLI-02): installs the APK, starts it,
# and checks that the app stays up, loads the bundled UI, and has backups disabled.
set -euo pipefail
APK="$1"
PKG=com.stellarcortex.advence
adb wait-for-device
adb install -r "$APK"
adb logcat -c
# Stream only the tags we check, so noisy system logs cannot evict them from the ring buffer.
adb logcat -v brief 'Capacitor:*' 'AndroidRuntime:E' '*:S' > logcat.txt &
LOGCAT=$!
adb shell am start -W -n "$PKG/.MainActivity"
sleep 15
pid="$(adb shell pidof "$PKG" || true)"
kill "$LOGCAT" 2>/dev/null || true
if [ -z "$pid" ]; then echo "app is not running"; tail -200 logcat.txt; exit 1; fi
if grep -q "FATAL EXCEPTION" logcat.txt; then echo "app crashed"; grep -A30 "FATAL EXCEPTION" logcat.txt; exit 1; fi
# Capacitor logging is off in this build, so check the rendered UI tree instead: the bundled
# UI's first screen must be on screen (WebView content is exposed to UI Automator).
ok=""
for _ in 1 2 3 4 5 6; do
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true
  if adb shell cat /sdcard/ui.xml 2>/dev/null | grep -q "Connect to your server"; then ok=1; break; fi
  sleep 5
done
[ -n "$ok" ] || { echo "bundled UI not loaded"; adb shell cat /sdcard/ui.xml | head -c 4000; tail -50 logcat.txt; exit 1; }
adb shell dumpsys activity activities | grep -q "$PKG/.MainActivity" || { echo "activity not shown"; exit 1; }
# Backups are disabled so device keys cannot leave the device (NFR-SEC-02).
adb shell dumpsys package "$PKG" | grep -q "ALLOW_BACKUP" && { echo "backup must be disabled"; exit 1; }
echo "android smoke ok (pid $pid)"
