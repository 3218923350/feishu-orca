#!/bin/bash
# 安装/重启 launchd 常驻服务（改完代码再跑一次就是重启）
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="${FEISHU_ORCA_LABEL:-com.feishu-orca}"
HOME_DIR="${FEISHU_ORCA_HOME:-$HOME/.feishu-orca}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)" || { echo "找不到 node"; exit 1; }
[ -f "$HOME_DIR/config.json" ] || { echo "还没配置：先跑 node bin/setup.mjs"; exit 1; }
[ -d "$DIR/node_modules" ] || (cd "$DIR" && npm install --omit=dev)
mkdir -p "$HOME_DIR"
# launchd 里没有你 shell 的 PATH：把 node、claude、orca、lark-cli 所在目录带上
P="$(dirname "$NODE"):$HOME/.local/bin:/Applications/Orca.app/Contents/Resources/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
for b in claude lark-cli orca; do d="$(dirname "$(command -v $b 2>/dev/null || echo /x/x)")"; [ "$d" != /x ] && P="$d:$P"; done

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/bridge.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/launchd.err.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$P</string>
    <key>HOME</key><string>$HOME</string>
    <key>FEISHU_ORCA_HOME</key><string>$HOME_DIR</string>
    <key>LANG</key><string>zh_CN.UTF-8</string>
  </dict>
</dict></plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && sleep 2 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl print "gui/$(id -u)/$LABEL" | grep -E 'state|pid' | head -3
echo "日志: tail -f $HOME_DIR/bridge.log"
