// ─────────────────────────────────────────────────────────────────────────────
// Minimal glob matching (no dependency). Used by backlog/repo.ts to select
// which files in a tracking repo represent backlog items. Supports:
//   `**`  any number of path segments, including none
//   `*`   anything within a single path segment (never crosses `/`)
//   `?`   exactly one character, other than `/`
// Everything else matches literally (regex metacharacters are escaped).
// ─────────────────────────────────────────────────────────────────────────────

const REGEXP_SPECIAL = /[.+^${}()|[\]\\]/

/** Compiles a glob pattern into an anchored RegExp matching the whole path. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '^'
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // `**/` matches zero or more whole path segments, including none,
          // so `docs/**/*.md` also matches `docs/x.md`.
          pattern += '(?:.*/)?'
          i += 3
          continue
        }
        pattern += '.*'
        i += 2
        continue
      }
      pattern += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      pattern += '[^/]'
      i += 1
      continue
    }
    pattern += REGEXP_SPECIAL.test(ch) ? `\\${ch}` : ch
    i += 1
  }
  pattern += '$'
  return new RegExp(pattern)
}
