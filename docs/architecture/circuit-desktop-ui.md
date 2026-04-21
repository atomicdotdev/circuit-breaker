# Circuit Breaker Desktop — Tauri UI Specification

## Overview

Circuit Breaker Desktop is a native desktop application for managing SmolVM circuits, machines, snapshots, and the circuit registry. It replaces Docker Desktop as the local development companion — providing a visual interface for everything `cb` does on the command line, plus real-time observability into running circuits.

Built with [Tauri v2](https://v2.tauri.app/) (Rust backend + web frontend), it shares the same Rust crates as the CLI (`cb-core`, `cb-runner`) and talks directly to SmolVM — no Docker daemon, no Electron, no heavyweight runtime.

## Design Principles

1. **Native, not wrapped.** Tauri gives us a real macOS/Linux app with system tray, notifications, and Hypervisor.framework entitlements — all in a ~10MB binary.
2. **Same backend, different frontend.** The Tauri Rust backend uses the same `cb-core` and `cb-runner` crates as the CLI. No logic duplication.
3. **Real-time by default.** Log streaming, resource monitoring, transition progress — all live via Tauri events, not polling.
4. **Circuit-first, not VM-first.** Docker Desktop centers on containers. We center on circuits (the verification workflow), with machines as an implementation detail.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Circuit Breaker Desktop (Tauri v2)                                 │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Frontend (WebView)                                           │  │
│  │  React + TypeScript + Tailwind CSS                            │  │
│  │                                                               │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │  │
│  │  │ Circuits │ │ Machines │ │ Registry │ │ Fleet / Remote │  │  │
│  │  │  Panel   │ │  Panel   │ │  Panel   │ │    Panel       │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────────────┘  │  │
│  │                                                               │  │
│  │  Tauri invoke() / event listeners                             │  │
│  └───────────────────┬───────────────────────────────────────────┘  │
│                      │ IPC (JSON commands + event streams)          │
│  ┌───────────────────▼───────────────────────────────────────────┐  │
│  │  Backend (Rust)                                               │  │
│  │                                                               │  │
│  │  ┌──────────┐ ┌──────────────┐ ┌────────────┐ ┌───────────┐ │  │
│  │  │ cb-core  │ │ cb-runner    │ │ smolvm     │ │ cb-fleet  │ │  │
│  │  │ (circuit │ │ (executor,   │ │ (CLI/lib   │ │ (remote   │ │  │
│  │  │  parse,  │ │  overlay     │ │  wrapper)  │ │  client)  │ │  │
│  │  │  petri)  │ │  manager)    │ │            │ │           │ │  │
│  │  └──────────┘ └──────────────┘ └────────────┘ └───────────┘ │  │
│  │                                                               │  │
│  │  NATS client (optional, for event bus)                        │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  System tray icon + menu                                            │
│  macOS: Hypervisor.framework entitlements                           │
│  Linux: KVM /dev/kvm access                                        │
└─────────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
    SmolVM VMs          ~/.cb/snapshots      Circuit Registry
    (local hypervisor)  (content-addressed)  (remote or self-hosted)
```

### Technology Choices

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Shell | Tauri v2 | Native binary, ~10MB, Rust backend, system tray, auto-update, entitlements signing |
| Frontend | React 19 + TypeScript | Component model, ecosystem, developer familiarity |
| Styling | Tailwind CSS + shadcn/ui | Dark theme by default (matching Docker Desktop), consistent components |
| State | Zustand | Lightweight, works well with Tauri event streams |
| Terminal | xterm.js | Embedded terminal for VM exec, log streaming |
| Charts | Recharts or lightweight custom SVGs | Resource monitoring (CPU, RAM, disk) |
| Backend | Rust (shared crates) | `cb-core`, `cb-runner`, direct SmolVM integration |
| IPC | Tauri commands + events | Type-safe invoke from frontend, streaming events from backend |

---

## Navigation Structure

The left sidebar mirrors Docker Desktop's pattern but reframes everything around circuits:

```
┌─────────────────────┐
│  ⚡ Circuit Breaker  │
│                     │
│  ◉ Circuits         │  ← Active/recent circuit runs (primary view)
│  ◻ Machines         │  ← Running/stopped SmolVMs
│  ▦ Snapshots        │  ← Content-addressed snapshot browser
│  ☁ Registry         │  ← Pull/push/search circuits (marketplace)
│  ⚙ Fleet            │  ← Remote fleet endpoints + status
│  📊 Builds          │  ← Build history (Petri net + results timeline)
│  🔑 Identity        │  ← Ed25519 keys (from atomic-identity)
│                     │
│  ─────────────────  │
│  ⚙ Settings         │
│  📖 Docs            │
└─────────────────────┘

Status bar (bottom):
  SmolVM: running │ VMs: 3 │ RAM: 4.2 GB used │ CPU: 12% │ Disk: 1.8 GB snapshots
```

---

## Screen Specifications

### 1. Circuits Panel (Primary View)

The main screen. Shows all circuit runs — active, completed, failed.

#### 1.1 Circuit List View

```
┌─────────────────────────────────────────────────────────────────────┐
│  Circuits                                          [+ Run Circuit] │
│                                                                     │
│  Filter: [All ▼]  [Running ○]  [Passed ○]  [Failed ○]  [🔍 Search]│
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ ⚡ cb/quality-rust:1.0        RUNNING        2m 14s             ││
│  │   run-a1b2c3  │  source: ~/Projects/atomic  │  3/5 transitions ││
│  │   ████████████████░░░░░░░░  lint ✓  test ⏳  coverage ·  ...  ││
│  ├─────────────────────────────────────────────────────────────────┤│
│  │ 🔒 cb/security:1.4           PASSED         1m 48s             ││
│  │   run-d4e5f6  │  source: ~/Projects/atomic  │  4/4 transitions ││
│  │   ████████████████████████  sast ✓  sca ✓  secrets ✓  report ✓││
│  ├─────────────────────────────────────────────────────────────────┤│
│  │ 📊 cb/coverage:2.0           FAILED         3m 02s             ││
│  │   run-g7h8i9  │  source: ~/Projects/atomic  │  2/3 transitions ││
│  │   ████████████████░░░░░░░░  unit ✓  integ ✗  coverage ·       ││
│  │   ⚠ Breaker tripped: integration tests failed (12 failures)   ││
│  ├─────────────────────────────────────────────────────────────────┤│
│  │ ⚡ cb/quality-js:1.0          PASSED         45s                ││
│  │   run-j0k1l2  │  source: ~/Projects/webapp  │  3/3 transitions ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

- Each row shows: circuit name/version, status badge, duration, source path, transition progress bar
- Progress bar is segmented by transition with live status (✓ passed, ⏳ running, · pending, ✗ failed)
- Breaker trip reason shown inline on failed circuits
- Click a row to open the circuit detail view

#### 1.2 Circuit Detail View

Clicking a circuit run opens a detail view with tabs, modeled after Docker Desktop's container detail:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← Circuits / cb/quality-rust:1.0                                   │
│                                                                     │
│  ⚡ cb/quality-rust:1.0                    STATUS                   │
│  🔑 run-a1b2c3                             Running (2m 14s)         │
│  📁 ~/Projects/atomic                      [⏸ Pause] [⏹ Stop] [🗑]│
│  🖥 local (macOS arm64)                                             │
│                                                                     │
│  ┌─────┬───────┬───────────┬──────┬───────┬───────┬────────┐       │
│  │ Logs│ Graph │ Snapshots │ Exec │ Files │ Stats │ Config │       │
│  └─────┴───────┴───────────┴──────┴───────┴───────┴────────┘       │
│                                                                     │
│  (tab content area — see below)                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

##### Tab: Logs

Real-time log streaming from the running VM via xterm.js. Shows stdout/stderr from each transition, color-coded by transition ID.

```
┌─────────────────────────────────────────────────────────────────────┐
│  [All transitions ▼]  [Auto-scroll ✓]  [Wrap lines ✓]  [🔍 Filter]│
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ [lint]     Running eslint on 142 files...                       ││
│  │ [lint]     /src/pristine/txn/write.rs: 3 warnings               ││
│  │ [lint]       L42: unused variable `prev_state`                  ││
│  │ [lint]       L89: unnecessary clone                             ││
│  │ [lint]       L156: consider using `if let`                      ││
│  │ [lint]     ✓ Completed in 4.2s (3 warnings, 0 errors)          ││
│  │ [test]     Running cargo test...                                ││
│  │ [test]     running 847 tests                                    ││
│  │ [test]     test pristine::test_view_operations ... ok           ││
│  │ [test]     test pristine::test_merkle_state ... ok              ││
│  │ [test]     test types::test_hash_roundtrip ... ok               ││
│  │ [test]     ⏳ 312/847 tests complete...                        ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

- Transition filter dropdown: show logs from all transitions or a specific one
- Log lines prefixed with `[transition-id]` in distinct colors
- Clickable links for file paths (opens in system editor)
- Search/filter within logs
- Auto-scroll follows latest output, pause on manual scroll-up

##### Tab: Graph (Petri Net Visualization)

Interactive Petri net diagram showing places, transitions, and token flow in real time.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│    ● start                                                          │
│    │                                                                │
│    ▼                                                                │
│  ┌──────┐                                                          │
│  │ lint │  ✓ 4.2s                                                  │
│  └──┬───┘                                                          │
│     │                                                               │
│     ● linted                                                        │
│     │                                                               │
│     ▼                                                               │
│  ┌──────┐                                                          │
│  │ test │  ⏳ 1m 02s (312/847)                                     │
│  └──┬───┘                                                          │
│     │                                                               │
│     ○ tested                                                        │
│     │                                                               │
│     ▼                                                               │
│  ┌──────────┐                                                      │
│  │ coverage │  · pending                                            │
│  └──────────┘                                                      │
│     │                                                               │
│     ○ done                                                          │
│                                                                     │
│  Legend: ● has token  ○ empty  ✓ passed  ⏳ running  · pending     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

- Places shown as circles (filled when they hold a token)
- Transitions shown as rectangles with status + duration
- Fan-out/fan-in rendered as parallel paths
- Clicking a transition opens its log output + snapshot details
- Animated token flow when transitions fire
- For complex circuits: zoom/pan, auto-layout via dagre or elk.js

##### Tab: Snapshots

Browse the overlay snapshots captured at each transition.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Snapshots for run-a1b2c3                                           │
│                                                                     │
│  ┌──────────┬──────────┬──────────┬──────────┬─────────┬──────────┐│
│  │ Transition│ Status  │ Hash     │ Size     │ Time    │ Actions  ││
│  ├──────────┼──────────┼──────────┼──────────┼─────────┼──────────┤│
│  │ lint      │ ✓ passed│ a1f3c8...│ 124 KB   │ 4.2s    │ 🔍 📦 ↩ ││
│  │ test      │ ⏳ run  │ —        │ —        │ 1m 02s  │          ││
│  │ coverage  │ · pend  │ —        │ —        │ —       │          ││
│  └──────────┴──────────┴──────────┴──────────┴─────────┴──────────┘│
│                                                                     │
│  Actions: 🔍 Inspect (view delta)  📦 Seal (export)  ↩ Rollback   │
│                                                                     │
│  ┌─ Inspect: lint (a1f3c8...) ─────────────────────────────────────┐│
│  │                                                                  ││
│  │  Modified files (3):                                             ││
│  │    M src/pristine/txn/write.rs    (+2, -2)                      ││
│  │    A /output/lint-results.sarif   (new, 48 KB)                  ││
│  │    M /circuit/state.json          (+1, -1)                      ││
│  │                                                                  ││
│  │  [View full diff]  [Open in editor]                              ││
│  └──────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

- Table of all snapshots with hash, size, duration
- Inspect shows the overlay delta: new/modified/deleted files with diff preview
- Seal exports the snapshot as a `.tar.zst` artifact
- Rollback restores to that snapshot and enables re-running subsequent transitions
- Parent chain visualization: which snapshot derived from which

##### Tab: Exec

Interactive terminal session inside the running VM (like Docker Desktop's Exec tab).

```
┌─────────────────────────────────────────────────────────────────────┐
│  Shell: /bin/sh                                     [New session +] │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ /workspace $ ls                                                 ││
│  │ Cargo.toml  atomic-cli  atomic-core  atomic-identity            ││
│  │ atomic-config  atomic-repository  target                        ││
│  │ /workspace $ cargo clippy --version                             ││
│  │ clippy 0.1.84 (2024-12-20)                                     ││
│  │ /workspace $ cat /output/lint-results.sarif | jq '.runs[0].    ││
│  │ results | length'                                               ││
│  │ 3                                                               ││
│  │ /workspace $ █                                                  ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

- Full PTY via xterm.js, connected to the VM via `smolvm machine exec`
- Multiple sessions (tabs within the tab)
- Works only when VM is running
- Useful for debugging failed transitions: exec into the VM, inspect state manually

##### Tab: Files

Browse the VM's filesystem at the current overlay state.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Path: /workspace/                                  [Overlay: t1]  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ 📁 ..                                                           ││
│  │ 📁 atomic-cli/                                                  ││
│  │ 📁 atomic-core/                                                 ││
│  │ 📁 atomic-identity/                                             ││
│  │ 📁 atomic-repository/                                           ││
│  │ 📁 target/                                                      ││
│  │ 📄 Cargo.toml                    2.1 KB    2026-07-15 10:30     ││
│  │ 📄 Cargo.lock                    48 KB     2026-07-15 10:30     ││
│  │ 📄 README.md                 Δ   4.2 KB    2026-07-15 10:32     ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  Preview: README.md                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ # Atomic                                                        ││
│  │ A mathematically sound distributed version control system...    ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

- File browser navigates the VM filesystem via `smolvm machine exec -- ls`
- Overlay selector: switch between viewing base, t1, t2, etc.
- Files modified in the current overlay marked with `Δ`
- Click to preview (text files rendered, images displayed, binaries show hex)
- Download files from the VM

##### Tab: Stats

Real-time resource monitoring for the VM.

```
┌─────────────────────────────────────────────────────────────────────┐
│  CPU                                            Memory              │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐  │
│  │     ╱╲    ╱╲               │  │              ___────────    │  │
│  │    ╱  ╲╱╱  ╲              │  │         ___╱            │  │
│  │ ──╱        ╲──────        │  │     ___╱                │  │
│  │                            │  │ ___╱                    │  │
│  │ 12%              4 vCPUs  │  │ 1.8 GB / 4.0 GB (45%)  │  │
│  └─────────────────────────────┘  └─────────────────────────────┘  │
│                                                                     │
│  Disk I/O                                       Network             │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐  │
│  │ Read:  2.4 MB/s             │  │ In:  0 B/s  (net disabled) │  │
│  │ Write: 840 KB/s             │  │ Out: 0 B/s                 │  │
│  └─────────────────────────────┘  └─────────────────────────────┘  │
│                                                                     │
│  Overlay Snapshots: 3  │  Total snapshot size: 1.2 MB               │
│  VM uptime: 2m 14s     │  Boot time: 187ms                         │
└─────────────────────────────────────────────────────────────────────┘
```

- Live CPU/memory/disk/network charts (1s update interval)
- Memory shows balloon-adjusted actual usage, not requested
- Network shows allowed hosts when networking is enabled
- Overlay stats: count, total size, individual sizes
- VM metadata: boot time, uptime, vCPU count, architecture

##### Tab: Config

Read-only view of the circuit definition that produced this run.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Circuit: cb/quality-rust:1.0                                       │
│  Hash: blake3:f8a2c1...                                             │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ [circuit]                                                       ││
│  │ name = "quality-rust"                                           ││
│  │ version = "1.0"                                                 ││
│  │                                                                 ││
│  │ [machine]                                                       ││
│  │ image = "cb/quality-rust:1.0"                                   ││
│  │ cpus = 4                                                        ││
│  │ memory = "4Gi"                                                  ││
│  │                                                                 ││
│  │ [network]                                                       ││
│  │ enabled = false                                                 ││
│  │ ...                                                             ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  Machine Image Layers:                                              │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  rootfs/alpine:3.20            52 MB     blake3:a1b2c3...   │  │
│  │  tools/rust:1.80               180 MB    blake3:d4e5f6...   │  │
│  │  tools/clippy:0.1.84           12 MB     blake3:g7h8i9...   │  │
│  │  tools/cargo-tarpaulin:0.31    8 MB      blake3:j0k1l2...   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

- TOML syntax-highlighted circuit definition
- Content hash of the circuit definition
- Machine image layer breakdown with sizes and hashes
- Breaker configuration highlighted
- Link to registry page for this circuit

---

### 2. Machines Panel

Lower-level view of the SmolVM instances. Similar to Docker Desktop's "Containers" view.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Machines                                         [+ Create Machine]│
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ Name              Image              Status    CPU   RAM   Age  ││
│  ├─────────────────────────────────────────────────────────────────┤│
│  │ run-a1b2c3        cb/quality-rust    Running   12%  1.8G  2m   ││
│  │ run-d4e5f6        cb/security:1.4    Stopped   —    —     5m   ││
│  │ dev-sandbox       alpine:3.20        Running   1%   256M  1h   ││
│  │ run-g7h8i9        cb/coverage:2.0    Failed    —    —     8m   ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  Bulk actions: [▶ Start selected] [⏹ Stop selected] [🗑 Remove]    │
└─────────────────────────────────────────────────────────────────────┘
```

- List all SmolVM machines (circuit-managed and standalone)
- Status: Running, Stopped, Failed, Creating
- Quick actions: start, stop, restart, delete
- Click to open detail view (same tabs: Logs, Exec, Files, Stats)
- Machines created by circuit runs are labeled with their run ID

---

### 3. Snapshots Panel

Content-addressed snapshot browser across all runs.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Snapshots                                    Total: 1.8 GB on disk │
│                                                                     │
│  Group by: [Run ▼]  Sort: [Newest first ▼]  [🔍 Search by hash]    │
│                                                                     │
│  ┌─ run-a1b2c3 (cb/quality-rust:1.0) ──────────────────────────────┐│
│  │  t1:lint       a1f3c8...  124 KB   10:30:04   ✓                 ││
│  │  t2:test       b2g4d9...  2.1 MB   10:31:06   ✓                 ││
│  │  t3:coverage   c3h5e0...  840 KB   10:32:14   ✓                 ││
│  ├─ run-d4e5f6 (cb/security:1.4) ──────────────────────────────────┤│
│  │  t1:sast       d4i6f1...  3.2 MB   10:28:00   ✓                 ││
│  │  t2:sca        e5j7g2...  1.8 MB   10:29:12   ✓                 ││
│  │  t3:secrets    f6k8h3...  48 KB    10:29:08   ✓                 ││
│  │  t4:report     g7l9i4...  96 KB    10:30:02   ✓                 ││
│  └──────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  Actions: [🔍 Inspect] [📦 Export] [🗑 Delete] [♻ Garbage collect] │
└─────────────────────────────────────────────────────────────────────┘
```

- Browse all snapshots grouped by run or by circuit
- Deduplicated: if two runs produced identical snapshots, shown once with multiple references
- Storage stats: total disk usage, largest snapshots
- Garbage collection: remove orphaned snapshots not referenced by any run
- Export: download snapshot as `.tar.zst`
- Inspect: view filesystem delta (same as the Snapshots tab in circuit detail)

---

### 4. Registry Panel

Browse, pull, and manage circuits from the marketplace.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Registry                                 [registry.circuitbreaker.dev]│
│                                                                     │
│  ┌─ Installed ──────────────────────────────────────────────────────┐│
│  │ cb/quality-rust:1.0    252 MB    pulled 2d ago    [Update avail]││
│  │ cb/security:1.4        180 MB    pulled 5d ago    [Up to date]  ││
│  │ cb/coverage:2.0        210 MB    pulled 1d ago    [Up to date]  ││
│  └──────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  ┌─ Browse ─────────────────────────────────────────────────────────┐│
│  │ [🔍 Search circuits...]                                         ││
│  │                                                                  ││
│  │ Featured:                                                        ││
│  │ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐  ││
│  │ │ cb/quality-js    │ │ cb/quality-go    │ │ cb/license       │  ││
│  │ │ ★ 4.8 (120 pulls)│ │ ★ 4.6 (85 pulls)│ │ ★ 4.5 (62 pulls)│  ││
│  │ │ eslint, prettier │ │ golangci-lint    │ │ license scan     │  ││
│  │ │ jest, c8         │ │ go vet, govuln   │ │ compliance       │  ││
│  │ │     [Pull]       │ │     [Pull]       │ │     [Pull]       │  ││
│  │ └──────────────────┘ └──────────────────┘ └──────────────────┘  ││
│  │                                                                  ││
│  │ Categories:                                                      ││
│  │  [Quality]  [Security]  [Coverage]  [Review]  [License]  [All]  ││
│  └──────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

- Two sections: Installed (local cache) and Browse (remote registry)
- Installed circuits show update availability
- Browse shows featured/popular circuits with pull counts
- Category filters
- Circuit detail page: README, layer breakdown, transition list, network policy, breaker config
- Pull progress with layer-level deduplication shown

---

### 5. Fleet Panel

Manage remote fleet endpoints and monitor remote circuit execution.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Fleet                                           [+ Add Endpoint]   │
│                                                                     │
│  ┌─ aws-us-east ────────────────────────────────────────────────────┐│
│  │ URL: https://fleet-us-east.example.com                           ││
│  │ Status: ● Connected  │  VMs: 3/10  │  Latency: 42ms             ││
│  │                                                                  ││
│  │ Active runs:                                                     ││
│  │   run-x1y2z3  cb/security:1.4   sca ⏳   2m 10s                 ││
│  │   run-m4n5o6  cb/coverage:2.0   unit ✓   1m 48s                 ││
│  ├─ on-prem ────────────────────────────────────────────────────────┤│
│  │ URL: https://fleet.internal:8443                                 ││
│  │ Status: ● Connected  │  VMs: 1/5   │  Latency: 3ms              ││
│  └──────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  Resource allocation:                                               │
│  Local:      ████████░░░░░░░░  4.2 GB / 8 GB available             │
│  aws-us-east: ██░░░░░░░░░░░░░  3 / 10 VM slots                    │
│  on-prem:    █░░░░░░░░░░░░░░░  1 / 5 VM slots                     │
└─────────────────────────────────────────────────────────────────────┘
```

- List configured fleet endpoints with connection status
- Real-time VM counts, latency, active runs
- Resource allocation overview: local vs remote capacity
- Add/edit/remove endpoints
- Test connection button
- View logs from remote runs (streamed through fleet)

---

### 6. Builds Panel (History + Timeline)

Historical view of all circuit runs across all projects.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Build History                                                      │
│                                                                     │
│  ┌─ Timeline ───────────────────────────────────────────────────────┐│
│  │                                                                  ││
│  │  10:28  ──┬── security:1.4 ────── 1m 48s ──── ✓ passed         ││
│  │           │                                                      ││
│  │  10:30  ──┼── quality-rust:1.0 ── 2m 14s ──── ✓ passed         ││
│  │           │                                                      ││
│  │  10:30  ──┼── coverage:2.0 ────── 3m 02s ──── ✗ failed         ││
│  │           │                                                      ││
│  │  10:35  ──┼── coverage:2.0 ────── 2m 48s ──── ✓ passed (rerun) ││
│  │           │                                                      ││
│  │  11:00  ──┴── quality-js:1.0 ──── 45s ──────── ✓ passed        ││
│  │                                                                  ││
│  └──────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  Filters: [Date range] [Circuit] [Status] [Source path] [Project]  │
│                                                                     │
│  Stats (last 7 days):                                               │
│  Total runs: 142  │  Pass rate: 91%  │  Avg duration: 1m 52s       │
│  Reruns saved: 38m total  │  Snapshots: 426  │  Disk: 1.8 GB       │
└─────────────────────────────────────────────────────────────────────┘
```

- Timeline visualization: overlapping circuit runs shown as swim lanes
- Filter by date, circuit type, status, project
- Aggregate statistics: pass rate, average duration, time saved by reruns
- Click any run to jump to its circuit detail view
- Export history as CSV/JSON

---

## System Tray

The app lives in the system tray when the window is closed.

```
┌───────────────────────────┐
│ ⚡ Circuit Breaker         │
│ ─────────────────────────│
│ ● SmolVM: running         │
│   VMs: 3 active           │
│   RAM: 4.2 GB             │
│ ─────────────────────────│
│ Recent:                   │
│   ✓ quality-rust  2m ago  │
│   ✓ security      5m ago  │
│   ✗ coverage      8m ago  │
│ ─────────────────────────│
│ Open Dashboard            │
│ Run Circuit...            │
│ ─────────────────────────│
│ Settings                  │
│ Quit                      │
└───────────────────────────┘
```

- Status at a glance: SmolVM health, active VMs, resource usage
- Recent circuit runs with pass/fail
- Quick actions: open dashboard, run a circuit
- macOS: native NSMenu, Linux: system tray via libappindicator

---

## Tauri Backend Commands

The frontend communicates with the backend via Tauri's `invoke()` IPC. Each command maps to a Rust function.

### Circuit Commands

| Command | Parameters | Returns | Description |
|---------|-----------|---------|-------------|
| `circuit_list` | `filter?: { status, circuit, source }` | `CircuitRun[]` | List all circuit runs |
| `circuit_run` | `{ circuit, source, args? }` | `RunHandle` | Start a new circuit run |
| `circuit_stop` | `{ run_id }` | `void` | Stop a running circuit |
| `circuit_detail` | `{ run_id }` | `CircuitRunDetail` | Get full run details |
| `circuit_rollback` | `{ run_id, transition_id }` | `void` | Rollback to snapshot |
| `circuit_rerun` | `{ run_id, from_transition }` | `RunHandle` | Rerun from a transition |

### Machine Commands

| Command | Parameters | Returns | Description |
|---------|-----------|---------|-------------|
| `machine_list` | `filter?: { status }` | `Machine[]` | List all SmolVMs |
| `machine_create` | `{ name, image, cpus?, mem? }` | `MachineHandle` | Create a new VM |
| `machine_start` | `{ name }` | `void` | Start a stopped VM |
| `machine_stop` | `{ name }` | `void` | Stop a running VM |
| `machine_exec` | `{ name, command }` | `ExecResult` | Run a command in a VM |
| `machine_delete` | `{ name }` | `void` | Delete a VM |
| `machine_stats` | `{ name }` | `MachineStats` | Get real-time resource stats |

### Snapshot Commands

| Command | Parameters | Returns | Description |
|---------|-----------|---------|-------------|
| `snapshot_list` | `{ run_id? }` | `Snapshot[]` | List snapshots |
| `snapshot_inspect` | `{ hash }` | `SnapshotDelta` | Get filesystem delta |
| `snapshot_seal` | `{ hash, output_path }` | `string` | Export as artifact |
| `snapshot_delete` | `{ hash }` | `void` | Delete a snapshot |
| `snapshot_gc` | `{}` | `GcResult` | Garbage collect orphaned snapshots |

### Registry Commands

| Command | Parameters | Returns | Description |
|---------|-----------|---------|-------------|
| `registry_search` | `{ query, category? }` | `CircuitInfo[]` | Search the registry |
| `registry_pull` | `{ circuit, tag }` | `PullProgress` | Pull a circuit |
| `registry_push` | `{ circuit, tag }` | `void` | Push a circuit |
| `registry_installed` | `{}` | `InstalledCircuit[]` | List locally cached circuits |
| `registry_inspect` | `{ circuit, tag }` | `CircuitManifest` | Get circuit details |

### Fleet Commands

| Command | Parameters | Returns | Description |
|---------|-----------|---------|-------------|
| `fleet_endpoints` | `{}` | `FleetEndpoint[]` | List configured endpoints |
| `fleet_add` | `{ name, url, auth }` | `void` | Add an endpoint |
| `fleet_remove` | `{ name }` | `void` | Remove an endpoint |
| `fleet_status` | `{ name }` | `FleetStatus` | Get endpoint status |
| `fleet_test` | `{ name }` | `TestResult` | Test connectivity |

---

## Tauri Event Streams

For real-time updates, the backend emits events that the frontend subscribes to.

| Event | Payload | Description |
|-------|---------|-------------|
| `circuit:transition:started` | `{ run_id, transition_id }` | Transition began executing |
| `circuit:transition:completed` | `{ run_id, transition_id, status, duration, snapshot_hash }` | Transition finished |
| `circuit:transition:log` | `{ run_id, transition_id, line, stream }` | Log line from transition |
| `circuit:breaker:tripped` | `{ run_id, reason, transition_id }` | Breaker tripped |
| `circuit:run:completed` | `{ run_id, status, duration }` | Entire circuit run finished |
| `machine:stats` | `{ name, cpu, mem, disk_read, disk_write, net_in, net_out }` | Resource tick (1/s) |
| `machine:state:changed` | `{ name, old_state, new_state }` | VM state transition |
| `registry:pull:progress` | `{ circuit, layer, bytes_done, bytes_total }` | Pull progress per layer |
| `fleet:connection:changed` | `{ name, connected, latency }` | Fleet endpoint status change |

Frontend subscription pattern (React):

```typescript
import { listen } from '@tauri-apps/api/event';

// In a React component or hook
useEffect(() => {
  const unlisten = listen<TransitionLog>('circuit:transition:log', (event) => {
    appendLog(event.payload);
  });
  return () => { unlisten.then(fn => fn()); };
}, [runId]);
```

---

## Project Structure

```
circuit-breaker/
├── desktop/                          # Tauri app root
│   ├── src-tauri/                    # Rust backend
│   │   ├── Cargo.toml               # Depends on cb-core, cb-runner
│   │   ├── src/
│   │   │   ├── main.rs              # Tauri app bootstrap
│   │   │   ├── commands/            # Tauri command handlers
│   │   │   │   ├── circuit.rs       # Circuit run/stop/rollback commands
│   │   │   │   ├── machine.rs       # SmolVM lifecycle commands
│   │   │   │   ├── snapshot.rs      # Snapshot inspect/seal/gc commands
│   │   │   │   ├── registry.rs      # Pull/push/search commands
│   │   │   │   └── fleet.rs         # Fleet endpoint commands
│   │   │   ├── events/              # Event emitters
│   │   │   │   ├── circuit_events.rs
│   │   │   │   ├── machine_events.rs
│   │   │   │   └── registry_events.rs
│   │   │   ├── smolvm.rs            # SmolVM CLI wrapper / FFI
│   │   │   └── tray.rs              # System tray menu
│   │   ├── tauri.conf.json          # Tauri config (window, permissions, signing)
│   │   ├── capabilities/            # Tauri v2 capability files
│   │   └── icons/                   # App icons (macOS .icns, Linux .png)
│   │
│   ├── src/                          # Frontend (React + TypeScript)
│   │   ├── App.tsx                   # Root layout with sidebar
│   │   ├── main.tsx                  # Entry point
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── StatusBar.tsx
│   │   │   │   └── Header.tsx
│   │   │   ├── circuits/
│   │   │   │   ├── CircuitList.tsx
│   │   │   │   ├── CircuitDetail.tsx
│   │   │   │   ├── CircuitProgress.tsx
│   │   │   │   └── RunCircuitDialog.tsx
│   │   │   ├── machines/
│   │   │   │   ├── MachineList.tsx
│   │   │   │   └── MachineDetail.tsx
│   │   │   ├── snapshots/
│   │   │   │   ├── SnapshotBrowser.tsx
│   │   │   │   ├── SnapshotInspect.tsx
│   │   │   │   └── SnapshotDiff.tsx
│   │   │   ├── registry/
│   │   │   │   ├── RegistryBrowser.tsx
│   │   │   │   ├── CircuitCard.tsx
│   │   │   │   └── PullProgress.tsx
│   │   │   ├── fleet/
│   │   │   │   ├── FleetPanel.tsx
│   │   │   │   └── EndpointCard.tsx
│   │   │   ├── builds/
│   │   │   │   ├── BuildHistory.tsx
│   │   │   │   └── BuildTimeline.tsx
│   │   │