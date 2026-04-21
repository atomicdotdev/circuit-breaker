# Agent CI Progress Report

## What We Proved

On April 20, 2026, we validated the full Circuit Breaker + SmolVM pipeline end-to-end. Every layer of the stack connected and executed correctly.

### The Pipeline (Working)

```
./cb run .github/workflows/ci.yml --watch
  │
  ├─ TypeScript SDK parses GitHub Actions YAML
  │  └─ fromGitHubActions() converts YAML → Workflow IR with Circuit actions
  │
  ├─ cb-api receives the workflow via HTTP POST
  │  └─ Publishes WorkflowSubmitted to NATS JetStream
  │
  ├─ cb-controller initializes the Petri net marking
  │  └─ Publishes TransitionEnabled for the first step
  │
  ├─ cb-runner picks up the transition from NATS
  │  └─ Sees Action::Circuit, calls execute_circuit()
  │
  ├─ execute_circuit() creates a SmolVM
  │  └─ circuit machine create --image ubuntu:24.04 --net --volume ./:/workspace cb-run-<id>
  │  └─ circuit machine start --name cb-run-<id>
  │  └─ circuit machine exec --name cb-run-<id> -- sh -c "cd /workspace && cargo fmt --all -- --check"
  │
  ├─ Logs published to NATS per transition
  │  └─ cb.runs.<run_id>.logs.<transition_id>
  │
  └─ Results flow back to CLI
     └─ ✓ passed / ✗ failed with step name and output
```

### What Each Component Does

| Component | Status | What it does |
|-----------|--------|-------------|
| `fromGitHubActions()` | ✅ Working | Parses `.yml`, extracts `run:` steps as transitions, resolves `runs-on:` to OCI image |
| `cb run *.yml` | ✅ Working | Detects YAML extension, calls converter, submits to API |
| `cb-api` | ✅ Working | Receives workflow, publishes to NATS, creates run |
| NATS JetStream | ✅ Working | Running as a SmolVM (`cb-nats`), ports 4222/8222 exposed |
| `cb-controller` | ✅ Working | Initializes marking, fires enabled transitions |
| `cb-runner` | ✅ Working | Picks up transitions, dispatches by action type |
| `Action::Circuit` | ✅ Working | New action type in `cb-core`, handled by runner |
| `execute_circuit()` | ✅ Working | Creates SmolVM, mounts source, execs command, publishes logs |
| VM reuse | ✅ Working | Same VM reused across transitions in a single run |
| VM cleanup | ⚠️ Manual | Runner creates VMs but doesn't clean up after run completes |

### Test Run Output

```
$ ./cb run /Users/leefaus/Projects/circuit-vm/.github/workflows/ci.yml --watch
✔ Loaded: ci
✔ Submitted: fdc6601b-dad1-49de-bec0-f6f95c13259a
✔ Started run: f98420f9-9722-4b33-9ffb-c8f02c73a0b3

Watching for updates...

⟳ Status: running
✗ Status: failed

✗ Workflow failed
  Circuit command failed (exit 127): sh: 1: cargo: not found
```

The failure is correct — `ubuntu:24.04` doesn't have Rust. The workflow has `uses: dtolnay/rust-toolchain@stable` which installs Rust, but we skip `uses:` steps in v1. The pipeline itself works perfectly.

### Runner Log

```
INFO  cb_runner: Processing task task_id=2a3cbfb7 transition_id=step-0 run_id=f98420f9
INFO  cb_runner: Executing circuit action vm_name=cb-run-f98420f9 image=ubuntu:24.04 command=cargo fmt --all -- --check
INFO  cb_runner: Creating circuit VM vm_name=cb-run-f98420f9 image=ubuntu:24.04
INFO  cb_runner: Circuit VM ready vm_name=cb-run-f98420f9
ERROR cb_runner: Task failed error=Circuit command failed (exit 127): sh: 1: cargo: not found duration_ms=7995
```

The VM booted in ~5 seconds (including image pull), executed the command, and reported back. On subsequent runs the image is cached and boot is <1 second.

## What We Built

### New Files

