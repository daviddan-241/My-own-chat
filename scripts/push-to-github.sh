#!/usr/bin/env bash
set -e

TOKEN="${GITHUB_PERSONAL_ACCESS_TOKEN}"
if [ -z "$TOKEN" ]; then
  echo "ERROR: GITHUB_PERSONAL_ACCESS_TOKEN is not set."
  exit 1
fi

REMOTE_URL="https://${TOKEN}@github.com/daviddan-241/My-own-chat.git"
REPO="https://github.com/daviddan-241/My-own-chat.git"
API="https://api.github.com/repos/daviddan-241/My-own-chat"
TEMP_BRANCH="_sync_$(date +%s)"

echo "Creating clean orphan snapshot..."
ORIG_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

git checkout --orphan "$TEMP_BRANCH"
git add -A
git -c user.email="agent@replit.com" -c user.name="Replit Agent" \
  commit -m "MyAI Gateway — unrestricted mode, better image gen, rate-limit fallback"

echo "Pushing clean snapshot to temp branch $TEMP_BRANCH ..."
git push --force "$REMOTE_URL" "$TEMP_BRANCH:$TEMP_BRANCH"

echo "Updating main via GitHub API..."
SHA=$(git rev-parse "$TEMP_BRANCH")

# Try to update main ref via API (force)
curl -s -X PATCH "$API/git/refs/heads/main" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"sha\": \"$SHA\", \"force\": true}" | grep -E '"ref"|"sha"|"message"' | head -5

# Delete the temp branch
curl -s -X DELETE "$API/git/refs/heads/$TEMP_BRANCH" \
  -H "Authorization: Bearer $TOKEN"

echo "Cleaning up local..."
git checkout "$ORIG_BRANCH"
git branch -D "$TEMP_BRANCH"

echo "Done! Code is live at $REPO"
