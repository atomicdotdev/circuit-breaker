# Circuit Breaker: SmolVM Circuit Architecture — Implementation Plan

## Vision

Circuit Breaker becomes an agent-native workflow orchestrator where the execution primitive is a hardware-isolated microVM, not a container. Pre-baked, domain-specific VMs ("circuits") run verification sweeps — quality, security, coverage, review — that AI agents invoke as tools in their inner loop. The build graph is stored in Atomic's content-addressed DAG, making provenance structural and SLSA compliance an emergent property of the architecture.

## Principles

1. **Each phase ships something testable.** No phase depends on a future phase to be useful.
2. **SmolVM first, integration second.** Validate the VM substrate before wiring it into the orchestrator.
3. **Local first, remote second.** Get the single-machine experience right before adding distributed execution.
4. **Atomic last.** The provenance graph linkage is the capstone, not the foundation.

---

## Phase 0 — SmolVM Standalone Validation

**Goal:** Confirm SmolVM works as our execution substrate on macOS (Apple Silicon) and Linux (EC2/KVM). No Circuit Breaker code yet. Just SmolVM, OCI images, overlays, and snapshots.

**Stands on its own as:** A validated technical feasibility report with benchmarks and a working overlay/snapshot prototype.

### 0.1 — Local Mac Validation

- [ ] Install SmolVM on macOS Apple Silicon (`curl -sSL https://smolmachines.com/install.sh | bash`)
- [ ] Boot an Alpine VM: `smolvm machine run --image alpine -- uname -a`
- [ ] Measure cold boot time (target: <200ms)
- [ ] Test persistent machines: `create`, `start`, `exec`, `stop`, `start` (state survives)
- [ ] Test volume mounts: mount a local project directory into the VM, verify read/write
- [ ] Test network controls: `--net` off (default), `--net` on, `--allow-host` for specific hosts
- [ ] Test SSH agent forwarding: `--ssh-agent`, verify `ssh-add -l` inside VM shows host keys
- [ ] Test elastic memory: boot with `--mem 8192`, monitor host memory usage under light/heavy guest load
- [ ] Test parallel VMs: boot 4 Alpine VMs simultaneously, measure aggregate resource usage
- [ ] Document: boot times, memory overhead per VM, balloon reclaim behavior, max concurrent VMs on 16GB machine

### 0.2 — AWS/Linux Validation

- [ ] Provision an EC2 instance with KVM support (e.g., `m6i.metal` or nested virt on `.xlarge`)
- [ ] Install SmolVM on Linux
- [ ] Repeat all tests from 0.1 on Linux/KVM
- [ ] Measure performance differences: boot time, memory overhead, CPU overhead vs macOS
- [ ] Test with larger VMs: 8 vCPU, 16GB RAM workloads
- [ ] Test 10+ concurrent VMs (simulating a fleet handling multiple agent requests)
- [ ] Document: instance type recommendations, cost per VM-hour, performance comparison with macOS

### 0.3 — OCI Image + Overlay Prototype

- [ ] Build a custom OCI image with quality tools pre-installed (eslint, prettier, jest, c8)
- [ ] Boot the custom image as a SmolVM, verify tools are available
- [ ] Test `smolvm pack create` to produce a `.smolmachine` from the running VM
- [ ] Test rehydration: boot the `.smolmachine` on a different host (or clean state), verify tools still present
- [ ] **Overlay prototype** (inside the guest Linux VM):
  - [ ] Set up overlayfs: base layer (read-only) + upper layer (read-write)
  - [ ] Run a command (e.g., eslint), observe filesystem changes in upper layer
  - [ ] Snapshot the upper layer (`tar czf snapshot-t1.tar.gz /overlay/upper/`)
  - [ ] Add a second overlay on top, run another command (e.g., jest)
  - [ ] Snapshot the second upper layer
  - [ ] **Rollback test:** remove second overlay, verify filesystem matches snapshot-t1
  - [ ] **Branch test:** from snapshot-t1, create two parallel overlays (simulating fan-out)
- [ ] Measure: overlay creation time, snapshot size for typical operations, rollback time
- [ ] Document: overlay mechanics, snapshot format, limitations (max depth, performance at depth)

### 0.4 — Smolfile + Pre-baked Machine Images

- [ ] Write Smolfiles for four domain machines:
  - `quality.smolfile`: eslint, prettier, jest, c8, pylint
  - `security.smolfile`: semgrep, trivy, gitleaks, grype
  - `coverage.smolfile`: jest, pytest, go test, lcov, coverage-reporter
  - `review.smolfile`: git, language runtimes, LSP servers
- [ ] Build each as a `.smolmachine` via `smolvm pack create`
- [ ] Measure packed file sizes
- [ ] Boot each, run representative workloads against a sample project
- [ ] Benchmark: time from `smolvm machine run` to first tool output
- [ ] Document: Smolfile format, build process, image sizes, boot-to-first-output times

### Phase 0 Exit Criteria

- SmolVM boots in <200ms on both macOS and Linux
- 4 concurrent VMs run on a 16GB Mac without swap pressure
- Overlay snapshot/rollback works reliably in the guest
- Pre-baked domain machines boot and run tools successfully
- All benchmarks documented in `docs/architecture/smolvm-benchmarks.md`

---

## Phase 1 — Circuit Model in Circuit Breaker

**Goal:** Replace Dagger/Docker as the execution layer. A "circuit" is a workflow bound to a single SmolVM machine. Transitions run inside the VM. The runner boots one VM per workflow and executes transitions as commands inside it.

