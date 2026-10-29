# Circuit Breaker: Inner Loop Architecture

**Date**: May 21, 2026
**Author**: Aaron Ogle
**Status**: Draft
**Branch**: `feature/inner-loop-player-1`

---

## The Two Modes

Circuit Breaker operates in two distinct modes that share the same core primitives but differ in execution venue and infrastructure requirements.

### Single-Player / Inner Loop

One developer or agent, local machine, pre-push. The question being answered: **"Has this change been properly verified to work?"**

```
intent → change → verification → push
```

- Runs entirely on the developer's machine
- No network required (composite actions fetched once at seal time, then sealed)
- State stored locally in `.cb/`
- Results signed by the local CB instance
- No NATS, no Kubernetes, no shared infrastructure

### Multi-Player / Outer Loop

Hosted CB API + runner fleet, shared team infrastructure, post-push CI/CD. The question being answered: **"Has this integrated state been verified against the required evidence?"**

- Triggered by VCS webhooks after changes are integrated
- Runs on shared runner pools
- Results posted as signed evidence to a policy engine
- Requires: multi-tenancy, workflow registry, secrets, result delivery

**This document focuses on the inner loop.** The outer loop builds on the same signing and graph primitives but is not the current implementation target.

---

## Naming: Circuits, Not Workflows

The thing you seal and run via `cb check` is called a **circuit** — not a "workflow."

CB is a workflow engine (Petri nets, transitions, places, scatter/gather). Using "workflow" for the inner-loop verification unit creates an immediate naming collision. The distinction:

- **Circuit**: a sealed verification procedure. Defined in `.cb/circuits/`. Run via `cb check`. Sealed by a human. Produces a signed result.
- **Workflow**: the broader CB Petri net orchestration. Built with the TypeScript DSL, submitted via `cb run`. May invoke multiple circuits and other logic.

A circuit is the inner-loop primitive. A workflow is the outer-loop orchestration that can invoke circuits.

---

## Three Primitives

```
┌────────────────────────────────────────────────────────────────────┐
│  1. Sealed Circuit      Human-signed definition — the trust         │
│                         anchor. Verified before every run.          │
│                                                                     │
│  2. Signed Run Result   CB signs what it witnessed. Proof the       │
│                         agent ran the circuit and what happened.    │
│                                                                     │
│  3. .cb/ Graph          Append-only run history. Merkle-backed.     │
│                         Travels with the code.                      │
└────────────────────────────────────────────────────────────────────┘
```

Two things need signing for different reasons:

**Seal signing** answers: *"Is this the circuit the human approved?"* Locks the circuit definition and execution environment together. If either is tampered with, verification fails before the circuit runs.

**Run signing** answers: *"Did CB actually run this circuit against this code, and what happened?"* Without a signed run result, an agent could skip running checks and claim they passed. The signed result is the proof — cryptographically bound to the seal that ran and the code it ran against.

---

## Primitive 1: Sealed Circuit

A **sealed circuit** is a content-addressed, human-signed pair:

```
circuit_hash = Blake3(circuit definition bytes)
runner_hash  = Blake3(.smolmachine artifact bytes)
seal_hash    = Blake3(circuit_hash || runner_hash)
```

The `seal_hash` is the canonical identifier for this circuit + execution environment. Two runs with the same `seal_hash` ran against identical inputs.

### Two Keys, Two Purposes

| | Seal signing | Run result signing |
|---|---|---|
| **Who** | Human | CB (automated) |
| **When** | `cb seal` — intentional act | `cb check` — every run, no input needed |
| **Key** | Human's key (SSH / VCS identity) | CB machine key |
| **Passphrase** | Yes — this IS the human gate | No — must run silently |
| **Purpose** | "I approve this circuit" | "CB witnessed this run and its outcome" |

### `cb init` — First-time Setup

`cb init` does everything in one command. If the machine has not been configured, it sets up `~/.circuit-breaker/`. If run inside a repo, it also initializes `.cb/`. Idempotent — safe to re-run.

