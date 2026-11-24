#!/usr/bin/env bash
# 乐享其约 · 设备预约 APK —— 纯本地构建（aapt2 + javac + d8 + apksigner），无 Gradle 依赖
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
SDK=${SDK:-/home/user/build/sdk}
JDK=${JDK:-/home/user/build/jdk}
BT="$SDK/build-tools/36.0.0"
AJ="$SDK/platforms/android-36/android.jar"
OUT="$ROOT/build"
DIST="$ROOT/dist"
export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$PATH"

echo "== 清理 =="
rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT/res" "$DIST"

echo "== 资源编译 =="
"$BT/aapt2" compile --dir "$ROOT/src/res" -o "$OUT/res/res.zip"

echo "== 组装 assets =="
rm -rf "$OUT/assets"
mkdir -p "$OUT/assets"
cp "$ROOT/assets/index.html" "$ROOT/assets/style.css" "$ROOT/assets/devices.js" "$OUT/assets/"
if [ -f "$ROOT/assets/config.js" ]; then
  cp "$ROOT/assets/config.js" "$OUT/assets/config.js"
fi
if [ -f "$ROOT/src/h5/app.part1.js" ]; then
  cat "$ROOT"/src/h5/app.part*.js > "$OUT/assets/app.js"
else
  cp "$ROOT/assets/app.js" "$OUT/assets/app.js"
fi

echo "== 资源链接 + 打包 assets =="
"$BT/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$AJ" \
  --manifest "$ROOT/src/AndroidManifest.xml" \
  -R "$OUT/res/res.zip" \
  --java "$OUT/gen" \
  --auto-add-overlay \
  -A "$OUT/assets" \
  --min-sdk-version 26 \
  --target-sdk-version 36 \
  --version-code 5 \
  --version-name 1.0.4

echo "== Java 编译 =="
find "$ROOT/src/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
"$JDK/bin/javac" --release 8 -classpath "$AJ" -d "$OUT/classes" @"$OUT/sources.txt" -Xlint:-options

echo "== dex =="
"$BT/d8" --min-api 26 --lib "$AJ" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')

echo "== 组装 APK =="
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT" && zip -q -j unsigned.apk dex/classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "== 签名 =="
KS="$ROOT/keystore/jr-debug.keystore"
if [ ! -f "$KS" ]; then
  mkdir -p "$ROOT/keystore"
  "$JDK/bin/keytool" -genkeypair -keystore "$KS" -alias jrdebug \
    -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 36500 \
    -dname "CN=JoyReserve Board, O=Personal, C=CN" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias jrdebug --out "$DIST/joyreserve-board-1.0.4.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$DIST/joyreserve-board-1.0.4.apk"

echo "== 产出 =="
ls -lh "$DIST/joyreserve-board-1.0.4.apk"
"$BT/aapt2" dump badging "$DIST/joyreserve-board-1.0.4.apk" | head -8
