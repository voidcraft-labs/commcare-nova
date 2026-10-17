#!/usr/bin/env bash
# What one Android emulator system image's own decoders make of Nova's media fixtures.
#
#   proof/android/decode/run.sh <avd>
#
# Boots <avd> without a window, prints the image's build fingerprint first (`FINGERPRINT <value>`), pushes
# lib/media/__tests__/fixtures/ and the BMP files lib/media/__tests__/bmpFixtures.ts builds, and prints one JSON
# line per file: the decoder that read it and the frames it decoded, or why it was refused
# (proof/android/decode/DecodeProbe.java). It needs an Apple-silicon Mac with the Android SDK's emulator, a
# platform's android.jar, build-tools' d8 and the arm64 system image the AVD is made from; run it from the
# worktree root, where `npx tsx` finds Nova's node_modules. proof/android/decode/probe.py runs it over the three
# images the lane's media formats were played on.
set -euo pipefail

avd="${1:?Usage: proof/android/decode/run.sh <avd>}"
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
port="${PROOF_DECODE_PORT:-5580}"
serial="emulator-$port"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/proof-android-decode.XXXXXX")"
adb="$sdk/platform-tools/adb"

cleanup() {
  "$adb" -s "$serial" emu kill >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

platform="$(ls -d "$sdk"/platforms/android-* | sort -V | tail -n 1)"
build_tools="$(ls -d "$sdk"/build-tools/* | sort -V | tail -n 1)"
mkdir -p "$work/classes" "$work/files"
javac --release 11 -cp "$platform/android.jar" -d "$work/classes" "$here/DecodeProbe.java"
"$build_tools/d8" --min-api 23 --lib "$platform/android.jar" --output "$work" "$work/classes/DecodeProbe.class"

cp "$root"/lib/media/__tests__/fixtures/* "$work/files/"
(cd "$root" && npx tsx --eval "import('./lib/media/__tests__/bmpFixtures.ts').then((m) => m.writeBuiltBmps(process.argv[1]))" "$work/files")

"$sdk/emulator/emulator" -avd "$avd" -port "$port" -no-window -no-audio -no-snapshot -no-boot-anim \
  >"$work/emulator.log" 2>&1 &
"$adb" -s "$serial" wait-for-device
until [ "$("$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  sleep 2
done

echo "FINGERPRINT $("$adb" -s "$serial" shell getprop ro.build.fingerprint | tr -d '\r')"
"$adb" -s "$serial" shell rm -rf /data/local/tmp/decode
"$adb" -s "$serial" push "$work/classes.dex" /data/local/tmp/decode-probe.dex >/dev/null
"$adb" -s "$serial" push "$work/files" /data/local/tmp/decode >/dev/null
"$adb" -s "$serial" shell CLASSPATH=/data/local/tmp/decode-probe.dex app_process /system/bin DecodeProbe \
  /data/local/tmp/decode | tr -d '\r'
