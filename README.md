# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Mastomy2/hidden-spec-cli-01-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Mastomy2/hidden-spec-cli-01-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON —
and `mend` reads all four to one written specification (`SPEC.md`), finds the lines
an edit names even when the model drifted their whitespace or indentation, and
changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the
  tree). When absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without
  it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Node 22 and its standard library alone; nothing is installed before the program runs.

## What it does

- **Three-tier matching.** An edit's old lines are found at the first tier where
  they occur: exact, trailing whitespace ignored, then leading and trailing
  whitespace ignored — with tier-2 re-indentation of the new lines to the file's
  own indent. Context lines are always written as the file's own matched lines.
- **Unified diffs.** Wrong line numbers are tolerated: a hunk takes the occurrence
  nearest to its (drift-corrected) header position. Creations, deletions and
  renames work, including files without a final line break (`\ No newline at end
  of file`), CRLF files and empty-old-line insertions.
- **SEARCH/REPLACE blocks.** A block's path is the nearest line before it; a block
  whose old lines occur more than once at their tier fails as `ambiguous`.
- **V4A patches.** Anchored chunks with a cursor, end-of-file chunks, Add/Delete/
  Update sections and `Move to:`.
- **JSON edits.** `create`, `str_replace` (exact, CRLF-aware) and `insert`.
- **All or nothing.** Edits apply in order to the tree as earlier edits left it;
  a failed edit changes nothing, later edits still run and are all reported, and
  when any edit failed no file is written at all. Successful moves are reported
  as `R <old> -> <new>`.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's runner, unchanged: in a trial it runs `main.ts` on each
  check and posts the results.
- `check.ts` — the practice set on your own machine:
  `node check.ts ../program/generator/practice.json` (from the kit).
- `SPEC.md` — the whole specification.

## Checks

- Practice set: **100 of 100 passed (practice score 1000)**.
- 37 extra edge cases written from SPEC sentences the practice set does not show
  (dangling `---` headers, malformed `diff --git`, move chains, V4A anchors and
  end-of-file chunks, unsafe paths, atomicity, `--check` failures): **37 passed**.
