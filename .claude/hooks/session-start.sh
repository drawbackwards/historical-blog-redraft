#!/bin/bash
set -euo pipefail

# Only run in remote Claude Code on the web environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Export ANTHROPIC_API_KEY into the session environment
echo 'export ANTHROPIC_API_KEY=your_api_key_here' >> "$CLAUDE_ENV_FILE"