**circuit-breaker (orchestrator):**
- `sdk/packages/core/src/github-actions.ts` — GitHub Actions YAML → Workflow IR converter
- `sdk/packages/cli/src/commands/check.ts` — `cb check` command (direct execution path)
- `engine/crates/cb-core/src/workflow.rs` — Added `Action::Circuit` and `CircuitAction` type
- `engine/crates/cb-runner/src/main.rs` — Added `execute_circuit()` method
- `engine/crates/cb-runner/src/lib.rs` — Added `Circuit` variant to action executor
- `sdk/packages/core/src/schema.ts` — Added `CircuitActionSchema` to Zod schemas
- `sdk/packages/core/src/workflow.ts` — Added `.circuit()` builder method

**circuit-vm (execution substrate):**
- Full workspace: `circuit-core`, `circuit-runner`, `circuit-registry`, `circuit-cli`
- `circuit` binary — superset of `smolvm` (all machine commands + circuit validate)
- Circuit definition parser with Petri net (7 passing tests)
- `.github/workflows/ci.yml` — our own CI workflow

**smolvm (fork):**
- `src/lib.rs` — Added `extern crate self as smolvm;` + `pub mod cli;` (2 lines)
- `src/main.rs` — Changed `mod cli` to `use smolvm::cli` (1 line)
- Feature branch: `feat/expose-cli-module` (ready for upstream PR)

**Documentation:**
- `docs/architecture/circuit-vm-implementation.md` — Full 6-phase implementation plan
- `docs/architecture/smolvm-desktop.md` — Tauri desktop UI spec
- `docs/architecture/agent-ci-strategy.md` — Agent CI strategy and comparison with RedwoodJS agent-ci

### Architecture Decisions Made

1. **circuit-vm is the VM runtime, circuit-breaker is the orchestrator.** Clear separation. circuit-vm knows nothing about NATS, workflows, or agents. cb knows nothing about hypervisors.

2. **`circuit` binary is a superset of `smolvm`.** One install. All smolvm commands available via `circuit machine *`. Enabled by a 3-line change in the smolvm fork (`extern crate self as smolvm` + `pub mod cli`).

3. **NATS runs as a SmolVM.** `cb-nats` is a persistent machine created from the `nats` OCI image with ports 4222/8222 exposed. No separate NATS installation.

4. **GitHub Actions YAML is converted to Workflow IR in the TypeScript SDK.** Same pipeline as hand-written `.ts` workflows. The YAML is just another frontend.

5. **`Action::Circuit` is a new action type in cb-core.** The runner handles it by calling `circuit machine create/start/exec`. The VM is created per workflow run and reused across transitions.

6. **`cb check` exists as a direct execution path** (bypasses the API/NATS/runner for quick local checks) but the proper path through the full stack also works.

## What's Next

### Immediate: `uses:` → OCI Overlay Resolution

The blocker for real-world workflows. Each `uses:` step (like `dtolnay/rust-toolchain@stable`) needs to resolve to an OCI image that gets stacked as a read-only overlay in the VM. Without this, the VM only has what the base `runs-on` image provides.

Approach:
- `uses: dtolnay/rust-toolchain@stable` → pull the action's OCI image → stack as overlay
- `uses: actions/checkout@v4` → no-op locally (source already mounted via --volume)
- `uses: actions/setup-node@v4` → resolve to `node:{version}` overlay
- Each overlay is a read-only layer; `run:` steps execute on a read-write layer on top

### Then: Phase 2 — Overlay Snapshots

Once `uses:` resolution works, each `run:` step gets its own overlay snapshot. This enables:
- `cb check --from <step>` — rollback to pre-failure snapshot, re-run from there
- Overlay deltas as content-addressed artifacts (Blake3)
- Cache that's automatic — no `actions/cache` needed

### Then: VM Cleanup

The runner creates VMs but doesn't clean them up after a run completes. Need to add cleanup on:
- Successful completion of all transitions
- Workflow failure (after preserving state for debugging)
- Runner shutdown

### Then: `cb check` as Agent Hook