**Stands on its own as:** A working workflow orchestrator that runs real quality/security/coverage checks in hardware-isolated VMs instead of containers.

### 1.0 — Sealed Runner Model (Core Insight)

The fundamental execution model: **Build → Register → Dispatch**.

1. **Build the runner** — one-time setup using shell commands or `cb runner build`. Install all tools needed for a job type (Rust toolchain, Node, linters, etc.) into a SmolVM. Seal it with `smolvm pack create --from-vm`.

2. **Register by name** — the sealed `.smolmachine` sits in `~/.cb/runners/<name>.smolmachine`. Circuit Breaker knows about it. Like registering a self-hosted runner on GitHub Actions — "this runner has Rust, use it for Rust jobs."

3. **Dispatch `run:` steps** — when a workflow arrives, CB reads `runs-on:`, finds the registered runner, boots it from the sealed `.smolmachine` (<250ms), mounts source via `--volume`, execs each `run:` step as a Petri net transition, reports results.

**Simple workflow (pre-built runner):**

```yaml
jobs:
  check:
    runs-on: cb-rust-executor    # sealed runner, pre-built
    steps:
      - run: cargo fmt --all -- --check
      - run: cargo clippy -p circuit-core -- -D warnings
      - run: cargo test -p circuit-core
```

No `uses:` steps. No action resolution. No toolchain install at runtime. The runner already has everything. `runs-on` picks the runner. `run:` steps execute inside it.

**Complex workflow (CB builds the runner from `uses:` steps):**

For workflows with `uses:` steps, CB scans them **up front** to determine what tools to install. It builds **one VM** with everything, seals it, and caches it. The `run:` steps execute inside the sealed VM via the Petri net.

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

CB parses that, sees 3 `uses:` that need tools, builds one VM:

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

**Petri net execution** — each `run:` step is a transition in the net:

```
executor: cb-build-executor.smolmachine

[start] → (fmt)       → [formatted]
                       → (test)    → [tested]
                                   → (build-wasm) → [done]

Each transition: smolvm machine exec --name <run-id> -- bash -c "<command>"
```

**Caching** — the cache key is the `uses:` references + `with:` inputs. If only `run:` steps change, the sealed runner is reused. If `uses:` steps change, the runner is rebuilt and re-sealed. First build: ~30-60s. Subsequent runs from cache: <250ms boot.

- [ ] Implement runner registry (`~/.cb/runners/` directory, name → `.smolmachine` lookup)
- [ ] Implement `cb runner build` — interactive or scripted flow to build and seal a runner
- [ ] Implement `uses:` scanner — parse `uses:` steps, fetch `action.yml`, extract install commands
- [ ] Implement cache key computation — hash `uses:` refs + `with:` inputs → cache hit/miss
- [ ] Implement `runs-on:` resolution — map `runs-on` value to registered runner or trigger auto-build

### 1.1 — Circuit Definition Format

- [ ] Define the circuit TOML schema:

```toml
[circuit]
name = "security"
version = "1.4"
description = "SAST, SCA, secret detection, license audit"

[machine]
image = "cb/security:1.4"           # .smolmachine or OCI image
cpus = 4
memory = "4Gi"

[network]
enabled = true
allow_hosts = ["nvd.nist.gov", "ghcr.io"]

[outlets]
source = { type = "volume", mount = "/workspace", required = true }
results = { type = "output", format = "cb-result", path = "/output/results.json" }

[breaker]
timeout = "10m"
max_findings_critical = 0
max_findings_high = 5

[[transition]]
id = "sast"
run = "semgrep scan --config=auto /workspace --sarif -o /output/sast.sarif"

[[transition]]
id = "sca"
after = "sast"
run = "trivy fs /workspace --format sarif -o /output/sca.sarif"

[[transition]]
id = "secrets"
after = "sast"
run = "gitleaks detect --source /workspace --report-format sarif --report-path /output/secrets.sarif"

[[transition]]
id = "report"
after = ["sca", "secrets"]
run = "/usr/local/bin/merge-results /output/*.sarif > /output/results.json"
```

- [ ] Implement `Circuit` struct in Rust (`cb-core`) that parses this format
- [ ] Implement `Transition` ordering — build the Petri net from `after` declarations
- [ ] Implement `Outlet` types: volume (input), output (structured results), artifact (files)
- [ ] Implement `Breaker` conditions: timeout, finding thresholds, memory limit
- [ ] Validate: circuit definition → Petri net → check for cycles, unreachable transitions
- [ ] Write unit tests for parsing, validation, Petri net construction

### 1.2 — SmolVM Executor with Runner Dispatch

- [ ] Add `RunnerExecutor` to `cb-runner` (replaces `ActionExecutor` concept)
- [ ] Implement runner resolution:
  - `runs-on: cb-rust-executor` → lookup `~/.cb/runners/cb-rust-executor.smolmachine`
  - `runs-on: ubuntu-latest` with `uses:` steps → auto-build sealed runner from `uses:` scan
  - Missing runner → error with `cb runner build` instructions
- [ ] Implement VM lifecycle from sealed runner:
  - `create(runner, run_id) → MachineHandle`: `smolvm machine create --from <runner>.smolmachine --volume <source>:/workspace <run-id>`
  - `start(handle)`: `smolvm machine start --name <run-id>`
  - `exec(handle, step) → StepResult`: `smolvm machine exec --name <run-id> -- bash -c "<command>"`
  - `stop(handle)`: `smolvm machine stop --name <run-id>` + `smolvm machine delete <run-id>`
