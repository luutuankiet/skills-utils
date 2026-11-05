#!/usr/bin/env bash
#
# peek.sh -- another repository's Level 0, from outside it.
#
#   peek.sh <path> [<path> ...]
#
# A session only ever preloads the context of the directory it was spawned in.
# When it has to reason about a repository next door, it otherwise pays for a
# directory listing plus several speculative reads before it knows what is
# there. This prints what that repository's own Level 0 would have been: the
# contract file with its @ imports resolved, and the name and description of
# every skill it ships.
#
# It simulates the harness and nothing more. Skill bodies, docs indexes and
# READMEs are deliberately absent -- each would multiply the cost, and each is
# one Read away once the map below says it is worth reading.
#
# Dependency-free bash + awk on purpose: this runs on whatever machine the
# plugin was installed on, and a utility that needs installing before it can
# save a few tokens has already lost.

set -uo pipefail

MAXDEPTH_SKILLS=4     # context-lab nests at skills/<bucket>/<skill>/SKILL.md
# Vendored and build directories, in one place. A second copy of this list is a
# second chance to forget one, and a vendored SKILL.md printed as if the repo
# shipped it is a silent wrong answer, not a visible failure.
IGNORE_DIRS="node_modules .git .venv venv target dist build __pycache__ .next .tox"
CONTRACTS="CLAUDE.md AGENTS.md"
IMPORT_DEPTH=2

usage() { sed -n '3,5p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; }

case "${1-}" in
  -h|--help) usage; exit 0 ;;
  "")        echo "peek: no path given" >&2; usage >&2; exit 2 ;;
esac

# ------------------------------------------------------------- resolution ---

# Real paths throughout. Worktrees and ~/dev layouts are full of symlinks, and
# a self-target check that compares unresolved paths is a check that can be
# fooled by the one case it exists to catch.
realdir() {
  local p="$1"
  [ -e "$p" ] || return 1
  [ -f "$p" ] && p="$(dirname -- "$p")"   # a file three levels down is the
                                          # motivating case, not an error
  ( cd -P -- "$p" 2>/dev/null && pwd -P )
}

# The nearest ancestor holding a contract file wins. Git is only the tie-break,
# because a git worktree and a monorepo package both have a .git that is not
# the root anyone meant. The walk stops dead at the git boundary either way: a
# tool that answers by reading something outside the repository it was pointed
# at is worse than one that says it found nothing.
find_root() {
  local dir="$1" gitroot="" c
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    for c in $CONTRACTS; do
      if [ -f "$dir/$c" ]; then printf '%s\n' "$dir"; return 0; fi
    done
    if [ -e "$dir/.git" ]; then gitroot="$dir"; break; fi
    [ "$dir" = "$HOME" ] && break
    dir="$(dirname -- "$dir")"
  done
  if [ -n "$gitroot" ]; then printf '%s\n' "$gitroot"; return 1; fi
  return 2
}