```
$ cb init

Setting up Circuit Breaker...

Detected signing options:
  [1] VCS identity (found ~/.atomic/identity/) ← recommended
  [2] SSH agent (ssh-agent running, 2 keys loaded)
  [3] SSH key file
  [4] Skip — I'll configure this later

Choose seal signer [1]: 2

✓ Seal signer: SSH agent (ed25519:3f2a...)
✓ Machine key generated: ~/.circuit-breaker/identity/cb.key
✓ Config written: ~/.circuit-breaker/config.toml

Initializing .cb/ in /path/to/my-project...

✓ Created .cb/circuits/    (add your circuit definitions here)
✓ Created .cb/seals/       (committed to git — seal manifests live here)
✓ Created .cb/state/       (run graph — commit or gitignore as preferred)

Next: write a circuit in .cb/circuits/, then run `cb seal` to approve it.
```

If the machine is already configured, `cb init` in a new repo skips the identity step and just initializes `.cb/`.

**Auto-init**: if `~/.circuit-breaker/config.toml` doesn't exist when any CB command runs, CB prompts inline rather than failing silently.

### Seal Signer Config

Configured in `~/.circuit-breaker/config.toml` — identity is a machine/user concern, not a project concern, so it lives outside the repo. Same pattern as other VCS tools that use `~/<tool>/config.toml`.

```toml
# ~/.circuit-breaker/config.toml

[identity]
seal_signer = "ssh-agent"     # use SSH agent — passphrase prompt IS the human gate
# seal_signer = "atomic"      # use Atomic VCS identity key
# seal_signer = "ssh-key"     # use a specific SSH key file
# ssh_key     = "~/.ssh/id_ed25519"
```

Auto-detection order if not configured:
1. VCS identity key (`~/.atomic/identity/` if present)
2. SSH agent (`$SSH_AUTH_SOCK` if set) — `ssh-keygen -Y sign -n circuit-breaker`
3. SSH key file (explicit path)
4. CB machine key (last resort — less meaningful as human approval)

The SSH signing namespace is `circuit-breaker`, preventing cross-context key reuse.

### Machine Key (Run Signing)

CB's machine key lives at `~/.circuit-breaker/identity/cb.key`. Auto-generated by `cb init`. No passphrase — must run silently during `cb check`. This is not the human's identity; it's the machine's. It identifies "this CB installation witnessed this run."

```
~/.circuit-breaker/identity/
├── cb.key   # Ed25519 private key, no passphrase
└── cb.pub   # public key — embedded in every signed run result
```

### Human Gate on Re-sealing

Re-sealing is intentionally not silent. Two gates:

1. **Seal signer requires human input** — `cb seal` uses the configured `seal_signer`. If the key is passphrase-protected or held by a locked SSH agent, an agent cannot re-seal without human interaction. This is enforced by the developer's existing key management (Keychain, 1Password SSH agent, etc.), not by CB.

2. **Commit required** — a seal in `.cb/seals/` that is not committed to version control is treated as unverified. `cb check` warns and blocks:
   ```
   ⚠  Seal cb/ci:d4e5f6 has uncommitted changes — commit .cb/seals/ to activate.
   ```

An agent *can* invoke `cb seal`, but the result is inert until a human commits it.

### `cb seal` Command

```bash
cb seal .cb/circuits/ci.wf.ts
# → reads circuit, builds/reuses sealed SmolVM runner
# → signs (circuit_hash || runner_hash || cb_version || sealed_at) with seal_signer
# → writes .cb/seals/<seal_hash[0:12]>/
#     manifest.json  { circuit_hash, runner_hash, seal_hash,
#                      cb_version, sealed_at, seal_pubkey, signature }
#     circuit.wf.ts  (locked copy of the circuit definition)
#     runner.ref     (path to .smolmachine in ~/.circuit-breaker/runners/)
# → prints: sealed cb/ci:d4e5f6 — commit .cb/seals/ to activate
```

Before every `cb check` run, CB verifies the seal signature. Mismatch → blocked:

```
⚠  Circuit seal invalid: cb/ci:d4e5f6
   circuit.wf.ts has been modified since sealing.
   Run `cb seal` to create a new seal, then commit .cb/seals/.
```

### `cb check` Entry Points

