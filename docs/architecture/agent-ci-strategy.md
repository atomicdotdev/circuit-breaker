# Agent CI Strategy — Sealed SmolVM Runners via Circuit Breaker

## Problem

Remote CI is the bottleneck in the agent era. AI agents write code, push, wait 2-5 minutes for GitHub Actions, read logs, fix, push again. Every iteration pays the full cost of a fresh run. The agent's inner loop is gated on a system designed for human-paced development.

## Solution: Sealed Runner Model

`cb check` reads a GitHub Actions YAML file, builds a hardware-isolated microVM with all the tools pre-installed, seals it as a reusable `.smolmachine` artifact, and executes the `run:` steps inside it. The sealed runner is cached — first build takes ~60 seconds, every subsequent run boots in under 600ms.

### Proven Working (April 21, 2026)

```
$ time ./cb check -w .github/workflows/ci.yml -s /path/to/circuit-vm

▶ ci.yml
  Job: check (ubuntu:24.04)
  Setup: 1 uses: step(s) → sealed runner
  Run:   3 run: step(s) → Petri net transitions
  Runner cache key: e778fe7a3090ad6d...
  ✓ Using cached runner
  Booting sealed runner...
  ✓ Runner ready (590ms)
  Working directory: /projects/circuit-vm

  ✓ step-0 (597ms)       ← cargo fmt --all -- --check
  ✓ step-1 (12079ms)     ← cargo clippy -p circuit-core -- -D warnings
  ✓ step-2 (5855ms)      ← cargo test -p circuit-core
  ✓ ci.yml passed (30296ms)

──────────────────────────────────────────────────
✓ All checks passed (30296ms)

real  0m30.392s
```

### Measured Timings

| Scenario | Time |
|----------|------|
| **Cold boot** (build baseline + install tools + seal + run) | **64s** |
| **Warm boot** (cached sealed runner + run) | **1.3s** to boot, **30s** total with compile steps |
| Runner boot from `.smolmachine` cache | **590ms** |
| Seal builder VM into `.smolmachine` | **14s** |
| Baseline apt packages (29 packages, 7 steps) | **26s** |
| Rust toolchain install (`dtolnay/rust-toolchain@stable`) | **10-12s** |

## Architecture

### Three-Phase Pipeline

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Phase 1: PARSE                                                     │
  │                                                                     │
  │  cb check reads .github/workflows/ci.yml                           │
  │  ├─ Separates uses: steps (setup) from run: steps (execution)      │
  │  ├─ Resolves runs-on: to base OCI image (ubuntu:24.04)             │
  │  ├─ Resolves each uses: step via action.yml fetch from GitHub       │
  │  └─ Computes cache key: SHA-256(image + uses refs + with inputs)    │
  │                                                                     │
  ├─────────────────────────────────────────────────────────────────────┤
  │  Phase 2: BUILD (skipped if cache hit)                              │
  │                                                                     │
  │  smolvm machine create --image ubuntu:24.04 --net cb-build-<key>   │
  │  ├─ Install baseline packages (bash, curl, git, gcc, etc.)          │
  │  ├─ Set up GitHub Actions environment shim                          │
  │  ├─ Execute resolved uses: install scripts                          │
  │  ├─ smolvm machine stop (required before seal)                      │
  │  ├─ smolvm pack create --from-vm → ~/.cb/runners/<key>.smolmachine │
  │  └─ Delete builder VM                                               │
  │                                                                     │
  ├─────────────────────────────────────────────────────────────────────┤
  │  Phase 3: RUN                                                       │
  │                                                                     │
  │  smolvm machine create --from <key>.smolmachine                    │
  │    --volume <parent-dir>:/projects --net cb-check                   │
  │  ├─ For each run: step:                                             │
  │  │   smolvm machine exec --name cb-check -- bash -c                │
  │  │     "source env/path from build phase; cd /projects/<name>; CMD"│
  │  └─ Report pass/fail per step with timing                           │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘
