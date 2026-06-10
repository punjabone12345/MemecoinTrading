#!/bin/bash
set -e

if [ -z "$GITHUB_TOKEN" ]; then
  echo "❌  GITHUB_TOKEN secret is not set. Add it in the Secrets tab first."
  exit 1
fi

REMOTE="https://punjabone12345:${GITHUB_TOKEN}@github.com/punjabone12345/MemecoinTrading.git"

echo "🔧  Setting authenticated remote..."
git remote set-url origin "$REMOTE"

echo "⬆️   Pushing to GitHub..."
git push origin main

echo "🔒  Restoring clean remote URL..."
git remote set-url origin "https://github.com/punjabone12345/MemecoinTrading.git"

echo "✅  Done! Changes pushed to GitHub."