# Only ever one level down, and only into directories that could plausibly be a
# repository. The alternative is a pruned depth-3 find whose prune list is a
# maintenance burden that grows with every ecosystem.
suggest_children() {
  local dir="$1" child base c
  for child in "$dir"/*/; do
    [ -d "$child" ] || continue
    base="$(basename -- "$child")"
    skip=0
    for ign in $IGNORE_DIRS; do [ "$base" = "$ign" ] && { skip=1; break; }; done
    [ "$skip" -eq 1 ] && continue
    for c in $CONTRACTS; do
      [ -f "$child$c" ] && { printf '  %s\n' "${child%/}"; break; }
    done
  done
}

# ---------------------------------------------------------------- payload ---

SEEN=""

seen() {
  case "$SEEN" in *"|$1|"*) return 0 ;; esac
  SEEN="$SEEN|$1|"
  return 1
}

# @path is how a contract file says "and also this". Emitting the line verbatim
# hands the caller a pointer it cannot follow, because it would resolve against
# the caller's own working directory -- and on a real repo the whole of
# CLAUDE.md is often that one line. Following it is the difference between this
# tool working and this tool printing eleven bytes.
emit_file() {
  local file="$1" depth="$2" real dir target line rel
  real="$(cd -P -- "$(dirname -- "$file")" && pwd -P)/$(basename -- "$file")"
  if seen "$real"; then
    printf '  (%s -- already shown above)\n' "$(basename -- "$file")"
    return 0
  fi
  dir="$(dirname -- "$real")"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      @*)
        rel="${line#@}"
        rel="${rel%%[[:space:]]*}"
        case "$rel" in
          "~/"*) target="$HOME/${rel#\~/}" ;;
          /*)    target="$rel" ;;
          *)     target="$dir/$rel" ;;
        esac
        if [ -f "$target" ] && [ "$depth" -lt "$IMPORT_DEPTH" ]; then
          printf '\n  ── imported: %s ──\n' "$rel"
          emit_file "$target" "$((depth + 1))"
        else
          printf '%s\n' "$line"
        fi
        ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$real"
}

# name and description only. The body is the level the caller has not decided
# to pay for yet, and deciding is the entire point of a progressive ladder.
emit_skills() {
  local root="$1" roots=() prune=() f n=0 ign
  for ign in $IGNORE_DIRS; do prune+=(-name "$ign" -prune -o); done
  [ -d "$root/.claude/skills" ] && roots+=("$root/.claude/skills")
  [ -d "$root/skills" ]         && roots+=("$root/skills")
  [ ${#roots[@]} -eq 0 ] && return 0

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    awk '
      function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
      function unq(s,  q) {
        s = trim(s); q = sprintf("%c", 39)
        if (length(s) > 1 && substr(s,1,1) == "\"" && substr(s,length(s),1) == "\"")
          return substr(s, 2, length(s) - 2)
        if (length(s) > 1 && substr(s,1,1) == q && substr(s,length(s),1) == q)
          return substr(s, 2, length(s) - 2)
        return s
      }
      NR == 1 && $0 == "---" { fm = 1; next }
      fm && $0 == "---" { exit }
      fm && /^name:/ { name = unq(substr($0, index($0, ":") + 1)) }
      fm && /^description:/ { desc = unq(substr($0, index($0, ":") + 1)) }
      # A skill needs both keys or no harness can match it, so one without
      # them would not be loaded inside that repo either. Skipping is the
      # honest simulation; printing it would advertise context that can never
      # actually fire.
      END {
        if (name != "" && desc != "") printf "  %s\n      %s\n", name, desc
      }' "$f"
    n=$((n + 1))
  done < <(find "${roots[@]}" -maxdepth "$MAXDEPTH_SKILLS" "${prune[@]}" \
             -name SKILL.md -print 2>/dev/null | LC_ALL=C sort)
  return 0
}

# ------------------------------------------------------------------- main ---

CALLER_ROOT="$(find_root "$(pwd -P)" 2>/dev/null || true)"
TOTAL=0; MISSING=0

for arg in "$@"; do
  TOTAL=$((TOTAL + 1))
  printf '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'

  start="$(realdir "$arg")" || {
    printf 'NOT FOUND  %s\n' "$arg"
    printf '  Nothing at this path. Check the spelling before assuming the repo is bare.\n\n'
    MISSING=$((MISSING + 1))
    continue
  }

  root="$(find_root "$start")"; rc=$?

  if [ "$rc" -eq 2 ]; then
    printf 'NO REPOSITORY  %s\n' "$start"
    printf '  No contract file and no git boundary anywhere above this path.\n' 
    kids="$(suggest_children "$start")"
    [ -n "$kids" ] && { printf '  Directories below this one that do have one:\n%s\n' "$kids"; }
    printf '\n'
    continue
  fi

  if [ -n "$CALLER_ROOT" ] && [ "$root" = "$CALLER_ROOT" ]; then
    printf 'ALREADY LOADED  %s\n' "$root"
    printf '  This is the repository you are already in. Its Level 0 is in your\n'
    printf '  context from the start of the session; reading it again buys nothing.\n\n'
    continue
  fi

  printf 'ROOT: %s\n' "$root"
  printf '  Every relative link below resolves against that path, not your cwd.\n'

  found=0
  for c in $CONTRACTS; do
    if [ -f "$root/$c" ]; then
      printf '\n──────── %s ────────\n' "$c"
      emit_file "$root/$c" 0
      found=1
    fi
  done

  if [ "$found" -eq 0 ]; then
    printf '\n  No CLAUDE.md and no AGENTS.md at the root. That is a real absence,\n'
    printf '  not a failed scan -- this repository states no contract.\n'
    kids="$(suggest_children "$root")"
    [ -n "$kids" ] && printf '  Directories below it that do:\n%s\n' "$kids"
  fi

  skills="$(emit_skills "$root")"
  if [ -n "$skills" ]; then
    printf '\n──────── skills ────────\n%s\n' "$skills"
  fi

  printf '\nNot included, on purpose: skill bodies, docs/ indexes, README. Each is\n'
  printf 'one Read away at %s, once the map above says it is worth it.\n\n' "$root"
done

if [ "$MISSING" -eq "$TOTAL" ]; then
  exit 3
fi
exit 0
