#!/usr/bin/env bash
# Ссылает dev-копию Pi-пакетов на глобальную установку Pi, чтобы работали
# `tsc --noEmit` и тесты без npm-копий хостовых пакетов (см. docs/packages.md:
# хостовые пакеты нельзя класть в dependencies).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
groot="$(npm root -g)"
agent="$groot/@earendil-works/pi-coding-agent"

if [[ ! -d "$agent" ]]; then
  echo "Не найден $agent. Установи Pi: npm i -g @earendil-works/pi-coding-agent" >&2
  exit 1
fi

# pi-tui лежит либо рядом, либо внутри node_modules установленного Pi.
tui=""
for candidate in "$groot/@earendil-works/pi-tui" "$agent/node_modules/@earendil-works/pi-tui"; do
  if [[ -d "$candidate" ]]; then tui="$candidate"; break; fi
done

if [[ -z "$tui" ]]; then
  echo "Не найден @earendil-works/pi-tui ни в $groot, ни в $agent/node_modules" >&2
  exit 1
fi

mkdir -p "$root/node_modules/@earendil-works"
ln -sfn "$agent" "$root/node_modules/@earendil-works/pi-coding-agent"
ln -sfn "$tui" "$root/node_modules/@earendil-works/pi-tui"

echo "linked pi-coding-agent -> $agent"
echo "linked pi-tui          -> $tui"
