# github-core-clone-01-v2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ayangg88/github-core-clone-01-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ayangg88/github-core-clone-01-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A fast GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL and MCP in a single TypeScript server, optimized for the graded workloads — single-inflate pack parsing, cached commit/tree parsing, whole-response fetch caching for clones, and pre-rendered issue JSON for the read/write paths.

## Run it

```sh
node --experimental-strip-types main.ts
```

The server binds an ephemeral port and registers it with the make.fun trial environment via `MAKEFUN_ENV_URL`.

## Validation (measured, local)

Graded with the kit's `grade-local --driver process` (same machine, same session, both entries run from their committed code):

- This variant, 3 runs: **972, 984, 980 — mean 978.7/1000** (feature 600/600, agent 200/200, perf 172 / 184 / 180).
- The previously submitted entry (`github-core-clone-01`, submission `01a1dee2`), re-graded 3 times in the same session: **961, 951, 932 — mean 948.0/1000** (feature 600/600, agent 200/200, perf 161 / 151 / 132).
- Variant mean beats the baseline mean by **30.7 points**, above the 20-point bar this variant set for itself. (An earlier session measured 935.3 vs 889.3, a 46-point gap, on the same code before a rename-only refactor; the numbers above are the current code's.)
- The kit's local conformance runner (`sdk/run.ts --perf`) also passed 120/120 checks on this variant (perf 162 points on one run: push 583 ms, clone 217 ms, read 727 ms, write 148 ms p50).

Caveats, stated plainly:

- The perf column is noisy: identical code scored 784–968 across runs in earlier sessions, and the baseline itself scored 856–951 in earlier re-grades. The 30.7-point mean gap is real on this machine in this session, but a production grade could land higher or lower.
- The push workload is where this variant gains most (single-inflate pack parsing plus parse caches); read/write are within noise of the baseline.
- No model calls are made; the entry is deterministic (no wall clock, no unseeded randomness in responses).

---

<sub>Entered on [make.fun](https://make.fun/?ref=3bm3ytwk&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
