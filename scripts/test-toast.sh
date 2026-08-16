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
DSH_URL="${DSH_URL:-http://127.0.0.1:3080}"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

# The XML is embedded in a PowerShell single-quoted string, so apostrophes
# must be doubled (' -> '') or the script fails to parse.
ps_quote() {
  printf '%s' "$1" | sed -e "s/'/''/g"
}

T=$(ps_quote "$(xml_escape "$TITLE")")
B=$(ps_quote "$(xml_escape "$BODY")")
L=$(ps_quote "$(xml_escape "$DSH_URL")")

PS=$(cat <<EOF
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
\$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
\$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
\$xml.LoadXml('<toast activationType="protocol" launch="${L}"><visual><binding template="ToastGeneric"><text id="1">${T}</text><text id="2">${B}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/><actions><action content="打开 DSH" activationType="protocol" arguments="${L}"/></actions></toast>')
\$toast = New-Object Windows.UI.Notifications.ToastNotification \$xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(\$appId).Show(\$toast)
EOF
)

B64=$(printf '%s' "$PS" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)
# WSL interop can leave powershell.exe waiting on an inherited stdin; close it.
powershell.exe -NoProfile -NonInteractive -EncodedCommand "$B64" </dev/null
echo "toast sent: ${TITLE} / ${BODY}"
