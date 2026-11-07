#!/usr/bin/env bash
# Emulator smoke test for the Android shell (FR-CLI-02): installs the APK, starts it,
# and checks that the app stays up, loads the bundled UI, and has backups disabled.
set -euo pipefail
APK="$1"
PKG=com.stellarcortex.advence
adb wait-for-device
adb install -r "$APK"
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity"
sleep 15
pid="$(adb shell pidof "$PKG" || true)"
adb logcat -d > logcat.txt || true
if [ -z "$pid" ]; then echo "app is not running"; tail -200 logcat.txt; exit 1; fi
if grep -q "FATAL EXCEPTION" logcat.txt; then echo "app crashed"; grep -A30 "FATAL EXCEPTION" logcat.txt; exit 1; fi
grep -q "Loading app at https://localhost" logcat.txt || { echo "bundled UI not loaded"; grep -i capacitor logcat.txt | tail -50; exit 1; }
adb shell dumpsys activity activities | grep -q "$PKG/.MainActivity" || { echo "activity not shown"; exit 1; }
# Backups are disabled so device keys cannot leave the device (NFR-SEC-02).
adb shell dumpsys package "$PKG" | grep -q "ALLOW_BACKUP" && { echo "backup must be disabled"; exit 1; }
echo "android smoke ok (pid $pid)"
