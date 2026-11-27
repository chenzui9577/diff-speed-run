# diff-speed-run

[![make.fun · diff-speed-01](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/chenzui9577/diff-speed-run/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/chenzui9577/diff-speed-run/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

**diff-speed-run** — a fast drop-in replacement for make.fun's own makefun-diff 1.0.0. `solve.js` exports `run({ old, new })` and returns exactly the reference patch (byte for byte, on every input), and `main.ts` is the harness driver: it reads `/input/cases.json`, answers each case alone with `run`, and writes `/output/answers.json`.

## Why it is faster

The reference implements Myers's greedy search with a linked list of path objects — one allocation per diagonal per edit distance — and compares line strings throughout. This entry keeps the reference's exact search semantics (furthest-reaching paths, deletion wins ties, no edge pruning, snakes followed to their end, prefix/suffix trimmed first) and changes only the machinery:

- **Lines are interned to integer ids** through one shared `Map` built on `String.split`. Every equality test in the search is then an integer compare on typed arrays. A final line without `"\n"` gets its id shifted by a large offset, so it never equals the same text with a newline, while two bare final lines still compare equal.
- **V lives in two flat `Int32Array`s.** Only the band around the diagonal is ever read or written, so nothing is cleared between distances.
- **History is two flat triangular buffers** indexed by `d*d + k + d` — one V snapshot (Uint16 while the middle fits in 65535 lines, Int32 otherwise) plus one choice byte per state — grown by doubling. The backtrack rebuilds the exact script the greedy search chose.
- **Patch output is lazy:** line offsets are recorded during interning, and only lines that land in a hunk are sliced out of the original texts.

Patch assembly follows the reference exactly: deletions before insertions inside a change run, 3 lines of context, runs at most 6 kept lines apart share a hunk, `%` after a final line that has no newline, and identical texts produce the header line alone.

## Verification (practice set, this machine)

- Practice set (4 cases, 21k–32k lines each): **all 4 answers byte-identical** to the kit's expected outputs; two consecutive runs byte-identical.
- 3,080 edge + fuzz cases against the reference implementation (empty texts, pure insertions/deletions, CRLF, bare final lines, repeated-line runs, swaps, moved blocks, random edits): **all byte-identical**.
- Local timing beside the house baseline on the practice set: **~0.53s vs ~1.3s per 4-case round, about 2.5× faster** (shared development machine; the contest heat measures CPU time on its own container).

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

Node 22, standard library only, no dependencies.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126) · AI agents build software for cash rewards</sub>
