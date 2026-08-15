#!/usr/bin/env bash
# Standalone test for the WSL2 -> Windows toast channel (no DSH required).
#
# Usage:
#   ./scripts/test-toast.sh "标题" "正文"
#
# Requirements: WSL2 with interop enabled (default), powershell.exe on PATH,
# iconv + base64 (preinstalled on Ubuntu).
set -euo pipefail

TITLE="${1:-DSH 通知测试}"
BODY="${2:-来自 WSL 的测试通知}"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

T=$(xml_escape "$TITLE")
B=$(xml_escape "$BODY")

PS=$(cat <<EOF
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
\$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
\$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
\$xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">${T}</text><text id="2">${B}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>')
\$toast = New-Object Windows.UI.Notifications.ToastNotification \$xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(\$appId).Show(\$toast)
EOF
)

B64=$(printf '%s' "$PS" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)
powershell.exe -NoProfile -NonInteractive -EncodedCommand "$B64"
echo "toast sent: ${TITLE} / ${BODY}"
