#!/bin/sh
# Bundle the server into ONE file so end users only need a Node runtime (no npm install).
set -e
npx tsc --noEmit
npx --yes esbuild@0.24.0 src/index.ts --bundle --platform=node --format=esm --target=node18 \
  --external:bufferutil --external:utf-8-validate \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" \
  --outfile=server/supreme.mjs --log-level=warning
echo "bundled -> server/supreme.mjs"
