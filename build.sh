#!/usr/bin/env bash
# 乐享其约 · 设备预约 APK —— 纯本地构建（aapt2 + javac + d8 + apksigner），无 Gradle 依赖
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
APP_NAME=${APP_NAME:-joyreserve-board}
VERSION=${VERSION:-1.0.5}
VERSION_CODE=${VERSION_CODE:-6}
SDK=${SDK:-/home/user/build/sdk}
JDK=${JDK:-/home/user/build/jdk}
CI=${CI:-0}
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

CFG="$ROOT/assets/config.js"
if [ ! -f "$CFG" ]; then
  if [ "$CI" = "1" ]; then
    cp "$ROOT/assets/config.example.js" "$CFG"
    echo "CI 模式：使用 config.example.js"
  else
    echo "缺少 assets/config.js。请先执行：cp assets/config.example.js assets/config.js，并填写真实账号。" >&2
    exit 1
  fi
fi
cp "$CFG" "$OUT/assets/config.js"
if [ "$CI" != "1" ]; then
  if ! grep -Eq 'phone[[:space:]]*:[[:space:]]*"[^"]+"' "$CFG" \
    || ! grep -Eq 'password[[:space:]]*:[[:space:]]*"[^"]+"' "$CFG"; then
    echo "assets/config.js 中 phone 或 password 为空；CI 编译可用示例配置，正式 APK 不允许这样打包。" >&2
    exit 1
  fi
fi

if [ -f "$ROOT/src/h5/app.part1.js" ]; then
  cat "$ROOT"/src/h5/app.part*.js > "$OUT/assets/app.js"
else
  cp "$ROOT/assets/app.js" "$OUT/assets/app.js"
fi
if command -v node >/dev/null 2>&1; then
  node --check "$OUT/assets/app.js"
else
  echo "未找到 node，跳过 app.js 语法检查"
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
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION"

echo "== Java 编译 =="
find "$ROOT/src/java" "$OUT/gen" -name '*.java' | sort > "$OUT/sources.txt"
"$JDK/bin/javac" --release 8 -classpath "$AJ" -d "$OUT/classes" @"$OUT/sources.txt" -Xlint:-options

echo "== dex =="
mapfile -t CLASS_FILES < <(find "$OUT/classes" -name '*.class' | sort)
"$BT/d8" --min-api 26 --lib "$AJ" --output "$OUT/dex" "${CLASS_FILES[@]}"

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
APK="$DIST/${APP_NAME}-${VERSION}.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias jrdebug --out "$APK" "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$APK"

echo "== 产出 =="
ls -lh "$APK"
"$BT/aapt2" dump badging "$APK" | head -10