Once `uses:` resolution works and VMs clean up properly:
- Add `cb check` instructions to CLAUDE.md
- Agent runs `cb check` before reporting work as done
- Failures include step name and output for the agent to act on
- `--from <step>` lets the agent skip already-passed steps on retry

## Infrastructure Running

| Service | How | Port | Status |
|---------|-----|------|--------|
| NATS JetStream | `circuit machine` (`cb-nats`) | 4222, 8222 | Running |
| cb-api | `cargo run --bin cb-api` | 9000 | Running |
| cb-runner | `cargo run --bin cb-runner` | — | Running |
| circuit binary | `circuit-vm/target/debug/circuit` | — | In PATH |

## Files Modified (Not Yet Committed)

### circuit-breaker
- `sdk/packages/core/src/github-actions.ts` (new)
- `sdk/packages/core/src/index.ts` (exports added)
- `sdk/packages/core/src/schema.ts` (CircuitActionSchema added)
- `sdk/packages/core/src/workflow.ts` (.circuit() builder added)
- `sdk/packages/core/package.json` (yaml dependency added)
- `sdk/packages/cli/src/index.ts` (.yml support + check import)
- `sdk/packages/cli/src/commands/check.ts` (new)
- `engine/crates/cb-core/src/workflow.rs` (CircuitAction type added)
- `engine/crates/cb-runner/src/main.rs` (execute_circuit added)
- `engine/crates/cb-runner/src/lib.rs` (Circuit action handling added)
- `docs/architecture/agent-ci-strategy.md` (new)
- `docs/architecture/agent-ci-progress.md` (this file)

### circuit-vm
- All files are new (initial scaffold)

### smolvm (fork)
- `src/lib.rs` (2 lines: extern crate + pub mod cli)
- `src/main.rs` (1 line: mod cli → use smolvm::cli)
- Branch: `feat/expose-cli-module`

---

## What We Learned (April 20, 2026 — Late Session)

### The Wrong Model: Action Resolution via Shell Script Generation

We spent hours trying to make `uses:` steps work by:

1. Fetching the action's `action.yml` from GitHub
2. Parsing its composite `runs.steps`
3. Substituting `${{ inputs.* }}` and `${{ steps.*.outputs.* }}` variables
4. Generating a bash script with a `GITHUB_OUTPUT`/`GITHUB_ENV`/`GITHUB_PATH` shim
5. Running the generated script inside a bare `ubuntu:24.04` VM

This approach had cascading problems:
- `ubuntu:24.04` doesn't have `curl`, `bash` needed to run the toolchain script
- `GITHUB_OUTPUT`/`GITHUB_ENV` files created with `mktemp` don't persist across `exec` sessions
- Fixed-path files (`/tmp/.cb/github_env`) persist on the overlay but `machine exec` doesn't inherit env vars between calls
- The `dtolnay/rust-toolchain` action.yml uses `${{ steps.parse.outputs.toolchain }}` which requires runtime cross-step output forwarding — essentially reimplementing the GitHub Actions Runner
- Profile sourcing hacks (`. $HOME/.cargo/env`) to carry PATH across exec sessions
- All of this is reinventing what `act` and Agent CI already do — and they do it better because they run the official runner binary

**We were solving the wrong problem.**

### The Right Model: OCI Images as Pre-Baked VMs via `smolvm pack`

SmolVM already has the answer: `smolvm pack create --image <OCI> -o <output>`.

This takes any OCI image, extracts its layers, and produces a `.smolmachine` file — a self-contained, portable VM with all dependencies pre-baked. Boots in <200ms.

**Proven working:**