- [ ] Implement source mounting: map working directory to `--volume <source>:/workspace`
- [ ] Implement result collection: read output files, parse SARIF/JSON after each step
- [ ] Implement breaker monitoring:
  - Watch for timeout per-step and per-job
  - Parse results after each step, check against breaker thresholds
  - If breaker trips: stop execution, preserve VM state, report which condition tripped
- [ ] Wire into NATS event flow: `TransitionEnabled` → boot from sealed runner → exec → `TransitionCompleted`

### 1.3 — SDK Update: `.machine()` and `.circuit()`

- [ ] Add `.machine()` to `WorkflowBuilder` in the TypeScript SDK:

```typescript
const pipeline = workflow('pre-push')
  .machine('cb/quality:3.0', {
    coverage_threshold: 80,
    lint_config: '.eslintrc.json',
  })
  .place('start', { initialTokens: 1 })
  .place('linted')
  .place('tested')
  .place('done')
  .transition('lint').from('start').to('linted').run('eslint /workspace/src').done()
  .transition('test').from('linted').to('tested').run('jest --coverage').done()
  .transition('report').from('tested').to('done').run('generate-report').done()
  .build();
```

- [ ] Add `.circuit()` for referencing pre-built circuit definitions:

```typescript
const pipeline = workflow('ci')
  .circuit('quality', 'cb/quality:3.0')
  .circuit('security', 'cb/security:1.4')
  .gate('all-passed', { requires: ['quality', 'security'] })
  .build();
```

- [ ] Update JSON IR to support machine/circuit actions alongside existing dagger/script/http
- [ ] Update `cb-api` to accept workflows with machine/circuit actions
- [ ] Keep backward compatibility: existing dagger/script workflows still work

### 1.4 — CLI: `cb run` with Circuits

- [ ] `cb run workflow.ts` — detects machine/circuit actions, uses SmolVM executor
- [ ] `cb run workflow.ts --watch` — streams transition results as they complete
- [ ] `cb circuit validate security.toml` — validates a circuit definition
- [ ] `cb circuit test security.toml --source ./my-project` — runs a circuit locally against a directory
- [ ] `cb circuit build security.toml -o security.smolmachine` — builds a packed machine from definition
- [ ] Output format: structured results per transition (pass/fail, duration, findings count, artifacts)

### Phase 1 Exit Criteria

- `cb circuit test cb/quality:3.0 --source ./project` runs lint+test+coverage in a SmolVM and reports results
- `cb run workflow.ts` executes a multi-circuit workflow (quality + security in parallel) with SmolVM
- No Docker daemon required. No Dagger. Just `smolvm` binary on the host.
- Existing dagger/script workflows still function (backward compatible)
- Breaker trips halt execution and report the reason

---

## Phase 2 — Overlay Snapshots and Rollback

**Goal:** Each transition executes on its own overlay inside the VM. Snapshots are captured between transitions. Rollback restores to a previous snapshot. Overlay deltas are sealable as artifacts.

**Stands on its own as:** A pipeline system with built-in time-travel — any transition failure can be rolled back to the previous good state and re-run without restarting the entire pipeline.

### 2.1 — Overlay Manager (Guest-Side Agent)

- [ ] Build a lightweight guest agent (`cb-agent`) that runs inside every circuit VM:
  - Written in Rust, statically compiled, included in base rootfs images
  - Listens on a vsock or unix socket for commands from the host runner
  - Manages overlayfs layers inside the guest
- [ ] Commands:
  - `create-overlay <transition-id>` → creates a new overlayfs upper dir, makes it active
  - `snapshot <transition-id>` → tars the current overlay upper dir, computes Blake3 hash
  - `rollback <transition-id>` → unmounts overlays above the target, restores that state
  - `branch <transition-id>` → forks from a snapshot (for parallel transitions)
  - `merge <t1> <t2> [t3...]` → combines overlay deltas from parallel branches
  - `seal <transition-id>` → produces a content-addressed artifact from the snapshot
  - `list-snapshots` → returns all snapshots with hashes, sizes, timestamps
- [ ] Overlay directory structure inside VM:

```
/circuit/
├── base/           # read-only, from machine image
├── workspace/      # source code (outlet mount)
├── overlays/
│   ├── t1/         # lint overlay upper dir
│   │   ├── upper/
│   │   └── work/
│   ├── t2/         # test overlay (stacked on t1)
│   │   ├── upper/
│   │   └── work/
│   └── t3/         # coverage overlay (stacked on t1+t2)
├── snapshots/
│   ├── t1.tar.zst  # sealed overlay delta
│   ├── t2.tar.zst
│   └── t3.tar.zst
└── output/         # structured results
```

### 2.2 — Runner Integration with Overlay Manager

- [ ] Update `SmolVMExecutor` to communicate with `cb-agent` inside the VM:
  - Before each transition: `create-overlay <transition-id>`
  - After each transition (success): `snapshot <transition-id>`
  - After each transition (failure): preserve overlay for debugging, report to runner
  - On rollback request: `rollback <target-transition-id>`
- [ ] Implement parallel transition execution:
  - When Petri net has multiple enabled transitions (fan-out): `branch` from parent snapshot
  - Each parallel transition gets its own overlay branch
  - On fan-in: `merge` the branches before the join transition
- [ ] Expose snapshot artifacts via the outlet system:
  - Each snapshot is a sealable artifact with Blake3 hash
  - Artifacts are referenced in `TransitionCompleted` events
  - Artifacts can be downloaded/inspected after the run

### 2.3 — CLI: Rollback and Snapshot Inspection