```

### Separation of Concerns

The key insight: **`uses:` steps tell you what to install, `run:` steps tell you what to execute.** Scan the `uses:` up front, build one VM with everything, seal it. Then the Petri net runs only the `run:` steps inside the sealed VM.

| Concern | What handles it |
|---------|----------------|
| Parsing GitHub Actions YAML | `@circuit-breaker/core` TypeScript SDK (`github-actions.ts`) |
| Resolving `uses:` to install scripts | `@circuit-breaker/core` action resolver (`action-resolver.ts`) |
| Baseline packages for bare Ubuntu | `@circuit-breaker/core` runner baseline (`runner-baseline.ts`) |
| VM lifecycle (create, start, exec, stop, pack, delete) | `smolvm` CLI (subprocess calls) |
| Cache key computation + cache directory | `runner-baseline.ts` (`runnerCacheKey()`, `~/.cb/runners/`) |
| Orchestrating the full pipeline | `@circuit-breaker/cli` check command (`check.ts`) |

## Baseline Packages

A bare `ubuntu:24.04` OCI image is missing almost everything. GitHub-hosted runners ship hundreds of packages. We install the **practical minimum** that lets resolved `uses:` composite-action scripts execute:

| Group | Packages | Purpose |
|-------|----------|---------|
| **Essential** | bash, curl, wget, ca-certificates, git | Can't do anything without these |
| **Archive** | tar, unzip, xz-utils, zip, gzip, bzip2 | Installers download archives |
| **Build toolchain** | build-essential, pkg-config, libssl-dev, autoconf, automake, libtool | Compiling native extensions |
| **System** | sudo, gnupg, openssh-client, software-properties-common, apt-transport-https, lsb-release | Install scripts expect these |
| **Utilities** | jq, file, locales, python3, python3-pip, python-is-python3 | Common in action scripts |

**Total: 29 packages.** Installed in 7 sequential `smolvm machine exec` calls (~26 seconds). Split into groups to avoid pipe-buffering hangs and to stream live progress output.

The baseline is defined in `sdk/packages/core/src/runner-baseline.ts` and versioned — changing the package list bumps the cache key version, forcing a rebuild on next run.

## GitHub Actions Environment Shim

Composite actions (like `dtolnay/rust-toolchain`) expect GitHub Actions environment variables and helper files. The shim creates these at well-known paths:

| Variable | Path | Purpose |
|----------|------|---------|
| `GITHUB_OUTPUT` | `/tmp/.cb/github_output` | Step output key=value pairs |
| `GITHUB_ENV` | `/tmp/.cb/github_env` | Persistent env vars across steps |
| `GITHUB_PATH` | `/tmp/.cb/github_path` | Persistent PATH additions across steps |
| `GITHUB_WORKSPACE` | `/projects/<name>` | Working directory |
| `RUNNER_OS` | `Linux` | OS detection |
| `RUNNER_ARCH` | `X64` or `ARM64` | Architecture detection |
| `RUNNER_TOOL_CACHE` | `/opt/hostedtoolcache` | Tool cache directory |

These files **persist in the sealed `.smolmachine` overlay**. When a `run:` step executes, the `RUN_STEP_PREAMBLE` sources `GITHUB_ENV` and `GITHUB_PATH` so tools installed during the build phase are on the PATH.

**Important:** The shim uses `set -eo pipefail` (not `-euo`). GitHub Actions doesn't enforce `nounset`, and resolved scripts reference variables like `$CARGO_HOME` before they're set.

## Cache Model

### Cache Key

```
SHA-256 of:
  "baseline-v1\n"                          ← bump when BASELINE_PACKAGES changes
  "image:ubuntu:24.04\n"                   ← base OCI image
  "uses:dtolnay/rust-toolchain@stable\n"   ← sorted uses: references
  "  components=\"rustfmt,clippy\"\n"      ← sorted with: inputs
```

### Cache Location

```
~/.cb/runners/<sha256-hex>.smolmachine     ← sealed runner artifact
```

### Cache Invalidation

| Change | Effect |
|--------|--------|
| `uses:` step added/removed | New cache key → full rebuild |
| `with:` input changed | New cache key → full rebuild |
| `run:` step changed | **No rebuild** — same sealed runner, different commands |
| Base image changed | New cache key → full rebuild |
| `--rebuild` flag passed | Forces rebuild, ignores existing cache |
| Baseline packages updated (code change) | `baseline-v1` bumped → new cache key |

## Volume Mounting Strategy

The source directory's **parent** is mounted at `/projects` inside the VM, not the source directory itself. This ensures sibling path dependencies resolve correctly.

```
Host:  /Users/lee/Projects/circuit-vm    ← source
       /Users/lee/Projects/smolvm        ← sibling dependency

VM:    /projects/circuit-vm              ← working directory
       /projects/smolvm                  ← ../smolvm resolves correctly