```bash
# Pack the rust:slim OCI image into a portable VM
smolvm pack create --image rust:slim -o /tmp/rust-toolchain
# Result: /tmp/rust-toolchain (stub: 20MB) + /tmp/rust-toolchain.smolmachine (262MB)

# Verify — boots in <200ms, Rust is pre-baked
/tmp/rust-toolchain run -- rustc --version
# rustc 1.95.0 (59807616e 2026-04-14)

# Create a persistent machine from the pack with source mounted
smolvm machine create --from /tmp/rust-toolchain.smolmachine \
  --net --volume /Users/leefaus/Projects:/projects cb-rust
smolvm machine start --name cb-rust

# Run CI steps — all pass, all inside a hardware-isolated VM
smolvm machine exec --name cb-rust -- bash -c \
  'export PATH=/usr/local/cargo/bin:$PATH && \
   export RUSTUP_HOME=/usr/local/rustup && \
   export CARGO_HOME=/usr/local/cargo && \
   cd /projects/circuit-vm && \
   cargo fmt --all -- --check && \
   cargo clippy -p circuit-core -- -D warnings && \
   cargo test -p circuit-core'
# ✓ fmt, ✓ clippy, ✓ test (7 passed) — ALL PASSED
```

### The Correct Architecture

Each `uses:` step in a GitHub Actions workflow maps to an OCI image. That OCI image gets packed into a `.smolmachine`. The `.smolmachine` becomes a persistent VM. The `run:` steps execute inside that VM. Source code is a shared volume mount.

```
ci.yml:
  uses: actions/checkout@v4          → skip (source is the shared volume)
  uses: dtolnay/rust-toolchain@stable → resolved to OCI image: rust:slim
                                       → smolvm pack create --image rust:slim
                                       → .smolmachine cached after first run
  run: cargo fmt --all -- --check    → smolvm machine exec inside the packed VM
  run: cargo clippy ...              → smolvm machine exec inside the packed VM
  run: cargo test                    → smolvm machine exec inside the packed VM
```

**The hard problem: `uses:` → OCI image resolution.**

There is no static mapping table. The GitHub Actions ecosystem has thousands of
actions, each with different inputs, versions, and behaviors. A hardcoded lookup
table would need every combination and permutation — and it would be wrong the
moment someone publishes a new action or changes a version scheme.

The proper resolver needs to:

1. Read the `uses:` reference (e.g., `dtolnay/rust-toolchain@stable`)
2. Fetch its `action.yml` from GitHub (we already built this)
3. Parse what the action actually installs — the action.yml describes the tool
4. Search Docker Hub / OCI registries for images that have those tools pre-baked
5. Match the version from the action's inputs (e.g., `@stable` → `rust:slim`,
   `@1.79.0` → `rust:1.79-slim`, `with: node-version: 20` → `node:20`)

For the demo we proved it manually with `rust:slim`. Building the general
resolver is real work — it needs to understand the relationship between
GitHub Actions and OCI images, which is not a 1:1 mapping.

**What we skip (no OCI image needed):**

- `actions/checkout@v4` — source mounted via `--volume`
- `actions/cache@v4` — persistent overlay IS the cache

**The flow:**

```
1. Parse ci.yml
2. For each uses: → resolve to OCI image
3. smolvm pack create --image <oci> -o ~/.cb/packs/<hash> (cached)
4. smolvm machine create --from <pack>.smolmachine --volume <source>:/projects <vm-name>
5. smolvm machine start --name <vm-name>
6. For each run: → smolvm machine exec --name <vm-name> -- bash -c "<command>"
7. smolvm machine stop + delete (or keep for retry)
```

**First run:** pack create takes ~30-60s (pull + extract + compress). Cached after that.
**Subsequent runs:** machine create from `.smolmachine` boots in <250ms. No pull, no install.

### Known Issue: OCI Image ENV Not Inherited by `machine exec`

SmolVM's `machine exec` doesn't inherit environment variables from the OCI image config (`ENV PATH=...`, `ENV CARGO_HOME=...`). The `pack run` command does — because it reads the manifest. But `machine exec` into a machine created with `--from` does not.

**Workaround:** Set the env vars explicitly:
```bash
smolvm machine exec --name cb-rust -- bash -c \
  'export PATH=/usr/local/cargo/bin:$PATH && \
   export RUSTUP_HOME=/usr/local/rustup && \
   export CARGO_HOME=/usr/local/cargo && \
   <command>'
```

**Fix:** Upstream PR to SmolVM — `machine exec` should read the OCI image's `ENV` from the manifest and apply them to the exec session. This is not a hack — it's how Docker does it and it's the correct behavior.

### What This Means for the Runner

