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
# Dependency-free bash + awk on purpose: SSH mode pipes this file to a remote
# host that may have nothing but bash, so it must never read stdin itself.

set -uo pipefail

MAXDEPTH_SKILLS=4     # context-lab nests at skills/<bucket>/<skill>/SKILL.md
# Vendored and build directories, in one place. A second copy of this list is a
# second chance to forget one, and a vendored SKILL.md printed as if the repo
# shipped it is a silent wrong answer, not a visible failure.
IGNORE_DIRS="node_modules .git .venv venv target dist build __pycache__ .next .tox"
CONTRACTS="CLAUDE.md AGENTS.md"
IMPORT_DEPTH=2

usage() { sed -n '3,5p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; }

# Prepended to every printed root. SSH mode passes "host:" so the caller reads
# ROOT: host:/path and knows the files are not on its own disk.
ROOT_PREFIX=""
if [ "${1-}" = "--root-prefix" ]; then
  ROOT_PREFIX="${2-}"; shift 2
fi

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
      [ -f "$child$c" ] && { printf '  %s\n' "$ROOT_PREFIX${child%/}"; break; }
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
      fm && $0 == "---" { if (block == "name") name = blk; else if (block == "desc") desc = blk; exit }
      # A YAML block scalar (description: > or |, optionally with - or +)
      # carries its value on the indented lines that follow; join them.
      fm && block != "" && /^[ \t]/ { v = trim($0); if (v != "") blk = (blk == "" ? v : blk " " v); next }
      fm && block != "" { if (block == "name") name = blk; else desc = blk; block = "" }
      fm && /^name:/ { v = trim(substr($0, index($0, ":") + 1)); if (v ~ /^[>|][-+]?$/) { block = "name"; blk = "" } else name = unq(v) }
      fm && /^description:/ { v = trim(substr($0, index($0, ":") + 1)); if (v ~ /^[>|][-+]?$/) { block = "desc"; blk = "" } else desc = unq(v) }
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

# ---------------------------------------------- no agent context: explore ---
#
# A repo with no contract and no skills would otherwise print one line saying
# so, and the agent's next three calls would be ls, cat README, ls src. Those
# answers are printed here instead, capped, so the first peek is never wasted.

README_LINES=80
MANIFEST_LINES=25
TREE_LINES=40
TREE_KIDS=6
MANIFESTS="package.json pyproject.toml requirements.txt Cargo.toml go.mod Gemfile composer.json pom.xml build.gradle Makefile"

# Names that may hold key material are never listed, even by name: a tree is
# the one place an untracked .env would otherwise reach the caller.
SENSITIVE_AWK='{ n = split($0, p, "/"); b = p[n] }
  b ~ /^\.env/ || b ~ /\.(pem|key|p12|pfx|jks|keystore)$/ || b ~ /^id_(rsa|dsa|ecdsa|ed25519)/ \
    || tolower(b) ~ /secret|credential|token/ { next }
  { print }'

# Every file under the root, relative to it, sorted. Tracked files when git can
# say which they are; otherwise a find that skips dot-entries and vendored dirs.
is_git_root() {
  command -v git >/dev/null 2>&1 \
    && [ "$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" = "$1" ]
}

list_files() {
  local root="$1" prune=() ign
  if is_git_root "$root"; then
    git -C "$root" ls-files 2>/dev/null
  else
    for ign in $IGNORE_DIRS; do prune+=(-name "$ign" -prune -o); done
    ( cd -- "$root" && find . -mindepth 1 -maxdepth 6 \( -name '.*' -prune \) -o \
        "${prune[@]}" -type f -print 2>/dev/null | sed 's|^\./||' )
  fi | awk "$SENSITIVE_AWK" | LC_ALL=C sort
}

# Two levels of the tree: top-level dirs with file counts and their first few
# children, then top-level files. Deeper levels are counted, never listed.
emit_tree() {
  awk -v cap="$TREE_LINES" -v kids="$TREE_KIDS" '
    { n = split($0, a, "/"); total++
      if (n == 1) { files[++nf] = a[1]; next }
      top = a[1]
      if (!(top in cnt)) dirs[++nd] = top
      cnt[top]++
      child = a[2] (n > 2 ? "/" : "")
      key = top SUBSEP child
      if (!(key in ccnt)) { nk[top]++; kid[top, nk[top]] = child }
      ccnt[key]++ }
    function out(s) { if (lines < cap) print s; else over++; lines++ }
    END {
      if (total == 0) { print "  (no files)"; exit }
      for (i = 1; i <= nd; i++) {
        d = dirs[i]; out(sprintf("  %s/  (%d file%s)", d, cnt[d], cnt[d] == 1 ? "" : "s"))
        for (j = 1; j <= nk[d] && j <= kids; j++) {
          c = kid[d, j]
          if (c ~ /\/$/) out(sprintf("      %s  (%d)", c, ccnt[d SUBSEP c]))
          else out("      " c)
        }
        if (nk[d] > kids) out(sprintf("      ... %d more", nk[d] - kids))
      }
      for (i = 1; i <= nf; i++) out("  " files[i])
      if (over > 0) printf "  ... %d more lines; %d files in all\n", over, total
    }'
}

# Print at most $2 lines of a file, saying how much was left out and where.
emit_head() {
  local f="$1" max="$2" total
  total="$(wc -l < "$f" | tr -d ' ')"
  sed -n "1,${max}p" "$f"
  [ "$total" -gt "$max" ] && printf '  ... %d more lines in %s%s\n' \
    $((total - max)) "$ROOT_PREFIX" "$f"
  return 0
}

# Without git there is no boundary to stop at, so the nearest folder holding a
# README or a manifest is the project; a file in src/ must not make src/ the
# root. Nothing found below $HOME means the starting folder itself.
find_project_root() {
  local dir="$1" m
  while [ -n "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "$HOME" ]; do
    for m in README.md README $MANIFESTS; do
      [ -f "$dir/$m" ] && { printf '%s\n' "$dir"; return 0; }
    done
    dir="$(dirname -- "$dir")"
  done
  printf '%s\n' "$1"
}

emit_explore() {
  local root="$1" readme="" f m files
  printf '\n  Nothing above for an agent, so here is what its first exploration\n'
  printf '  would have fetched: the README, the manifests, and the file tree.\n'

  for f in README.md readme.md README.MD Readme.md README.rst README.txt README; do
    [ -f "$root/$f" ] && { readme="$root/$f"; break; }
  done
  if [ -n "$readme" ]; then
    printf '\n──────── %s (first %d lines) ────────\n' "$(basename -- "$readme")" "$README_LINES"
    emit_head "$readme" "$README_LINES"
  fi

  for m in $MANIFESTS; do
    [ -f "$root/$m" ] || continue
    printf '\n──────── %s ────────\n' "$m"
    emit_head "$root/$m" "$MANIFEST_LINES"
  done

  TREE_SOURCE="files"; is_git_root "$root" && TREE_SOURCE="tracked files"
  files="$(list_files "$root")"
  printf '\n──────── tree (%s, 2 levels) ────────\n' "$TREE_SOURCE"
  [ -n "$files" ] && printf '%s\n' "$files" | emit_tree || printf '  (no files)\n'
}

# ------------------------------------------------------------------- main ---

CALLER_ROOT="$(find_root "$(pwd -P)" 2>/dev/null || true)"
TOTAL=0; MISSING=0

for arg in "$@"; do
  TOTAL=$((TOTAL + 1))
  printf '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'

  # A path that arrived over SSH is plain text, so no shell has expanded ~ yet.
  case "$arg" in
    "~")    arg="$HOME" ;;
    "~/"*)  arg="$HOME/${arg#\~/}" ;;
  esac

  start="$(realdir "$arg")" || {
    printf 'NOT FOUND  %s\n' "$ROOT_PREFIX$arg"
    printf '  Nothing at this path. Check the spelling before assuming the repo is bare.\n\n'
    MISSING=$((MISSING + 1))
    continue
  }

  root="$(find_root "$start")"; rc=$?

  NOGIT=0
  if [ "$rc" -eq 2 ]; then
    kids="$(suggest_children "$start")"
    # A folder of repos (~/dev) or the home dir itself is not a project; say
    # where the repos are. Anything else is a project that has not been
    # git-initialised yet, and gets the same treatment as one that has.
    if [ -n "$kids" ] || [ "$start" = "$HOME" ] || [ "$start" = "/" ]; then
      printf 'NO REPOSITORY  %s\n' "$ROOT_PREFIX$start"
      printf '  No contract file and no git boundary anywhere above this path.\n'
      [ -n "$kids" ] && { printf '  Directories below this one that do have one:\n%s\n' "$kids"; }
      printf '\n'
      continue
    fi
    root="$(find_project_root "$start")"; NOGIT=1
  fi

  if [ -n "$CALLER_ROOT" ] && [ "$root" = "$CALLER_ROOT" ]; then
    printf 'ALREADY LOADED  %s\n' "$ROOT_PREFIX$root"
    printf '  This is the repository you are already in. Its Level 0 is in your\n'
    printf '  context from the start of the session; reading it again buys nothing.\n\n'
    continue
  fi

  printf 'ROOT: %s\n' "$ROOT_PREFIX$root"
  printf '  Every relative link below resolves against that path, not your cwd.\n'
  [ "$NOGIT" -eq 1 ] && printf '  Not a git repository and nothing above it is, so this folder is\n  taken as the project root.\n'

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

  if [ "$found" -eq 0 ] && [ -z "$skills" ]; then
    emit_explore "$root"
    printf '\nThis repository has no agent context of its own. The rest is one Read\n'
    printf 'away at %s.\n\n' "$ROOT_PREFIX$root"
    continue
  fi

  printf '\nNot included, on purpose: skill bodies, docs/ indexes, README. Each is\n'
  printf 'one Read away at %s, once the map above says it is worth it.\n\n' "$ROOT_PREFIX$root"
done

if [ "$MISSING" -eq "$TOTAL" ]; then
  exit 3
fi
exit 0