```

The working directory inside the VM is `/projects/<basename-of-source>`.

This is necessary because `.smolmachine` artifacts claim `/workspace` for their own storage disk. Using `/projects` avoids the conflict.

## `uses:` Action Resolution

The action resolver (`action-resolver.ts`) handles `uses:` steps:

1. **Skippable actions** return `null` — no install needed:
   - `actions/checkout` — source is mounted via `--volume`
   - `actions/cache` — overlay persistence replaces explicit caching
   - `actions/upload-artifact` / `actions/download-artifact` — overlay handles this

2. **Composite actions** (like `dtolnay/rust-toolchain@stable`):
   - Fetch `action.yml` from GitHub (cached in memory)
   - Parse composite `runs.steps`
   - Substitute `${{ inputs.* }}` with `with:` values
   - Replace `${{ steps.*.outputs.* }}` with runtime shell lookups against `GITHUB_OUTPUT`
   - Concatenate all resolved shell steps into a single bash script
   - Execute the script inside the builder VM during the build phase

3. **Docker/Node actions** — logged as unsupported, skipped in v1.

## CLI Interface

```bash
# Run all discovered workflows
cb check

# Run a specific workflow
cb check -w .github/workflows/ci.yml

# Run against a specific source directory
cb check -s /path/to/project

# Retry from a failed step (skips earlier steps)
cb check --from step-1

# Force rebuild the sealed runner (ignore cache)
cb check --rebuild

# Output structured JSON for agent consumption
cb check --json

# Run directly in host shell (no VM isolation, for comparison)
cb check --shell
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All checks passed |
| 1 | One or more steps failed (output includes failed step name) |

### JSON Output (`--json`)

```json
[
  {
    "workflow": "ci.yml",
    "image": "ubuntu:24.04",
    "runner_cache_key": "e778fe7a3090ad6d...",
    "status": "passed",
    "runner_built": false,
    "duration_ms": 30296,
    "steps": [
      { "id": "step-0", "status": "passed", "duration_ms": 597, "exit_code": 0 },
      { "id": "step-1", "status": "passed", "duration_ms": 12079, "exit_code": 0 },
      { "id": "step-2", "status": "passed", "duration_ms": 5855, "exit_code": 0 }
    ]
  }
]
```

## Agent Hook

No MCP. No special protocol. Just instructions in your agent config.

### Add to CLAUDE.md / AGENTS.md

```markdown
## CI

Before completing any task, run CI checks locally:

    cb check

If it fails, fix the issue and re-run. Do not report work as done until it passes.

If a specific step fails, retry from that step:

    cb check --from <step-name>
```

The first run builds the sealed runner (~60s). Every subsequent run uses the cached runner and boots in under 600ms.

## Comparison

|  | GitHub Actions | Agent CI (RedwoodJS) | **cb check** |
|---|---|---|---|
| Runtime | Cloud VMs | Docker containers | SmolVM microVMs |
| Isolation | Full VM | Namespace (shared kernel) | Hypervisor (own kernel) |
| Runner model | Official runner binary | Official binary + API emulation | **Sealed runner** (pre-built VM) |
| Boot time | 10-60s (queue + boot) | ~2-5s (Docker) | **590ms** (from cache) |
| Cold start | N/A (always cold) | ~2-5s | **64s** (build + seal + run) |
| Tool install | Every run | Every run (or cached layers) | **Once** (baked into sealed runner) |
| Cache model | Upload/download/untar | Bind-mount host dirs | Sealed `.smolmachine` artifact |
| On failure | Start over | Pause container | `--from <step>` retry |
| `uses:` support | Full | Full (emulated API) | Composite actions via action.yml fetch |
| Dependencies | GitHub infrastructure | Docker daemon | `smolvm` binary only |
| Provenance | GitHub logs (opaque) | None (ephemeral) | NATS events + Atomic graph (future) |

### Key Difference: Build Once, Run Many

GitHub Actions and Agent CI install tools on every run. `cb check` installs tools **once**, seals the result, and reuses it. The cache key is derived from the `uses:` steps — if only `run:` steps change (which is the common case during development), the sealed runner is reused without any rebuild.

## Implementation: What Exists

### Files