The `cb-runner`'s `execute_circuit` should:

1. **Resolve** the `uses:` action to an OCI image name (simple mapping table)
2. **Check cache** at `~/.cb/packs/<image-hash>.smolmachine`
3. **Pack** if not cached: `smolvm pack create --image <oci> -o <cache-path>`
4. **Create** VM: `smolvm machine create --from <pack> --volume <source>:/projects <vm-name>`
5. **Start** VM: `smolvm machine start --name <vm-name>`
6. **Exec** each `run:` step with the OCI image's ENV applied
7. **Cleanup** after the run completes

No action.yml fetching. No composite step parsing. No GITHUB_OUTPUT shim. No shell script generation. The OCI image IS the pre-baked environment. The pack IS the cached, portable artifact. SmolVM handles the rest.

### What to Build Next

1. **`uses:` → OCI image resolver** — the hard problem. Needs to parse the action.yml, understand what tool the action installs, and find the corresponding OCI image. Not a lookup table — a proper parser that can handle arbitrary actions.
2. **Pack cache** — `~/.cb/packs/` directory with content-addressed `.smolmachine` files. First run packs the image (~30-60s). Subsequent runs boot from cache (<250ms).
3. **ENV inheritance** — upstream PR to SmolVM for `machine exec` to inherit OCI image ENV. The fix is ~5 lines in `ExecCmd::run()` — call `client.query(image)` to get `ImageInfo.env` and merge into the `RunConfig`. The data is already there, `ExecCmd` just doesn't use it.
4. **Runner update** — `execute_circuit` uses the pack model: resolve → pack (cached) → create from pack → exec → cleanup.

---

## What We Learned (April 21, 2026 — The Sealed Runner Model)

### The Missing Abstraction: Runners, Not Action Resolvers

The April 20 session ended with "build a general `uses:` → OCI image resolver" as the next step. That was still wrong. The resolver approach has the same fundamental problem as shell script generation — it tries to map GitHub's ecosystem into ours 1:1.

The breakthrough: **we don't need to resolve `uses:` at all for the common case.** We need *runners*.

### The Model: Build → Register → Dispatch

Three clean concerns:

1. **Build the runner** — manual, one-time, shell commands. You craft the executor VM the same way you'd build a Dockerfile. You decide what tools go in it. You seal it. It's an artifact you own.

2. **Register it by name** — `cb-rust-executor.smolmachine` sits in a known location. Circuit Breaker knows about it. It's like registering a self-hosted runner on GitHub Actions — "this runner has Rust, use it for Rust jobs."

3. **Circuit Breaker dispatches to it** — when a workflow comes in, CB looks at the job, picks the right registered runner, boots it from the sealed `.smolmachine`, mounts the source, execs the `run:` steps, reports results.

### What the Workflow Author Writes

```yaml
jobs:
  check:
    runs-on: cb-rust-executor    # ← the name of our sealed runner
    steps:
      - run: cargo fmt --all -- --check
      - run: cargo clippy -p circuit-core -- -D warnings
      - run: cargo test -p circuit-core
```

No `uses:` steps needed. No action resolution. No toolchain install. The runner already has everything. `runs-on` picks the runner. `run:` steps execute inside it.

### Building a Runner from the Shell

```bash
# Start with a base image
smolvm machine create --net --image ubuntu:24.04 cb-rust-executor
smolvm machine start --name cb-rust-executor

# Install tools (same as you'd do in a Dockerfile)
smolvm machine exec --name cb-rust-executor -- bash -c "apt-get update && apt-get install -y curl build-essential"
smolvm machine exec --name cb-rust-executor -- bash -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"

# Seal it — one VM with all tools, reusable
smolvm pack create --from-vm cb-rust-executor -o cb-rust-executor
# Result: cb-rust-executor.smolmachine (~262MB, boots in <250ms)
```

The sealed `.smolmachine` is the runner. Register it by name, and CB dispatches to it.

### Complex Workflows: Scanning `uses:` to Build the Executor

For workflows that *do* have `uses:` steps, CB doesn't need a general-purpose resolver. It scans them **up front** to understand what tools are needed, builds **one VM** with everything, and seals it.