- [ ] `cb run workflow.ts --snapshot-after-each` — capture snapshots (default: on)
- [ ] `cb snapshots <run-id>` — list all snapshots for a run with hashes and sizes
- [ ] `cb rollback <run-id> <transition-id>` — roll back to the snapshot after a specific transition
- [ ] `cb rerun <run-id> --from <transition-id>` — rollback + re-run remaining transitions
- [ ] `cb inspect <run-id> <transition-id>` — show filesystem delta for a specific transition's overlay
- [ ] `cb diff <run-id> <t1> <t2>` — diff two snapshots within the same run
- [ ] `cb seal <run-id> <transition-id> -o artifact.tar.zst` — export a snapshot as a portable artifact

### 2.4 — Snapshot Content-Addressing

- [ ] Each snapshot gets a Blake3 hash of its overlay delta content
- [ ] Snapshots are stored locally in a content-addressed store: `~/.cb/snapshots/<hash[0:2]>/<hash>`
- [ ] Duplicate detection: if two transitions produce identical deltas, they share storage
- [ ] Snapshot metadata: transition ID, parent snapshot hash, timestamp, circuit version, run ID
- [ ] Manifest format (JSON):

```json
{
  "hash": "abc123...",
  "transition_id": "sast",
  "parent_hash": "def456...",
  "circuit": "cb/security:1.4",
  "run_id": "run-789",
  "timestamp": "2026-07-15T10:30:00Z",
  "size_bytes": 1048576,
  "findings_summary": {
    "critical": 0,
    "high": 2,
    "medium": 5
  }
}
```

### Phase 2 Exit Criteria

- Each transition produces an overlay snapshot with a Blake3 hash
- `cb rollback <run> <transition>` restores VM state and allows re-running subsequent transitions
- `cb rerun <run> --from lint` skips completed transitions and re-runs from the specified point
- Parallel transitions (fan-out) create branched overlays that merge at fan-in points
- Snapshots are content-addressed and deduplicated locally
- `cb inspect` shows the filesystem delta for any transition

---

## Phase 3 — Hybrid Local/Remote Execution

**Goal:** Circuits run locally when resources allow, burst to remote SmolVM instances when they don't. The split is transparent — same circuit, same snapshots, same results regardless of where execution happens. Changes sync via content-addressed deltas.

**Stands on its own as:** A developer tool that runs heavy verification sweeps without crushing a laptop, with results appearing as if everything ran locally.

### 3.1 — Resource Scheduler

- [ ] Implement local resource detection:
  - Available RAM (total - used, accounting for balloon elasticity)
  - Available CPU cores (total - load average)
  - Disk space for snapshots
- [ ] Circuit resource declarations (already in circuit definition from Phase 1):
  - `cpus`, `memory` from `[machine]` section
  - `preference: "local" | "remote" | "any"` — new field
- [ ] Packing algorithm:
  - Collect all circuits in the workflow
  - Sort by preference (local-preferred first)
  - Bin-pack onto local resources
  - Overflow to remote queue
  - If no remote configured: warn and run everything locally (SmolVM elastic memory helps)
- [ ] Decision output: for each circuit, `Local` or `Remote(endpoint)` with reasoning logged

### 3.2 — Remote Fleet Protocol

- [ ] Define fleet endpoint configuration:

```toml
# ~/.cb/config.toml
[fleet]
enabled = true

[[fleet.endpoints]]
name = "aws-us-east"
url = "https://fleet-us-east.example.com"
auth = "api-key"               # or "mtls", "oidc"
api_key_env = "CB_FLEET_KEY"   # read from env var
max_concurrent_vms = 10
region = "us-east-1"

[[fleet.endpoints]]
name = "on-prem"
url = "https://fleet.internal:8443"
auth = "mtls"
cert_path = "~/.cb/certs/fleet.pem"
max_concurrent_vms = 5
```

- [ ] Implement fleet client in `cb-runner`:
  - `POST /v1/circuits/run` — send circuit definition + source delta, get run handle
  - `GET /v1/runs/{id}/status` — poll for transition completions
  - `GET /v1/runs/{id}/snapshots/{transition}` — download snapshot artifact
  - `DELETE /v1/runs/{id}` — clean up remote VM
- [ ] Implement fleet server (`cb-fleet`):
  - Receives circuit run requests
  - Boots SmolVM on local KVM
  - Runs transitions, captures snapshots
  - Serves snapshot downloads
  - Cleans up VMs after completion or timeout

### 3.3 — Source Sync (Content-Addressed)

- [ ] Implement source bundling for remote execution:
  - Hash the workspace directory using Blake3 (file-level hashing, not tar)
  - Compare with remote cache: "do you have these file hashes?"
  - Send only novel/changed files (delta sync)
  - Remote materializes workspace from received files + cache
- [ ] For Phase 6 (Atomic integration), this becomes Atomic's graph sync. For now, use simple content-addressed file sync.
- [ ] Implement snapshot sync (remote → local):
  - Remote sends snapshot manifest (hash, size, metadata)
  - Local checks content-addressed store: skip if hash exists
  - Download novel snapshots
  - Store in local `~/.cb/snapshots/` with same addressing