**Primary — CB native circuits:**
```bash
cb check                           # run all circuits in .cb/circuits/
cb check -c .cb/circuits/ci.wf.ts  # specific circuit
cb check --from <step>             # resume from a failed step (reuses sealed runner)
cb check --rebuild                 # force reseal + rebuild runner
```

**Bridge — GitHub Actions (existing behavior from `feat/inner-loop`):**
```bash
cb check --github-actions          # run .github/workflows/*.yml via CB
cb import github-actions           # one-time convert to CB native circuits
```

The GitHub Actions bridge is an explicit migration path. CB native circuits are the primary path.

---

## Primitive 2: Signed Run Result

After every `cb check` run, CB produces a **signed run result** and writes it as a node in the graph. This is the proof that the agent ran the circuit and what happened.

The seal signature proves the circuit was legitimate. The run signature proves CB witnessed this specific execution. Both are required: a trusted circuit with no proof it ran is not evidence.

### Run Node

```rust
pub struct RunNode {
    pub id:               NodeId,
    pub seal_id:          NodeId,             // which Seal node
    pub input_hash:       Blake3Hash,         // content hash of source snapshot
    pub change_hashes:    Vec<Blake3Hash>,    // VCS change hashes (if known)
    pub started_at:       DateTime<Utc>,
    pub finished_at:      DateTime<Utc>,
    pub status:           RunStatus,          // Passed | Failed | Tripped | Partial
    pub log_hash:         Blake3Hash,         // root hash of full output log chunks
    pub merkle_at_record: Blake3Hash,         // CB graph Merkle root when appended
    pub cb_version:       String,
    pub cb_pubkey:        Ed25519PublicKey,   // machine key — which CB instance ran this
    pub signature:        Ed25519Signature,   // signs all fields above
}
```

Signed with the CB machine key (no passphrase, runs silently):
```
sign(seal_id || input_hash || change_hashes || started_at || finished_at
     || status || log_hash || merkle_at_record || cb_version || cb_pubkey)
```

The `input_hash` is Blake3 over the source directory snapshot using content-defined chunking. It anchors the run to a specific workspace state without storing the source. If a VCS is present, `change_hashes` gives the stronger, VCS-native link.

### `cb attest`

Prints or exports the signed run result. The `--json` form is what agents pipe to VCS tooling as inner-loop evidence.

```bash
cb attest            # last run
cb attest <run_id>   # specific run
cb attest --json     # machine-readable JSON
```

```
Circuit:   cb/ci:d4e5f6
Input:     blake3:7a8b9c...
Changes:   [c1hash, c2hash]
Status:    PASSED (3/3 steps)
  ✓ build   14.2s
  ✓ test    30.1s
  ✓ lint     8.4s
Machine:   ed25519:3f2a... (this machine's CB identity)
Signature: ed25519:9d1c...
```

### `cb verify`

```bash
cb verify <run_id>
```

Checks: run signature valid for `cb_pubkey`, `log_hash` matches chunk content, seal was committed at run time.

---

## Primitive 3: The `.cb/` Graph

### Why a Graph from the Start

A graph with a Merkle root gives you content-addressing, tamper-evident history, and queryable run records in a single structure. Starting with flat files and migrating later creates two sources of truth and a migration problem.

Every `cb check` writes **directly into the graph**. Logs (large output blobs) are stored as content-addressed chunks referenced by hash — the same chunking approach used for binary content in modern VCS tools.

### Graph Model