Given this workflow:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4          # skip — volume mount
      - uses: dtolnay/rust-toolchain@stable # install rust
      - uses: actions/setup-node@v4         # install node
        with:
          node-version: '20'
      - uses: taiki-e/install-action@v2     # install cargo tool
        with:
          tool: cargo-nextest
      - run: cargo fmt --check
      - run: cargo test
      - run: npm run build-wasm
```

CB parses that, sees 3 `uses:` that need tools. Builds one VM:

```bash
smolvm machine create --net --image ubuntu:24.04 cb-build-executor
smolvm machine start --name cb-build-executor

# Resolve each uses: action.yml → execute its install steps
smolvm machine exec --name cb-build-executor -- bash -c "<prereqs>"
smolvm machine exec --name cb-build-executor -- bash -c "<rust-toolchain script>"
smolvm machine exec --name cb-build-executor -- bash -c "<setup-node script>"
smolvm machine exec --name cb-build-executor -- bash -c "<install-action script>"

# Seal — one VM with all tools
smolvm pack create --from-vm cb-build-executor -o cb-build-executor
```

### The Petri Net Executes Inside the Sealed Runner

Now the Petri net has the executor. Each `run:` step is a transition. The net knows the VM name and execs each transition in order:

```
executor: cb-build-executor.smolmachine

[start] → (fmt)       → [formatted]
                       → (test)    → [tested]
                                   → (build-wasm) → [done]

Each transition: smolvm machine exec --name <run-id> -- bash -c "<command>"
```

### Caching: Build Once, Run Many

The executor is built once, cached, reused. The cache key is the `uses:` steps (their references and `with:` inputs). If the `ci.yml` changes its `uses:` steps, rebuild the executor. If only `run:` steps change, reuse the existing one.

This means:
- **First run:** Build executor (~30-60s to install tools + seal). Then run transitions.
- **Subsequent runs:** Boot from sealed `.smolmachine` (<250ms). Just run transitions.
- **`uses:` change:** Invalidate cache, rebuild executor. Transitions still run the same way.
- **`run:` change:** No rebuild needed. Same executor, different commands.

### Why This Is Better Than Action Resolution

| Approach | Problem |
|----------|---------|
| Shell script generation (April 20, attempt 1) | Reimplements the GitHub Actions Runner. `GITHUB_OUTPUT`/`GITHUB_ENV` shims, cross-step variable forwarding, profile sourcing. Impossible to maintain. |
| OCI image resolution (April 20, attempt 2) | No static `uses:` → OCI mapping exists. Thousands of actions, each with different inputs. A "general resolver" is unbounded work. |
| **Sealed runner model (April 21)** | Scan `uses:` for what tools to install. Build one VM. Seal it. Run `run:` steps inside. The runner IS the resolved environment. No mapping table. No shims. |

The key insight: **`uses:` steps tell you what to install, not what to run.** You scan them all up front, build one VM with everything, seal it. Then the Petri net runs the `run:` steps inside it.

### What to Build Next (Revised)

1. **Runner registry** — a directory of named `.smolmachine` files (`~/.cb/runners/`). `runs-on: cb-rust-executor` maps to `~/.cb/runners/cb-rust-executor.smolmachine`. Simple name → path lookup.

2. **`cb runner build` command** — interactive or Dockerfile-like flow to build a runner. `cb runner build --image ubuntu:24.04 --name cb-rust-executor` → starts a VM, lets you install tools, then seals it.

3. **`uses:` scanner** — parses `uses:` steps from ci.yml, fetches each action's `action.yml`, extracts install commands. Not a general resolver — just enough to feed `smolvm machine exec` calls that install the tools. The output is a sealed runner, not a translation layer.

4. **Cache key computation** — hash the `uses:` references + `with:` inputs to produce a cache key. If the key matches an existing `.smolmachine`, skip the build.

5. **Demo tomorrow** — build a Rust runner from the shell, register it, show CB dispatching `run:` steps to it via the Petri net. No `uses:` resolution needed for the demo — the runner is pre-built.
