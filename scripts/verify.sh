#!/usr/bin/env bash
# Проверка проекта: типы + смоук-тесты. Запуск: npm test
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

[[ -e node_modules/@earendil-works/pi-tui ]] || bash scripts/dev-setup.sh

if [[ ! -d node_modules/typescript ]]; then
  echo "==> нет devDependencies, ставлю npm i"
  npm install --no-audit --no-fund
fi

echo "==> синтаксис расширения"
node --experimental-strip-types --check extensions/copy-code-blocks.ts

echo "==> типы (tsc --noEmit)"
node node_modules/typescript/bin/tsc --noEmit

echo "==> тесты (node --test)"
node --experimental-strip-types --test test/*.test.ts

echo "==> ок"
