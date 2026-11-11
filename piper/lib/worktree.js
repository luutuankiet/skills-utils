// Is a folder inside a linked git worktree? Answered from the files on disk,
// without running git, because it is asked at every session and subagent start.
//
// The first `.git` found walking up from the folder decides:
// - a `.git` folder: a main checkout, not a linked worktree;
// - a `.git` file whose `gitdir:` points at `<common>/worktrees/<name>`, a
//   folder holding a `commondir` file: a linked worktree;
// - any other `.git` file, such as a submodule's (it points into
//   `.git/modules/<name>`, which has no `commondir`): not a linked worktree.
// This is the same answer as `git rev-parse --git-dir` differing from
// `--git-common-dir`.

import { readFileSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** True when `cwd` is inside a linked git worktree. Any error gives false. */
export function inLinkedWorktree(cwd) {
  try {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false;
    let dir = resolve(cwd);
    for (;;) {
      const dotGit = join(dir, '.git');
      let st = null;
      try { st = statSync(dotGit); } catch { st = null; }
      if (st) {
        if (!st.isFile()) return false;
        const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(dotGit, 'utf8'));
        if (!m) return false;
        const gitdir = resolve(dir, m[1]);
        return basename(dirname(gitdir)) === 'worktrees' && existsSync(join(gitdir, 'commondir'));
      }
      const up = dirname(dir);
      if (up === dir) return false;
      dir = up;
    }
  } catch {
    return false;
  }
}