| File | Purpose |
|------|---------|
| `sdk/packages/core/src/runner-baseline.ts` | Baseline packages, install scripts, shim, cache key, paths |
| `sdk/packages/core/src/github-actions.ts` | GitHub Actions YAML → Workflow IR converter |
| `sdk/packages/core/src/action-resolver.ts` | `uses:` → shell script resolver (fetches action.yml from GitHub) |
| `sdk/packages/cli/src/commands/check.ts` | `cb check` command — full sealed runner pipeline |
| `sdk/packages/core/src/workflow.ts` | Workflow builder (`.circuit()` method for SmolVM actions) |
| `sdk/packages/core/src/schema.ts` | `CircuitActionSchema` Zod type |

### How It Works (Code Path)

```
cb check -w ci.yml -s /path/to/project
  │
  ├─ check.ts: loadWorkflow() → fromGitHubActionsFile()
  │    └─ github-actions.ts: parse YAML, validate workflow
  │
  ├─ check.ts: parseYAML() → separateSteps()
  │    ├─ uses: steps → usesSteps[] (for build phase)
  │    └─ run: steps → runSteps[] (for execution phase)
  │
  ├─ runner-baseline.ts: runnerCacheKey(image, usesSteps)
  │    └─ SHA-256 of image + sorted uses refs + with inputs
  │
  ├─ check.ts: existsSync(cachePath)?
  │    ├─ YES → "Using cached runner"
  │    └─ NO → buildSealedRunner()
  │         ├─ createBuilderVM(image)             smolvm machine create + start
  │         ├─ for step of BASELINE_INSTALL_STEPS  smolvm machine exec (×7)
  │         ├─ execInBuilder(GITHUB_ACTIONS_SHIM)  smolvm machine exec
  │         ├─ for step of usesSteps:
  │         │    resolveAction(uses, with)          fetch action.yml from GitHub
  │         │    execInBuilder(resolved script)     smolvm machine exec
  │         ├─ sealBuilder()                        smolvm machine stop + pack create
  │         └─ destroyVM(builder)                   smolvm machine delete
  │
  ├─ check.ts: bootSealedRunner(cachePath, source)
  │    ├─ smolvm machine create --from <cache>.smolmachine
  │    │    --volume <parent-dir>:/projects --net cb-check
  │    └─ smolvm machine start --name cb-check
  │
  ├─ check.ts: for step of runSteps:
  │    └─ execRunStep(command, workdir)
  │         └─ smolvm machine exec --name cb-check -- bash -c
  │              "source /tmp/.cb/github_env + github_path; cd /projects/<name>; CMD"
  │
  └─ check.ts: destroyVM(cb-check)
       └─ smolvm machine stop + delete
```

### Dependencies

- **Runtime:** `smolvm` binary (installed via `curl -sSL https://smolmachines.com/install.sh | bash`)
- **SDK:** `bun` (runs the TypeScript CLI)
- **Network:** Required during build phase (apt-get, rustup, action.yml fetch). Run phase is offline if commands don't need network.
- **No Docker. No Dagger. No GitHub Actions Runner binary.**

## What We Don't Build

- **GitHub Actions Runner binary compatibility** — we execute commands directly
- **Twirp API emulation** — no mock server
- **Azure Blob artifact protocol** — overlay persistence replaces artifacts
- **Cache REST API** — sealed runner IS the cache
- **JavaScript action runtime** — composite actions only (covers the majority)
- **Reusable workflow resolution** — future item
- **Matrix expansion** — future item

## What's Next

### Immediate

1. **Overlay snapshots per step** — snapshot after each `run:` step so `--from <step>` can rollback to pre-failure state instead of re-running from the beginning.
2. **Multi-job support** — the YAML parser already handles `needs:` dependencies. Wire up parallel job execution with multiple sealed runners.
3. **`cb runner build` command** — interactive flow to build a sealed runner manually. `cb runner build --image ubuntu:24.04 --name my-rust-runner` → shell into VM, install tools, `cb runner seal`.
4. **`cb runner list`** — show cached runners with their cache keys, sizes, and what tools they contain.

### Future

5. **NATS streaming** — per-step log streaming to NATS for real-time monitoring.
6. **`runs-on:` registry** — `runs-on: cb-rust-executor` maps to a named sealed runner in `~/.cb/runners/`. Workflow authors write only `run:` steps. No `uses:` needed.
7. **Remote fleet execution** — same sealed `.smolmachine` shipped to remote SmolVM hosts. Same commands, different machine.
8. **Atomic provenance** — circuit run results recorded in Atomic's content-addressed DAG for SLSA compliance.