- **[redb](https://github.com/cberner/redb)** — embedded, ACID, Rust-native key-value store
- **Blake3** — content addressing for all nodes and log chunks
- **Append-only btree → merkle** — each run advances the Merkle root; records are never modified
- **Content-defined chunking (FastCDC)** — log output stored as variable-size chunks, deduplicated by hash

### Node Types

```
Seal        sealed circuit definition + runner reference
Run         a single execution instance (signed by CB machine key)
Transition  a single step within a run
LogChunk    content-addressed blob of output bytes
```

### Edges

```
Seal       ──produces──► Run
Run        ──follows───► Run           (chain for Merkle)
Run        ──has────────► Transition
Run        ──log────────► LogChunk     (full output)
Transition ──log────────► LogChunk     (per-step output)
```

### Tables

```
CB_NODES        (node_id → NodeKind + serialized payload)
CB_EDGES        (edge_id → EdgeKind + from_node + to_node)
CB_SEAL_INDEX   (seal_hash → node_id)
CB_RUN_CHAIN    (seq → (run_node_id, merkle_root))    # append-only Merkle log
CB_INPUT_INDEX  (input_hash → [run_node_id])
CB_LOG_CHUNKS   (chunk_hash → bytes)
```

Merkle update on each append: `new_root = Blake3(prev_root || run_node_id || run_node_hash)`

### Transition Node

```rust
pub struct TransitionNode {
    pub run_id:      NodeId,
    pub name:        String,
    pub status:      TransitionStatus,
    pub started_at:  DateTime<Utc>,
    pub duration_ms: u64,
    pub exit_code:   Option<i32>,
    pub log_hash:    Blake3Hash,
    pub findings:    Option<Findings>,  // SARIF, coverage, etc.
}
```

### Directory Layout

```
.cb/
├── circuits/        # circuit definitions (.wf.ts) — committed to git
├── seals/           # sealed manifests + runner refs — committed to git
└── state/
    └── cb.db        # redb graph — commit or gitignore as preferred

~/.circuit-breaker/
├── config.toml      # seal_signer and other user config
├── identity/
│   ├── cb.key       # machine key for run signing (not committed)
│   └── cb.pub
└── runners/         # cached .smolmachine sealed runners
```

The `.cb/` directory (minus nothing sensitive — machine keys are in `~/.circuit-breaker/`) can be committed to version control. Run history then travels with the code.

### CLI

```bash
cb log                         # run history for this repo
cb log --seal cb/ci:d4e5f6     # runs for a specific seal
cb log --input <hash>          # runs for a specific input state
cb status                      # last run result + active seal
cb verify <run_id>             # verify signature + log chunk integrity
```

---

## VCS Integration: Soft Coupling

CB works without any specific VCS. The `.cb/` graph is self-contained. VCS integration is additive — it allows CB results to participate in policy-gated promotion flows and be stored alongside change provenance.

### The Hook Model

When a VCS with hook support is present, CB results can be exported automatically at the end of an agent turn:

```toml
# .atomic/hooks.toml (example — Atomic VCS)
[hooks.turn_end]
command = "cb attest --json --changes $ATOMIC_CHANGE_HASHES"
```

CB outputs structured JSON. The VCS hook runner embeds it as a `Verification` node in the provenance graph. Neither tool needs to know about the other at the library level — the hook is the glue.

### For Policy-Gated Promotion

When a developer or agent runs `atomic insert --to dev` (or equivalent in any policy-aware VCS), the tool can query `.cb/state/cb.db` for a passing run result against the current change hashes and attach it as inner-loop evidence:

```
atomic insert --to dev
→ queries .cb/state/cb.db for latest passing run covering current change_hashes
→ attaches: { kind: "inner-loop", runner: "circuit-breaker",
              seal_hash, status, signature, cb_pubkey, merkle_at_record }
→ policy engine verifies the change_hashes are covered by signed CB evidence
```

The signed run result is exactly what a policy engine needs: cryptographic proof that a specific trusted circuit ran against specific code and passed.

---

## Implementation Phases

### Phase 1 — Graph + Seal + Sign

**Goal**: `cb check` writes a signed run node into the local graph. `cb attest --json` produces machine-readable evidence. Immediately useful.

**Work:**
1. `cb init`: detect available signers, prompt user to configure `seal_signer`, generate machine key at `~/.circuit-breaker/identity/`, write `~/.circuit-breaker/config.toml`; if run inside a repo, initialize `.cb/`; idempotent
2. Initialize `.cb/state/cb.db` with all graph tables
3. `cb seal`: sign circuit + runner using `seal_signer` → `Seal` node + locked copy in `.cb/seals/`; warn if not committed
4. `cb check`: verify seal signature before executing; write `Run` node (signed with machine key), `Transition` nodes, log chunks; advance Merkle
5. `cb attest`: print / export signed run result
6. `cb verify <run_id>`: verify run signature + seal committed status + log integrity
7. `cb log` / `cb status`: query graph

**Definition of done**: after `cb check`, `cb attest --json` produces a signed result (`seal_hash`, `status`, `change_hashes`, `signature`, `cb_pubkey`) that a VCS tool can attach as inner-loop evidence. `cb log` shows full history. `.cb/` checked into version control carries the audit trail.

### Phase 2 — VCS Hook Integration

**Goal**: CB results flow into VCS provenance automatically. Policy-gated promotion uses CB attestation as inner-loop evidence.

**Work:**
1. `cb attest --json --changes <hash,...>` — structured output for VCS hook consumption
2. VCS `TurnEnd` hook template that calls CB and embeds a `Verification` node
3. VCS insert command reads `.cb/state/cb.db` for current-changes evidence and attaches it to the insert request
4. VCS server accepts signed CB results as `inner-loop` evidence

**Definition of done**: agent turn ends → CB runs automatically → VCS insert passes policy gate because CB evidence is attached.

### Phase 3 — Agent-Interactive Circuits

**Goal**: circuits can pause and return structured data to the agent. Agent injects a token to resume.

**Work:**
1. `WaitForAgent` transition type: parks at a named place, emits a structured notification
2. `cb watch <run_id>` — watches for state transitions, prints when parked
3. `cb inject <run_id> <place> --data <json>` — inject token with data to resume
4. Parked state format: `{ run_id, parked_at, available_data: { ... } }`

**Definition of done**: agent launches a CB circuit, receives intermediate state when parked, processes it (LLM decides next step), injects a token to resume. Pattern works as an MCP tool.

---

## Outer Loop: Shape

The outer loop runs on shared infrastructure and delivers signed attestations to a central policy engine rather than writing to a local graph. It builds on exactly the same signing model as the inner loop.

Additional requirements (not current implementation target):

- **Hosted CB API + runners** — multi-tenant, runner pools, WebSocket-connected runners
- **Workflow registry** — submit once, lock by `name@version`; prevents agent workflow modification; required before outer loop is security-relevant
- **Secrets primitive** — pluggable provider model (1Password, HashiCorp Vault, AWS Secrets Manager, env)
- **Result delivery** — runner posts signed attestation to VCS policy engine; `change_hashes` or Merkle hash determines inner vs outer loop evidence
- **Runner identity** — machine keys provisioned at runner creation, registered with CB API so the server knows which runners are trusted

---

## What This Is Not

- **Not a replacement for a VCS** — CB stores run evidence, not code changes. The two are complementary.
- **Not requiring NATS for inner loop** — NATS is an outer loop concern for multi-runner coordination. Single-player uses the local graph.
- **Not requiring Docker** — SmolVM is the execution substrate. No Docker daemon needed for inner loop.
- **Not an all-or-nothing integration** — VCS integration is additive via hooks. CB works standalone.

---

## Open Questions

1. **`.cb/state/cb.db` in version control**: should the run graph be committed by default or opt-in? Committing it gives full audit history alongside the code; leaving it out keeps the repo lighter. The seals (`.cb/seals/`) should always be committed — that's the security boundary.

2. **Input hash for in-progress changes**: when an agent runs `cb check` before recording changes with the VCS, the change hashes aren't yet known. The `input_hash` (content hash of the working directory) is used instead. The VCS hook model closes this gap: hooks fire after the VCS records the change, so both the VCS change hashes and the CB run result are available at the same moment.

3. **Machine key trust in multi-player**: for the outer loop, atomic-storage needs to know which CB machine public keys to trust as valid evidence submitters. Options: (a) any key accepted; (b) keys pre-registered per project; (c) keys signed by a CB root CA. Inner loop is self-trusting — the developer controls their own machine.

4. **`.cb/` vs VCS-native storage**: if the VCS already has a content-addressed graph (e.g., Atomic VCS), should CB store run nodes there rather than in a separate `.cb/` graph? Arguments for: single storage, single Merkle, deeper provenance linkage. Arguments against: CB must work without any specific VCS. Current decision: separate `.cb/` graph; the VCS integration is additive via hooks and a `Verification` node reference.
