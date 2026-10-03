#!/bin/sh
# Build-only hook for an EXISTING deployment orchestrator.
# No fetching, branch selection, credential handling, service restart, proxy edit, cron or webhook.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw Error("Node.js 24+ required")'
npm run check
npm --prefix backend run check
printf '%s\n' 'Release checks passed; dist is ready. Existing orchestrator owns activation, health-check, and rollback.'
