#!/usr/bin/env bash
# Bring this fork up to date with pingdotgg/t3code.
#
#   main     mirrors upstream main. Fast-forward only; never commit to it.
#   factory  upstream main plus this fork's own commits.
#
# Run from a clean checkout of the fork branch. Upstream is merged in, the
# fork's own changes are checked against it, and only then is anything pushed.
# A failed check leaves the merge committed locally and unpushed: fix forward
# and rerun.
#
#   scripts/fork-sync.sh             merge, check, push
#   scripts/fork-sync.sh --no-push   merge and check only
#
# FORK_SYNC_TARGET=<commit> merges that upstream commit instead of upstream main. The daily job
# passes the newest T3 Code Nightly release's commit, so the fork's app is that Nightly plus the
# fork's own changes.
set -euo pipefail

UPSTREAM_URL="https://github.com/pingdotgg/t3code.git"
FORK_BRANCH="${FORK_BRANCH:-factory}"
TARGET="${FORK_SYNC_TARGET:-upstream/main}"

die() {
  printf 'fork-sync: %s\n' "$*" >&2
  exit 1
}

push=1
case "${1:-}" in
  "") ;;
  --no-push) push=0 ;;
  *) die "unknown argument '$1' (use --no-push)" ;;
esac

cd "$(git rev-parse --show-toplevel)"

[ "$(git branch --show-current)" = "$FORK_BRANCH" ] ||
  die "switch to '$FORK_BRANCH' first (on '$(git branch --show-current)')"
[ -z "$(git status --porcelain)" ] || die "the working tree has uncommitted changes"

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
git fetch --quiet upstream main
git fetch --quiet origin
git rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null || die "unknown upstream commit '$TARGET'"
git merge-base --is-ancestor "$TARGET" upstream/main || die "'$TARGET' is not on upstream main"
upstream="$(git rev-parse --short "$TARGET")"

git merge-base --is-ancestor origin/main upstream/main ||
  die "origin/main has commits upstream lacks; move them to '$FORK_BRANCH' so main stays a mirror"

# GitHub's "Sync fork" button also moves the fork branch; take that in before upstream.
if git rev-parse --verify --quiet "origin/$FORK_BRANCH" >/dev/null &&
  ! git merge-base --is-ancestor "origin/$FORK_BRANCH" HEAD; then
  printf 'fork-sync: taking in origin/%s\n' "$FORK_BRANCH"
  if ! git merge --no-edit "origin/$FORK_BRANCH"; then
    conflicts="$(git diff --name-only --diff-filter=U)"
    git merge --abort
    die "origin/$FORK_BRANCH conflicts with local commits in:
$conflicts"
  fi
fi

behind="$(git rev-list --count "HEAD..$TARGET")"
if [ "$behind" -gt 0 ]; then
  printf 'fork-sync: merging %s upstream commits (to %s) into %s\n' "$behind" "$upstream" "$FORK_BRANCH"
  if ! git merge --no-edit "$TARGET"; then
    conflicts="$(git diff --name-only --diff-filter=U)"
    git merge --abort
    die "upstream conflicts with fork changes in:
$conflicts"
  fi
else
  printf 'fork-sync: %s already contains upstream %s\n' "$FORK_BRANCH" "$upstream"
fi

# The repository pins an exact Node release; pick it up from nvm when the shell has another.
wanted_node="v$(node -p 'require("./package.json").engines.node' 2>/dev/null || true)"
if [ "$(node --version 2>/dev/null || true)" != "$wanted_node" ]; then
  nvm_bin="${NVM_DIR:-$HOME/.nvm}/versions/node/$wanted_node/bin"
  [ -x "$nvm_bin/node" ] || die "Node $wanted_node is required (have $(node --version 2>/dev/null || echo none))"
  PATH="$nvm_bin:$PATH"
fi
PATH="$PWD/node_modules/.bin:$PATH"
command -v vp >/dev/null 2>&1 || die "vp is not installed; run the repository's install once"

vp i --frozen-lockfile
vp run check:changed "$TARGET" ||
  die "the fork's changes fail checks against upstream $upstream; nothing was pushed"

if [ "$push" -eq 1 ]; then
  git push origin upstream/main:refs/heads/main
  git push origin "$FORK_BRANCH"
  printf 'fork-sync: pushed main and %s at upstream %s\n' "$FORK_BRANCH" "$upstream"
else
  printf 'fork-sync: checks passed at upstream %s; nothing pushed (--no-push)\n' "$upstream"
fi
