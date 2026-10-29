#!/usr/bin/env bash
# One-line installer for production-backend (Mac and Linux):
#   curl -fsSL https://raw.githubusercontent.com/ahujakush/skills/main/install.sh | bash
# Uses the skills CLI when Node.js is available (so installs show on skills.sh),
# and falls back to a direct download when it isn't.
set -u

REPO="ahujakush/skills"
SKILL="production-backend"

say() { printf '%s\n' "$*"; }

# Agents to install for: Claude Code always, others when they're on this machine.
AGENTS=(-a claude-code)
[ -d "$HOME/.codex" ] && AGENTS+=(-a codex)
[ -d "$HOME/.cursor" ] && AGENTS+=(-a cursor)
[ -d "$HOME/.gemini" ] && AGENTS+=(-a antigravity)

node_ok() {
  # usage: node_ok <min major> <min minor>
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${v%%.*}"; minor="$(printf '%s' "$v" | cut -d. -f2)"
  [ -n "$major" ] || return 1
  [ "$major" -gt "$1" ] || { [ "$major" -eq "$1" ] && [ "${minor:-0}" -ge "$2" ]; }
}

# The skills CLI clones the repo with git. On a Mac without Xcode Command Line Tools,
# /usr/bin/git is only a stub that opens an install dialog, so check before calling it.
git_ok() {
  if [ "$(uname)" = "Darwin" ]; then xcode-select -p >/dev/null 2>&1 || return 1; fi
  command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1
}

install_with_cli() {
  say "→ Installing with the skills CLI ($1)…"
  npx -y "$1" add "$REPO" --skill "$SKILL" -g "${AGENTS[@]}" -y && return 0
  # A cache left owned by root (after an old `sudo npm`) makes npx fail with EACCES: retry once with a fresh one.
  say "  The skills CLI failed, retrying with a fresh npm cache…"
  npm_config_cache="$(mktemp -d)" npx -y "$1" add "$REPO" --skill "$SKILL" -g "${AGENTS[@]}" -y
}

install_direct() {
  say "→ Installing by direct download…"
  local tmp; tmp="$(mktemp -d)"
  if ! curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xz -C "$tmp"; then
    say "✗ Download failed. Check your internet connection and try again."; rm -rf "$tmp"; return 1
  fi
  local src="$tmp/skills-main/skills/$SKILL"
  local targets=("$HOME/.claude/skills")
  [ -d "$HOME/.codex" ] && targets+=("$HOME/.agents/skills")
  [ -d "$HOME/.cursor" ] && targets+=("$HOME/.cursor/skills")
  [ -d "$HOME/.gemini" ] && targets+=("$HOME/.gemini/antigravity/skills")
  for t in "${targets[@]}"; do
    mkdir -p "$t" && rm -rf "${t:?}/$SKILL" && cp -R "$src" "$t/$SKILL" && say "  ✓ $t/$SKILL"
  done
  rm -rf "$tmp"
}

if ! git_ok; then
  say "git isn't available (on a Mac: Xcode Command Line Tools aren't installed), so skipping the skills CLI."
  install_direct
elif node_ok 22 20; then
  install_with_cli "skills@latest" || install_direct
elif node_ok 18 0; then
  say "Node $(node -v) found (the latest skills CLI needs 22.20+), using skills@1.5.18."
  install_with_cli "skills@1.5.18" || install_direct
else
  say "Node.js 18+ not found, so skipping the skills CLI."
  install_direct
fi || { say "✗ Install failed."; exit 1; }

say ""
say "✓ production-backend installed. Restart Claude Code (or your agent) and ask:"
say '  "make my backend production ready"'