- [ ] Optimize: for sequential transitions, stream snapshot deltas as they complete (don't wait for entire circuit to finish)

### 3.4 — Transparent Execution

- [ ] From the agent/CLI perspective, local and remote runs look identical:
  - `cb run workflow.ts` — scheduler decides local vs remote per circuit
  - `cb run workflow.ts --local` — force all circuits local
  - `cb run workflow.ts --remote` — force all circuits remote
  - `cb run workflow.ts --remote-only security,coverage` — specific circuits remote
- [ ] Event flow is the same: `TransitionCompleted` events arrive via NATS regardless of where execution happened
- [ ] Provenance metadata records execution location:
  - `execution_host: "local"` or `execution_host: "aws-us-east:i-abc123"`
  - Included in snapshot manifest

### 3.5 — Tunnel / Streaming

- [ ] Implement log streaming from remote VMs:
  - Remote `cb-fleet` streams stdout/stderr over WebSocket or SSE
  - Local CLI displays in real-time (same as local execution)
- [ ] Implement artifact streaming:
  - SARIF results, coverage reports, etc. streamed back as they're produced
  - Breaker can trip remotely based on streamed results (don't wait for full completion)
- [ ] Connection resilience:
  - If tunnel drops, remote execution continues
  - On reconnect, sync missing events and snapshots
  - Idempotent: re-requesting a completed snapshot is a no-op (content-addressed)

### Phase 3 Exit Criteria

- `cb run workflow.ts` transparently splits circuits between local and remote execution
- Heavy circuits (security, coverage) run on a remote fleet while light circuits (quality) run locally
- Snapshots from remote circuits appear in local `~/.cb/snapshots/` with the same hashes they'd have if run locally
- Log streaming works in real-time from remote VMs
- Fleet endpoint is configurable, supports multiple endpoints with failover
- Running `cb run --local` vs `cb run --remote` produces identical results (deterministic circuits)

---

## Phase 4 — Circuit Registry (Marketplace)

**Goal:** A registry where circuit definitions and pre-built machine images are published, versioned, and pulled. Like Docker Hub but for verification circuits.

**Stands on its own as:** A community ecosystem where teams share and consume verification circuits without building their own from scratch.

### 4.1 — Registry Protocol

- [ ] Define the registry API (OCI Distribution Spec compatible where possible):
  - `GET /v2/{namespace}/{name}/manifests/{tag}` — get circuit manifest
  - `GET /v2/{namespace}/{name}/blobs/{digest}` — get content-addressed layer
  - `PUT /v2/{namespace}/{name}/manifests/{tag}` — push circuit manifest
  - `POST /v2/{namespace}/{name}/blobs/uploads/` — initiate blob upload
- [ ] Circuit manifest schema:

```json
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.cb.circuit.v1+json",
  "circuit": {
    "name": "security",
    "version": "1.4",
    "description": "SAST, SCA, secret detection, license audit",
    "author": "Circuit Breaker Team",
    "license": "Apache-2.0"
  },
  "machine": {
    "platforms": ["linux/arm64", "linux/amd64"],
    "layers": [
      { "digest": "blake3:abc...", "size": 52428800, "type": "rootfs" },
      { "digest": "blake3:def...", "size": 10485760, "type": "tools/semgrep:1.60" },
      { "digest": "blake3:ghi...", "size": 8388608, "type": "tools/trivy:0.52" },
      { "digest": "blake3:jkl...", "size": 5242880, "type": "tools/gitleaks:8.18" }
    ]
  },
  "definition": {
    "digest": "blake3:mno...",
    "size": 2048,
    "type": "circuit-definition"
  }
}
```

- [ ] Content-addressed storage: all layers keyed by Blake3 digest, deduplicated across circuits
- [ ] Multi-platform support: same circuit name resolves to arm64 or amd64 layers based on host

### 4.2 — CLI: Pull, Push, Search

- [ ] `cb pull cb/security:1.4` — download circuit manifest + layers to local cache
- [ ] `cb push myorg/custom-quality:1.0` — publish a circuit to the registry
- [ ] `cb search security` — find circuits by keyword
- [ ] `cb inspect cb/security:1.4` — show circuit details (tools, transitions, network policy, size)
- [ ] `cb extend cb/security:1.4 --add cb/ossf-scorecard:1.0 --name myorg/security-plus:1.0` — compose circuits by adding tool overlays
- [ ] Local cache: `~/.cb/registry/` mirrors pulled content, content-addressed, shared across circuits

### 4.3 — Official Circuit Library

- [ ] Build and publish initial set of official circuits:
  - `cb/quality-js:1.0` — eslint, prettier, jest, c8 (JavaScript/TypeScript)
  - `cb/quality-python:1.0` — ruff, black, pytest, coverage (Python)
  - `cb/quality-rust:1.0` — clippy, rustfmt, cargo-test, cargo-tarpaulin (Rust)
  - `cb/quality-go:1.0` — golangci-lint, go test, go vet, govulncheck (Go)
  - `cb/security:1.0` — semgrep, trivy, gitleaks, grype (language-agnostic)
  - `cb/coverage:1.0` — multi-language coverage aggregation
  - `cb/review:1.0` — AI code review agent (OpenCode/Claude)
  - `cb/license:1.0` — license compliance scanning
- [ ] Each circuit includes:
  - Smolfile for building the machine image
  - Circuit definition (TOML)
  - README with usage examples
  - Test suite (circuit run against a sample project with known results)
- [ ] CI for the official library: any change to a circuit definition triggers a rebuild + test + publish

### 4.4 — Registry Hosting

- [ ] Self-hosted option: `cb registry serve --port 8443 --storage ./data`
  - Simple single-binary server
  - Stores blobs on local filesystem or S3-compatible backend
  - Authentication: API key or OIDC
- [ ] Hosted option (future): managed registry at `registry.circuitbreaker.dev`
  - Free tier for public circuits
  - Paid tier for private circuits and organizations
- [ ] Mirror/proxy: `cb registry mirror --upstream registry.circuitbreaker.dev`
  - Local cache for air-gapped environments
  - Pulls from upstream, serves locally

### Phase 4 Exit Criteria

- `cb pull cb/security:1.4` downloads a circuit and its layers to local cache
- `cb push myorg/custom:1.0` publishes to a self-hosted registry
- `cb circuit test cb/quality-js:1.0 --source ./my-node-project` works end-to-end with a pulled circuit
- At least 4 official circuits published and passing tests
- Layer deduplication works: pulling `cb/quality-js:1.0` after `cb/security:1.0` reuses shared rootfs layers
- Self-hosted registry runs as a single binary

---

## Phase 5 — Inner Loop (Agent Tools) + Outer Loop (Traditional CI)

**Goal:** Circuits are invokable as agent tools (inner loop: pre-push verification) and as CI pipeline steps (outer loop: post-push validation). Same circuits, same results, different trigger points.

**Stands on its own as:** A complete verification system that works both as a developer/agent tool and as CI infrastructure.

### 5.1 — Agent Tool Interface

- [ ] Define the tool interface that AI agents can invoke:

```json
{
  "name": "run_circuit",
  "description": "Run a verification circuit against the current workspace. Returns structured results.",
  "parameters": {
    "circuit": { "type": "string", "description": "Circuit reference (e.g., 'cb/security:1.4')" },
    "source": { "type": "string", "description": "Path to source directory", "default": "." },
    "only": { "type": "array", "items": { "type": "string" }, "description": "Run only specific transitions" },
    "from_snapshot": { "type": "string", "description": "Resume from a previous snapshot hash" }
  },
  "returns": {
    "status": "passed | failed | tripped",
    "transitions": [
      {
        "id": "sast",
        "status": "passed",
        "duration_ms": 8200,
        "snapshot_hash": "abc123...",
        "findings": { "critical": 0, "high": 2, "medium": 5 }
      }
    ],
    "breaker": { "tripped": false },
    "snapshot_id": "final-snapshot-hash"
  }
}
```

- [ ] Implement `cb tool serve` — starts a local tool server that agents can call:
  - MCP (Model Context Protocol) endpoint for Claude Code / Claude Desktop
  - HTTP endpoint for generic agent frameworks
  - Stdio mode for tool-use via CLI piping
- [ ] Implement `from_snapshot` — agents resume from a previous snapshot instead of re-running everything:
  - Agent runs `quality` circuit → lint fails
  - Agent fixes lint errors
  - Agent runs `quality` circuit with `from_snapshot: "post-lint-hash"` → skips lint, re-runs test + coverage
  - Saves 60-80% of execution time on iterative fixes

### 5.2 — Inner Loop Integration

- [ ] `cb watch` — file watcher that re-runs circuits on source changes:
  - Watches workspace for file changes
  - Debounces (200ms)
  - Re-runs affected circuits (only circuits whose source outlet overlaps with changed files)
  - Uses `from_snapshot` automatically: re-runs from the first transition whose inputs changed
- [ ] `cb pre-push` — git hook integration:
  - Runs configured circuits before `git push`
  - Blocks push if any circuit fails or breaker trips
  - Configurable via `.cb/pre-push.toml`:

```toml
[[circuit]]
name = "cb/quality-js:1.0"
required = true

[[circuit]]
name = "cb/security:1.0"
required = true
severity_gate = "high"    # block on high+critical, allow medium

[[circuit]]
name = "cb/coverage:1.0"
required = false           # advisory only, don't block push
```

- [ ] Agent-friendly output: structured JSON that agents can parse and act on (not just human-readable text)

### 5.3 — Outer Loop (CI Integration)

- [ ] GitHub Actions action: `circuit-breaker/run-circuits@v1`

```yaml
- uses: circuit-breaker/run-circuits@v1
  with:
    circuits: |
      cb/quality-js:1.0
      cb/security:1.0
      cb/coverage:1.0
    source: .
    fleet: ${{ secrets.CB_FLEET_URL }}
    api_key: ${{ secrets.CB_FLEET_KEY }}
```

- [ ] GitLab CI template: `.circuit-breaker.yml` include
- [ ] Generic CI: `cb run --ci` mode that:
  - Outputs results in JUnit XML, SARIF, and CB-native JSON
  - Sets exit code based on breaker status
  - Uploads snapshot artifacts to CI artifact storage
  - Posts PR comments with findings summary
- [ ] Webhook trigger: `cb-api` accepts webhook events and triggers circuit runs
  - GitHub `push` / `pull_request` events → run configured circuits
  - Results posted back as commit statuses or check runs

### 5.4 — Inner/Outer Loop Parity

- [ ] Same circuit, same machine image, same transitions → same results locally and in CI
- [ ] Determinism testing: run a circuit locally and in CI, compare snapshot hashes
  - If hashes match: fully deterministic (ideal)
  - If hashes differ: log the differences (timestamp-dependent files, etc.), document known sources of non-determinism
- [ ] Circuit authors can mark transitions as `deterministic = true` — hash comparison is enforced
- [ ] Snapshot upload: inner loop snapshots can be uploaded to the registry for CI to reuse
  - If the agent already ran `quality` pre-push and the snapshot hash exists, CI can skip re-running it
  - Trust boundary: configurable — some orgs require CI to re-verify even if pre-push passed

### Phase 5 Exit Criteria

- AI agents can invoke circuits as tools via MCP and get structured results
- `from_snapshot` reduces re-run time by 60%+ on iterative fixes
- `cb pre-push` blocks a git push when security circuit finds critical vulnerabilities
- GitHub Actions integration runs circuits in CI and posts results as PR checks
- Same circuit produces same results (or documented-deterministic results) in inner and outer loop
- `cb watch` re-runs affected circuits on file changes with snapshot reuse

---

## Phase 6 — Atomic Provenance Linkage (SLSA Compliance)

**Goal:** Circuit execution data (runs, snapshots, attestations) is stored in Atomic's content-addressed graph. Provenance is structural — the graph edges connecting code changes to circuit runs to snapshots ARE the provenance, not separate attestation documents. This achieves SLSA Build L3 as an emergent property.

**Stands on its own as:** The first software supply chain system where provenance is mathematically guaranteed by the data structure, not by trust in a platform.

### 6.1 — New Node Types in Atomic's Graph

- [ ] Extend `NODE_TYPES` in Atomic with circuit-related types:
  - `CIRCUIT_RUN = 4` — a circuit execution instance
  - `SNAPSHOT = 5` — a transition overlay delta
  - `ATTESTATION = 6` — a signed verification result
- [ ] Each type gets `EXTERNAL`/`INTERNAL` table entries (hash ↔ NodeId) like changes
- [ ] Snapshot content stored via Atomic's existing `CONTENT_CHUNKS` table (FastCDC, deduplicated)
- [ ] New tables:

| Table | Key | Value | Purpose |
|-------|-----|-------|---------|
| `CIRCUIT_RUNS` | `(view_id, seq)` | `run_node_id` | Which runs belong to which view |
| `RUN_SNAPSHOTS` | `(run_id, transition_seq)` | `snapshot_node_id` | Snapshots within a run |
| `ATTESTATIONS` | `(change_id, circuit_hash)` | `attestation_node_id` | Which circuits attested which changes |
| `SNAPSHOT_PARENTS` | `snapshot_id` | `parent_snapshot_id` | Overlay parent chain |

### 6.2 — Recording Circuit Runs in the Graph

- [ ] When a circuit run completes, the runner records it in Atomic's graph:
  - Create a `CIRCUIT_RUN` node: hash of (circuit definition hash + source state hash + args hash + timestamp)
  - Edge from code change → circuit run (`triggered_by`)
  - For each snapshot: create a `SNAPSHOT` node with Blake3 hash of overlay delta
  - Edge from circuit run → snapshot (`produced_by`)
  - Edge from snapshot → parent snapshot (`parent_of`)
  - Store overlay delta content via `CONTENT_CHUNKS`
- [ ] Sign the circuit run node with the runner's Ed25519 identity (from `atomic-identity`)
- [ ] Update Merkle state: `new_state = Hash(prev_state || run_hash)`
- [ ] Record in `VIEW_CHANGES` so runs are visible in the current view's history

### 6.3 — Attestations

- [ ] When a circuit passes (all transitions complete, breaker doesn't trip):
  - Create an `ATTESTATION` node: hash of (code change hash + circuit hash + run hash + "passed" + timestamp)
  - Edge from attestation → code change (`attests`)
  - Edge from attestation → circuit run (`evidence`)
  - Sign with runner's Ed25519 identity
- [ ] When a circuit fails or breaker trips:
  - Same structure but with `"failed"` status and breaker reason
  - The failure is recorded — absence of a passing attestation is queryable
- [ ] Attestation is immutable once written — it's a graph node with a content hash

### 6.4 — Queryable Build History

- [ ] Extend `atomic log` to show circuit history:
  - `atomic log` — interleaved code changes and circuit runs
  - `atomic log --circuits` — only circuit runs
  - `atomic log --circuit security` — only security circuit runs
  - `atomic log --unattested` — code changes without passing attestations
- [ ] Extend `atomic diff` for circuit results:
  - `atomic diff --circuit security main..feature` — compare security findings between views
- [ ] Extend `atomic blame` for provenance:
  - `atomic blame --circuit security --finding CVE-2024-1234` — which code change introduced this finding
- [ ] New command: `atomic attest`:
  - `atomic attest <change>` — show all attestations for a code change
  - `atomic attest <change> --verify` — cryptographically verify attestation signatures
  - `atomic attest <change> --require security,quality` — check that specific circuits attested

### 6.5 — SLSA Provenance Export

- [ ] Generate SLSA v1.0 provenance documents from graph data:
  - `atomic provenance <change> --format slsa-v1` — export provenance as in-toto statement
  - The provenance document is derived FROM the graph, not the other way around
  - All fields populated from graph nodes: builder identity, source hash, build steps, artifact hashes
- [ ] Provenance includes:
  - **Builder:** Runner identity (Ed25519 public key), SmolVM version, circuit definition hash
  - **Source:** Code change hash, Atomic view state, dependency hashes
  - **Build:** Circuit transitions with snapshot hashes, overlay content hashes
  - **Artifact:** Final snapshot hash, sealed overlay content
  - **Metadata:** Timestamps, execution host (local/remote), breaker results
- [ ] Verification: `atomic provenance <change> --verify`
  - Walks the graph from attestation → run → snapshots → code change
  - Verifies every hash in the chain
  - Verifies every Ed25519 signature
  - Reports: "SLSA Build L3: all checks pass" or specific failures

### 6.6 — Graph Sync for Distributed Provenance

- [ ] Atomic's existing Merkle sync protocol transfers circuit data alongside code:
  - When pushing/pulling between repositories, circuit runs and snapshots sync too
  - Same delta protocol: compare Merkle states, send missing nodes
  - Snapshot content goes through `CONTENT_CHUNKS` (deduplicated, delta-compressed)
- [ ] View filtering applies to circuits: a view's circuit history is the runs triggered by changes in that view
- [ ] Cross-repository verification: pull a change from a remote, verify its attestations locally
  - `atomic pull remote main` — pulls code changes AND their circuit attestations
  - `atomic attest HEAD --verify` — verifies the attestation chain even though the circuit ran on a different machine

### Phase 6 Exit Criteria

- Circuit runs are recorded as nodes in Atomic's graph with Blake3 content-addressing
- Attestations link code changes to circuit results with Ed25519 signatures
- `atomic log --circuits` shows the interleaved code + build history
- `atomic attest <change> --verify` cryptographically verifies the full provenance chain
- `atomic provenance <change> --format slsa-v1` exports a valid SLSA v1.0 provenance document
- Graph sync transfers circuit data between repositories (remote verification works)
- `atomic log --unattested` identifies code changes that haven't been through required circuits

---

## Phase Summary

| Phase | Deliverable | Depends On | Duration Est. |
|-------|------------|------------|---------------|
| **0** | SmolVM validated on Mac + AWS, overlay prototype working | Nothing | 2-3 weeks |
| **1** | Circuit model in CB, SmolVM executor, `cb circuit test` works | Phase 0 | 3-4 weeks |
| **2** | Overlay snapshots, rollback, `cb rerun --from`, content-addressed snapshots | Phase 1 | 3-4 weeks |
| **3** | Hybrid local/remote, fleet server, transparent scheduling | Phase 2 | 4-5 weeks |
| **4** | Circuit registry, `cb pull`/`cb push`, official circuit library | Phase 1 | 3-4 weeks (parallel with 2-3) |
| **5** | Agent tools (MCP), `cb pre-push`, CI integration, inner/outer loop parity | Phase 2 + 4 | 4-5 weeks |
| **6** | Atomic graph integration, attestations, SLSA provenance, queryable build history | Phase 5 + Atomic | 5-6 weeks |

**Critical path:** 0 → 1 → 2 → 5 → 6

**Parallel track:** 4 can start after Phase 1, runs alongside Phases 2-3

```
         Phase 0 (SmolVM validation)
            │
            ▼
         Phase 1 (Circuit model) ──────────────────┐
            │                                       │
            ▼                                       ▼
         Phase 2 (Overlays/snapshots)      Phase 4 (Registry) ──┐
            │                                       │            │
            ▼                                       │            │
         Phase 3 (Hybrid local/remote)              │            │
            │                                       │            │
            └──────────────┬────────────────────────┘            │
                           ▼                                     │
                        Phase 5 (Agent tools + CI) ◄─────────────┘
                           │
                           ▼
                        Phase 6 (Atomic provenance + SLSA)
```

---

## Testing Strategy

### Each Phase Tests Its Own Deliverable

- **Phase 0:** Manual benchmarks + scripted validation (shell scripts)
- **Phase 1:** Integration tests — circuit definition → SmolVM boot → transition execution → structured results
- **Phase 2:** Snapshot tests — overlay creation → snapshot → rollback → verify filesystem state matches
- **Phase 3:** End-to-end — same circuit run locally and remotely, compare snapshot hashes
- **Phase 4:** Registry round-trip — push circuit → pull on clean machine → run → verify results
- **Phase 5:** Agent simulation — programmatic tool invocation → parse results → re-invoke with `from_snapshot`
- **Phase 6:** Provenance verification — record change → run circuit → verify attestation chain → export SLSA document → validate with external SLSA verifier

### Dogfooding: Atomic Development as the Test Bed

Starting in Phase 5, use Circuit Breaker to verify the Atomic codebase itself:

- `cb/quality-rust:1.0` — runs `cargo clippy`, `cargo fmt --check`, `cargo test` on `atomic-core`
- `cb/security:1.0` — runs `cargo audit`, `cargo deny`, Semgrep on the Atomic workspace
- `cb/coverage:1.0` — runs `cargo tarpaulin` on all Atomic crates
- Agents developing Atomic features use `cb pre-push` before every push
- CI runs the same circuits — results should match (inner/outer loop parity test)

This creates the feedback loop: Circuit Breaker verifies Atomic, Atomic stores Circuit Breaker's provenance, Circuit Breaker queries Atomic's graph for build history.

---

## Open Questions

1. **Overlay depth limits:** How many stacked overlays before performance degrades? Need Phase 0 benchmarks.
2. **Fan-out merge strategy:** When parallel transitions modify overlapping files, what's the merge policy? (Last-writer-wins? Conflict detection? Fail?)
3. **SmolVM pack vs. live snapshot:** Is `smolvm pack` the right mechanism for snapshots, or do we need custom overlayfs management in the guest?
4. **Registry hosting model:** Self-hosted first, managed later? Or launch with a hosted free tier for public circuits?
5. **Determinism:** How much non-determinism exists in real circuits? (Timestamps, network responses, tool version drift.) How do we measure and minimize it?
6. **macOS Hypervisor.framework entitlements:** SmolVM requires signing with Hypervisor entitlements on macOS. How does this affect distribution?
7. **Remote fleet economics:** What's the cost model? Per-VM-minute? Per-circuit-run? Flat subscription?
8. **Runner build UX:** Should `cb runner build` be interactive (shell into a VM, install tools, then `cb runner seal`)? Or declarative (a Runnerfile/Dockerfile-like format)? Or both?
9. **`uses:` scanner depth:** How deep does the scanner go? Some actions call other actions (`composite` actions with nested `uses:`). Do we resolve one level or recurse?