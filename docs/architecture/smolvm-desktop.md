# SmolVM Desktop — Local VM Management UI

A Tauri-based desktop application that replaces Docker Desktop for local development. Manages SmolVM microVMs with the same UX developers expect from Docker Desktop — machines, images, volumes, logs, exec, files — but backed by hardware-isolated VMs instead of containers.

## Why

Docker Desktop is heavy (2GB+ RAM idle), requires a Linux VM on macOS anyway, has licensing restrictions for enterprises, and provides namespace-level isolation. SmolVM gives us sub-200ms boot, elastic memory (only uses what the guest needs), hypervisor-level isolation, and no daemon process. But SmolVM is CLI-only today. Developers need a GUI to adopt it for daily use.

This is NOT the Circuit Breaker orchestrator. This is the equivalent of Docker Desktop — a local VM management tool that developers use to run databases, services, and dev environments. Circuit Breaker integration comes later as a plugin/tab once the basics are solid.

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Shell | [Tauri v2](https://v2.tauri.app) | Rust backend, native webview, ~5MB binary, no Electron bloat |
| Frontend | React + TypeScript | Largest ecosystem, most hiring pool |
| Styling | Tailwind CSS | Utility-first, matches the dark theme we need |
| State | Zustand | Lightweight, no boilerplate, good with async |
| Terminal | xterm.js | Industry standard for web-based terminals (VS Code uses it) |
| File browser | Custom tree view | Simple recursive component, no heavy dependency |
| Icons | Lucide React | Clean, consistent, MIT licensed |
| Backend IPC | Tauri commands | Rust functions callable from the frontend via `invoke()` |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  SmolVM Desktop (Tauri v2)                              │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Frontend (React + TypeScript)                    │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │  │
│  │  │ Sidebar  │ │ Machine  │ │ Detail Panel     │  │  │
│  │  │ Nav      │ │ List     │ │ (Logs/Exec/Files)│  │  │
│  │  └──────────┘ └──────────┘ └──────────────────┘  │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │ invoke()                       │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │  Backend (Rust)                                   │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │  │
│  │  │ SmolVM   │ │ Image    │ │ System           │  │  │
│  │  │ Manager  │ │ Manager  │ │ Monitor          │  │  │
│  │  └─────┬────┘ └─────┬────┘ └────────┬─────────┘  │  │
│  └────────┼─────────────┼──────────────┼─────────────┘  │
│           │             │              │                 │
│           ▼             ▼              ▼                 │
│     smolvm CLI    OCI registries   /proc, sysctl        │
│     (subprocess)  (HTTP pulls)     (host metrics)       │
└─────────────────────────────────────────────────────────┘
```

The Rust backend wraps the `smolvm` CLI via subprocess calls. We do NOT embed libkrun directly — that's a future optimization. Starting with CLI wrapping means:
- We ship faster (no FFI complexity)
- We stay compatible with SmolVM updates automatically
- Users can still use `smolvm` CLI alongside the desktop app

## Sidebar Navigation

Modeled after Docker Desktop's left nav. Each item is a top-level view.

```
┌──────────────────┐
│  ⚡ SmolVM        │  ← branding
│                  │
│  🖥  Machines     │  ← running/stopped VMs (Docker: "Containers")
│  💿 Images       │  ← pulled OCI images and .smolmachine packs
│  📁 Volumes      │  ← named volume mounts
│  📊 Stats        │  ← system resource usage
│                  │
│  ─────────────── │
│                  │
│  ⚙️  Settings     │  ← SmolVM config, defaults, fleet endpoints
│                  │
│  ─────────────── │
│  🟢 Engine: on   │  ← SmolVM health indicator
│  RAM 1.2 GB      │  ← aggregate VM memory
│  CPU 3%          │  ← aggregate VM CPU
└──────────────────┘
```

## Views

### 1. Machines (Primary View)

The main landing page. Shows all VMs — running, stopped, and exited.

#### Machine List

Table layout with columns:

| Column | Content | Sort | Filter |
|--------|---------|------|--------|
| Status | 🟢 Running / 🟡 Starting / 🔴 Stopped / ⚪ Exited | ✓ | ✓ |
| Name | Machine name (user-assigned or auto-generated) | ✓ | search |
| Image | OCI image or .smolmachine source | ✓ | ✓ |
| CPU | Current CPU % (live) | ✓ | — |
| Memory | Current RAM usage / balloon limit | ✓ | — |
| Ports | Mapped host:guest ports | — | — |
| Created | Relative timestamp ("2 hours ago") | ✓ | — |
| Actions | ▶ Start / ⏹ Stop / 🔄 Restart / 🗑 Delete | — | — |

Bulk actions: select multiple → stop all / delete all.

Quick actions toolbar:
- **Run** button (top right) → opens "Run a machine" dialog
- **Search** bar → filters by name, image, status
- **Filter** dropdown → Running / Stopped / All

#### Run a Machine Dialog

```
┌─────────────────────────────────────────────────────────┐
│  Run a new machine                                      │
│                                                         │
│  Image:    [ alpine                          ▼ ] [Pull] │
│  Name:     [ my-postgres                       ]        │
│  Command:  [ /bin/sh                           ]        │
│                                                         │
│  ☑ Interactive (-it)                                    │
│  ☐ Networking (--net)                                   │
│  ☐ SSH Agent forwarding (--ssh-agent)                   │
│                                                         │
│  ▸ Advanced                                             │
│    CPUs:      [ 4     ]                                 │
│    Memory:    [ 4096  ] MB                              │
│    Volumes:   [ + Add volume mount ]                    │
│    Ports:     [ + Add port mapping ]                    │
│    Env vars:  [ + Add variable     ]                    │
│    Allow hosts: [ + Add host       ]                    │
│                                                         │
│                            [ Cancel ]  [ Run ]          │
└─────────────────────────────────────────────────────────┘
```

#### Machine Detail View

Clicking a machine row opens the detail panel (or navigates to a full-page detail, depending on screen width). Header shows:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← Machines / my-postgres                                          │
│                                                                     │
│  🖥  my-postgres                                                    │
│  📎 a7b3c9e1f2d4  🔗 postgres:16-alpine    STATUS: 🟢 Running     │
│  🔌 5432:5432                               Uptime: 3h 22m         │
│                                                                     │
│               [ ⏹ Stop ]  [ 🔄 Restart ]  [ 🗑 Delete ]           │
│                                                                     │
│  ┌──────┬─────────┬──────┬──────┬───────┬───────┐                  │
│  │ Logs │ Inspect │ Exec │ Files│ Ports │ Stats │                  │
│  └──────┴─────────┴──────┴──────┴───────┴───────┘                  │
│                                                                     │
│  (tab content below)                                                │
└─────────────────────────────────────────────────────────────────────┘
```

##### Logs Tab

- Real-time log stream from the VM's stdout/stderr
- Rendered in a monospace terminal-style panel (xterm.js in read-only mode, or a simpler pre-formatted view)
- Auto-scroll to bottom (toggle to pause)
- Search within logs (Ctrl+F / Cmd+F)
- Wrap/no-wrap toggle
- Timestamp toggle (show/hide timestamps)
- Download logs button
- Clear display button (doesn't clear actual logs, just the viewport)

##### Inspect Tab

- JSON tree view of the machine's configuration
- Image details, environment variables, volume mounts, network config, resource limits
- Collapsible sections
- Copy button for individual values

##### Exec Tab

- Full interactive terminal (xterm.js) connected to the running VM
- Default shell: `/bin/sh` (configurable)
- Supports resize, color, cursor movement (full PTY)
- Multiple exec sessions in sub-tabs
- "New session" button to open additional shells
- Implementation: Tauri backend spawns `smolvm machine exec --name <name> -it -- /bin/sh` and bridges stdin/stdout/stderr to xterm.js via Tauri events

##### Files Tab

- File browser showing the VM's filesystem
- Tree view on the left, file content preview on the right
- Navigate directories by clicking
- Breadcrumb path bar
- Download files from VM to host
- Upload files from host to VM
- Edit small text files inline (with save)
- Implementation: `smolvm machine exec --name <name> -- ls -la /path` for listing, `smolvm machine exec --name <name> -- cat /path` for reading

##### Ports Tab

- Table of mapped ports: host port → guest port, protocol (TCP/UDP)
- Clickable host ports open `http://localhost:<port>` in default browser
- Show which process inside the VM is listening on each port

##### Stats Tab

- Live resource usage graphs (last 5 minutes rolling):
  - CPU % (line chart)
  - Memory usage vs balloon limit (area chart)
  - Network I/O bytes (line chart, rx/tx)
  - Disk I/O (line chart, read/write)
- Current values in large text above each graph
- Implementation: poll `smolvm machine stats --name <name>` or parse from host process metrics

### 2. Images

Lists all locally available OCI images and `.smolmachine` packs.

#### Image List

| Column | Content |
|--------|---------|
| Repository | Image name (e.g., `postgres`, `alpine`, `cb/security`) |
| Tag | Version tag (e.g., `16-alpine`, `latest`, `1.4`) |
| Size | Compressed size on disk |
| Created | When the image was pulled/built |
| Actions | ▶ Run / 🗑 Remove |

#### Pull Image Dialog

```
┌─────────────────────────────────────────────────────────┐
│  Pull an image                                          │
│                                                         │
│  Image:  [ postgres:16-alpine              ]  [ Pull ]  │
│                                                         │
│  Registry: [ Docker Hub (default)          ▼ ]          │
│                                                         │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░  45% (128 MB / 284 MB)  │
└─────────────────────────────────────────────────────────┘
```

#### Image Detail

Clicking an image shows:
- Layer breakdown (size per layer)
- Environment variables baked in
- Entrypoint / command
- Exposed ports
- History (build steps, if available)

### 3. Volumes

Named directories that persist across machine restarts and can be shared between machines.

| Column | Content |
|--------|---------|
| Name | Volume name |
| Mount path | Where it's mounted in the guest |
| Host path | Where it lives on the host |
| Used by | Which machines reference this volume |
| Size | Disk usage |
| Actions | 📂 Open in Finder/Explorer / 🗑 Remove |

Create volume dialog:
- Name (required)
- Host path (browse or type)
- Default mount path (suggestion)

### 4. Stats (System Overview)

Dashboard view showing aggregate resource usage across all running VMs.

```
┌─────────────────────────────────────────────────────────┐
│  System Resources                                       │
│                                                         │
│  ┌─────────────────────┐  ┌─────────────────────┐      │
│  │ CPU                 │  │ Memory              │      │
│  │ ████░░░░░░ 12%      │  │ ██████░░░░ 4.2 GB   │      │
│  │ (across 3 VMs)      │  │ (of 16 GB system)   │      │
│  │                     │  │                     │      │
│  │  📈 [5min graph]    │  │  📈 [5min graph]    │      │
│  └─────────────────────┘  └─────────────────────┘      │
│                                                         │
│  ┌─────────────────────┐  ┌─────────────────────┐      │
│  │ Disk                │  │ Network             │      │
│  │ Images: 2.1 GB      │  │ ▼ 1.2 MB/s in      │      │
│  │ Volumes: 840 MB     │  │ ▲ 340 KB/s out      │      │
│  │ Snapshots: 1.3 GB   │  │                     │      │
│  │ Total: 4.2 GB       │  │  📈 [5min graph]    │      │
│  └─────────────────────┘  └─────────────────────┘      │
│                                                         │
│  Running Machines          CPU    Memory                │
│  ├─ my-postgres            2%     840 MB                │
│  ├─ redis-cache            1%     120 MB                │
│  └─ dev-environment        9%     3.2 GB                │
└─────────────────────────────────────────────────────────┘
```

### 5. Settings

#### General
- Start SmolVM Desktop at login (yes/no)
- Default CPUs for new machines
- Default memory for new machines
- Default network mode (off / on)
- Theme: dark / light / system

#### Resources
- Global CPU limit (max cores SmolVM can use)
- Global memory limit (max RAM across all VMs)
- Disk usage limit (max storage for images + volumes + snapshots)

#### Registries
- List of OCI registries (Docker Hub by default)
- Add custom registries with auth credentials
- Circuit registry endpoints (for future CB integration)

#### Fleet (Future — Phase 3 of CB implementation)
- Remote fleet endpoint configuration
- Connection status indicator
- Test connection button

## Tauri Backend — Rust Commands

Each frontend `invoke()` call maps to a Rust function. The backend wraps the `smolvm` CLI.

### Machine Commands

```rust
#[tauri::command]
async fn list_machines() -> Result<Vec<Machine>, String>
// Runs: smolvm machine list --format json

#[tauri::command]
async fn create_machine(config: MachineConfig) -> Result<Machine, String>
// Runs: smolvm machine create --image <img> --name <name> [--net] [--cpus N] [--mem N] ...

#[tauri::command]
async fn start_machine(name: String) -> Result<(), String>
// Runs: smolvm machine start --name <name>

#[tauri::command]
async fn stop_machine(name: String) -> Result<(), String>
// Runs: smolvm machine stop --name <name>

#[tauri::command]
async fn restart_machine(name: String) -> Result<(), String>
// stop + start

#[tauri::command]
async fn delete_machine(name: String) -> Result<(), String>
// Runs: smolvm machine delete --name <name>

#[tauri::command]
async fn run_machine(config: RunConfig) -> Result<Machine, String>
// Runs: smolvm machine run --image <img> [--name <name>] [--net] [--volume ...] -- <cmd>

#[tauri::command]
async fn get_machine_logs(name: String, tail: Option<u32>) -> Result<String, String>
// Runs: smolvm machine logs --name <name> [--tail N]

#[tauri::command]
async fn inspect_machine(name: String) -> Result<MachineInspect, String>
// Runs: smolvm machine inspect --name <name> --format json

#[tauri::command]
async fn machine_stats(name: String) -> Result<MachineStats, String>
// Polls: smolvm machine stats --name <name> --format json
```

### Exec (Terminal)

The exec tab needs a persistent bidirectional stream, not a request/response pattern. Use Tauri's event system:

```rust
#[tauri::command]
async fn exec_start(app: AppHandle, name: String, session_id: String, cmd: String) -> Result<(), String>
// Spawns: smolvm machine exec --name <name> -it -- <cmd>
// Bridges stdin/stdout/stderr to Tauri events:
//   emit("exec-stdout-{session_id}", data)
//   emit("exec-stderr-{session_id}", data)
//   listen("exec-stdin-{session_id}", data) → write to process stdin

#[tauri::command]
async fn exec_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String>
// Sends SIGWINCH / resize to the PTY

#[tauri::command]
async fn exec_stop(session_id: String) -> Result<(), String>
// Kills the exec process
```

Frontend xterm.js integration:

```typescript
// Connect xterm.js to Tauri events
const term = new Terminal({ theme: darkTheme });
const sessionId = crypto.randomUUID();

await invoke('exec_start', { name: machineName, sessionId, cmd: '/bin/sh' });

// stdout → terminal
listen(`exec-stdout-${sessionId}`, (event) => {
  term.write(event.payload as string);
});

// terminal input → stdin
term.onData((data) => {
  emit(`exec-stdin-${sessionId}`, data);
});

// resize
term.onResize(({ cols, rows }) => {
  invoke('exec_resize', { sessionId, cols, rows });
});
```

### File Browser

```rust
#[tauri::command]
async fn list_files(name: String, path: String) -> Result<Vec<FileEntry>, String>
// Runs: smolvm machine exec --name <name> -- ls -la --time-style=full-iso <path>
// Parses output into Vec<FileEntry>

#[tauri::command]
async fn read_file(name: String, path: String) -> Result<FileContent, String>
// Runs: smolvm machine exec --name <name> -- cat <path>
// For binary detection: check first 8KB for null bytes

#[tauri::command]
async fn write_file(name: String, path: String, content: String) -> Result<(), String>
// Pipes content via stdin: echo <content> | smolvm machine exec --name <name> -- tee <path>

#[tauri::command]
async fn download_file(name: String, vm_path: String, host_path: String) -> Result<(), String>
// Runs: smolvm machine exec --name <name> -- cat <vm_path> > <host_path>

#[tauri::command]
async fn upload_file(name: String, host_path: String, vm_path: String) -> Result<(), String>
// Pipes: cat <host_path> | smolvm machine exec --name <name> -- tee <vm_path>
```

### Image Commands

```rust
#[tauri::command]
async fn list_images() -> Result<Vec<Image>, String>
// Runs: smolvm image list --format json (or parses local cache directory)

#[tauri::command]
async fn pull_image(app: AppHandle, reference: String) -> Result<(), String>
// Runs: smolvm image pull <reference>
// Emits progress events: emit("pull-progress", { reference, percent, bytes_done, bytes_total })

#[tauri::command]
async fn remove_image(reference: String) -> Result<(), String>
// Runs: smolvm image remove <reference>

#[tauri::command]
async fn inspect_image(reference: String) -> Result<ImageInspect, String>
// Runs: smolvm image inspect <reference> --format json
```

### System Commands

```rust
#[tauri::command]
async fn system_info() -> Result<SystemInfo, String>
// Runs: smolvm info --format json
// Returns: smolvm version, hypervisor type, host OS, CPU count, total RAM

#[tauri::command]
async fn system_stats() -> Result<SystemStats, String>
// Aggregates stats across all running VMs
// Polls host metrics: total CPU, total RAM used by VMs, disk usage

#[tauri::command]
async fn smolvm_health() -> Result<HealthStatus, String>
// Checks: is smolvm binary in PATH? Can it access the hypervisor?
// Returns: { healthy: bool, version: String, hypervisor: String, error: Option<String> }
```

## Data Types

```rust
#[derive(Serialize, Deserialize)]
struct Machine {
    name: String,
    id: String,
    status: MachineStatus,       // Running, Stopped, Starting, Exited
    image: String,
    created: String,             // ISO 8601
    ports: Vec<PortMapping>,
    cpu_percent: Option<f64>,
    memory_bytes: Option<u64>,
    memory_limit: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct MachineConfig {
    image: String,
    name: Option<String>,
    cpus: Option<u32>,
    memory_mb: Option<u32>,
    network: bool,
    interactive: bool,
    ssh_agent: bool,
    volumes: Vec<VolumeMount>,
    ports: Vec<PortMapping>,
    env: Vec<EnvVar>,
    allow_hosts: Vec<String>,
    command: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct PortMapping {
    host: u16,
    guest: u16,
    protocol: String,            // "tcp" or "udp"
}

#[derive(Serialize, Deserialize)]
struct VolumeMount {
    host_path: String,
    guest_path: String,
    readonly: bool,
}

#[derive(Serialize, Deserialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: String,
    permissions: String,
}

#[derive(Serialize, Deserialize)]
struct MachineStats {
    cpu_percent: f64,
    memory_used: u64,
    memory_limit: u64,
    network_rx_bytes: u64,
    network_tx_bytes: u64,
    disk_read_bytes: u64,
    disk_write_bytes: u64,
    timestamp: String,
}
```

## UI Theme

Dark theme by default (matching the screenshot reference). Color palette:

| Element | Color | Hex |
|---------|-------|-----|
| Background (main) | Dark navy | `#1a1f36` |
| Background (sidebar) | Darker navy | `#141829` |
| Background (cards) | Slightly lighter | `#1e2440` |
| Text (primary) | White | `#ffffff` |
| Text (secondary) | Gray | `#8b92a8` |
| Accent (primary) | Blue | `#4c7bf4` |
| Success / Running | Green | `#34d399` |
| Warning / Starting | Yellow | `#fbbf24` |
| Error / Stopped | Red | `#f87171` |
| Border | Subtle gray | `#2a3050` |
| Terminal background | Near black | `#0d1117` |
| Terminal text | Light gray | `#c9d1d9` |

## Log Streaming Implementation

Logs need to be streamed in real-time, not polled. Approach:

1. Backend spawns `smolvm machine logs --name <name> --follow` as a long-lived process
2. stdout is read line-by-line in a Tokio task
3. Each line is emitted as a Tauri event: `emit("machine-logs-{name}", line)`
4. Frontend listens and appends to a ring buffer (keep last 10,000 lines in memory)
5. xterm.js or a virtual-scrolling `<pre>` renders the visible portion
6. When the user navigates away, the background task keeps running (logs are buffered)
7. When the machine stops, the task exits cleanly

```rust
#[tauri::command]
async fn follow_logs(app: AppHandle, name: String) -> Result<(), String> {
    let child = Command::new("smolvm")
        .args(["machine", "logs", "--name", &name, "--follow"])
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let stdout = child.stdout.take().unwrap();
    let reader = BufReader::new(stdout);

    tauri::async_runtime::spawn(async move {
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let _ = app.emit(&format!("machine-logs-{}", name), &text);
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}
```

## Stats Polling Implementation

Stats are polled every 2 seconds (configurable). Each poll emits an event with the latest metrics. The frontend maintains a rolling window of data points for the charts.

```rust
#[tauri::command]
async fn follow_stats(app: AppHandle, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn(async move {
        loop {
            match get_machine_stats(&name).await {
                Ok(stats) => {
                    let _ = app.emit(&format!("machine-stats-{}", name), &stats);
                }
                Err(_) => break,
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });

    Ok(())
}
```

## Project Structure

```
smolvm-desktop/
├── src-tauri/                      # Rust backend
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── src/
│   │   ├── main.rs                 # Tauri app entry
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── machines.rs         # Machine CRUD commands
│   │   │   ├── exec.rs             # Exec session management
│   │   │   ├── files.rs            # File browser commands
│   │   │   ├── images.rs           # Image management commands
│   │   │   └── system.rs           # System info, health, stats
│   │   ├── smolvm/
│   │   │   ├── mod.rs
│   │   │   ├── cli.rs              # SmolVM CLI wrapper (subprocess)
│   │   │   └── parser.rs           # Parse smolvm output → structs
│   │   └── types.rs                # Shared data types
│   └── icons/                      # App icons
│
├── src/                            # React frontend
│   ├── App.tsx                     # Root layout (sidebar + content)
│   ├── main.tsx                    # Entry point
│   ├── index.css                   # Tailwind imports + dark theme
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx         # Left navigation
│   │   │   ├── StatusBar.tsx       # Bottom bar (engine status, resource usage)
│   │   │   └── Header.tsx          # Top bar with search and actions
│   │   ├── machines/
│   │   │   ├── MachineList.tsx     # Table of all machines
│   │   │   ├── MachineRow.tsx      # Single machine row
│   │   │   ├── MachineDetail.tsx   # Detail view with tabs
│   │   │   ├── LogsTab.tsx         # Real-time log viewer
│   │   │   ├── ExecTab.tsx         # Interactive terminal
│   │   │   ├── FilesTab.tsx        # File browser
│   │   │   ├── InspectTab.tsx      # JSON config tree
│   │   │   ├── PortsTab.tsx        # Port mappings
│   │   │   ├── StatsTab.tsx        # Resource graphs
│   │   │   └── RunDialog.tsx       # "Run a machine" modal
│   │   ├── images/
│   │   │   ├── ImageList.tsx
│   │   │   ├── ImageDetail.tsx
│   │   │   └── PullDialog.tsx
│   │   ├── volumes/
│   │   │   ├── VolumeList.tsx
│   │   │   └── CreateVolumeDialog.tsx
│   │   ├── stats/
│   │   │   └── SystemDashboard.tsx
│   │   ├── settings/
│   │   │   └── SettingsView.tsx
│   │   └── shared/
│   │       ├── Terminal.tsx         # xterm.js wrapper
│   │       ├── JsonTree.tsx         # Collapsible JSON viewer
│   │       ├── Chart.tsx            # Simple line/area chart (lightweight)
│   │       ├── DataTable.tsx        # Sortable, filterable table
│   │       └── Badge.tsx            # Status badges
│   ├── hooks/
│   │   ├── useMachines.ts          # Zustand store + polling
│   │   ├── useImages.ts
│   │   ├── useExecSession.ts       # Manages xterm.js ↔ Tauri events
│   │   ├── useLogStream.ts         # Manages log following
│   │   └── useStats.ts             # Manages stats polling
│   └── lib/
│       ├── invoke.ts               # Typed Tauri invoke wrappers
│       └── types.ts                # TypeScript types matching Rust types
│
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── vite.config.ts
└── README.md
```

## Implementation Phases

### Phase A — Shell + Machine List (Week 1)

- [ ] Initialize Tauri v2 + React + TypeScript + Tailwind project
- [ ] Implement sidebar navigation (static, no routing yet)
- [ ] Implement `list_machines` backend command (parse `smolvm machine list`)
- [ ] Implement `MachineList` component with status indicators
- [ ] Implement `start_machine`, `stop_machine`, `delete_machine` commands
- [ ] Implement status bar with SmolVM health check and aggregate resource display
- [ ] Dark theme applied globally

**Exit:** App launches, shows list of SmolVM machines, can start/stop/delete them.

### Phase B — Machine Detail + Logs (Week 2)

- [ ] Implement machine detail view with tab navigation
- [ ] Implement `InspectTab` with JSON tree viewer
- [ ] Implement `LogsTab` with real-time streaming via Tauri events
- [ ] Implement log search, auto-scroll toggle, download
- [ ] Implement `PortsTab` with clickable links
- [ ] Wire up "Run a machine" dialog with basic options (image, name, network, interactive)

**Exit:** Click a machine → see live logs, inspect config, view ports. Can run new machines from the UI.

### Phase C — Exec + Files (Week 3)

- [ ] Implement `ExecTab` with xterm.js integration
- [ ] Implement PTY bridging via Tauri events (stdin/stdout/stderr)
- [ ] Implement terminal resize handling
- [ ] Support multiple exec sessions per machine (sub-tabs)
- [ ] Implement `FilesTab` with tree navigation
- [ ] Implement file download/upload
- [ ] Implement inline text file editing

**Exit:** Can open a shell into any running VM from the UI. Can browse, download, upload, and edit files.

### Phase D — Images + Volumes (Week 4)

- [ ] Implement `ImageList` view
- [ ] Implement `pull_image` with progress streaming
- [ ] Implement image inspect and delete
- [ ] Implement "Run from image" (click image → pre-filled Run dialog)
- [ ] Implement `VolumeList` view
- [ ] Implement volume create/delete
- [ ] Link volumes to machines that use them

**Exit:** Full image management. Full volume management. Can pull images and run machines from them.

### Phase E — Stats + Polish (Week 5)

- [ ] Implement `StatsTab` per machine with live charts
- [ ] Implement `SystemDashboard` with aggregate resource view
- [ ] Implement Settings view (defaults, registries, resource limits)
- [ ] Add keyboard shortcuts (Cmd+K search, Cmd+N new machine, etc.)
- [ ] Add notifications (toast) for machine state changes
- [ ] Error handling and empty states throughout
- [ ] Window management: remember size/position, menu bar integration

**Exit:** Feature-complete Docker Desktop replacement for SmolVM. Ready for daily use.

### Phase F — Circuit Breaker Integration (Future)

- [ ] Add "Circuits" tab to sidebar (if CB is installed)
- [ ] Show circuit runs with transition progress
- [ ] Overlay snapshot browser (from Phase 2 of CB implementation)
- [ ] Breaker status indicators
- [ ] Fleet connection status (from Phase 3 of CB implementation)
- [ ] Circuit registry browser (from Phase 4 of CB implementation)

This phase is NOT part of the initial build. It's listed here to show where CB plugs in later.

## SmolVM CLI Compatibility

The app wraps the SmolVM CLI. If SmolVM adds native JSON output (likely), we prefer it. If not, we parse the human-readable output. The `smolvm/parser.rs` module handles both cases.

Required SmolVM commands (verify these exist before starting):

| Command | Used for | JSON output? |
|---------|----------|-------------|
| `smolvm machine list` | Machine list | Check |
| `smolvm machine create` | Create persistent machine | — |
| `smolvm machine start` | Start stopped machine | — |
| `smolvm machine stop` | Stop running machine | — |
| `smolvm machine run` | Create + start ephemeral | — |
| `smolvm machine exec` | Run command in machine | — |
| `smolvm machine logs` | Get machine logs | Check |
| `smolvm machine inspect` | Machine config details | Check |
| `smolvm machine delete` | Remove machine | — |
| `smolvm image pull` | Pull OCI image | — |
| `smolvm image list` | List local images | Check |
| `smolvm info` | System information | Check |

**Phase 0 task:** Verify which commands exist, which support `--format json`, and document any gaps. File issues upstream if needed.

## Distribution

- **macOS:** `.dmg` with Hypervisor.framework entitlements (must be signed)
- **Linux:** `.AppImage` or `.deb`/`.rpm` (KVM access requires user in `kvm` group)
- Auto-update via Tauri's built-in updater
- SmolVM binary bundled or detected from PATH (prefer detected — user manages their own SmolVM version)