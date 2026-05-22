/**
 * Local Petri net executor for native CB circuits (.wf.ts files).
 *
 * Runs circuit definitions in-process without NATS, Kubernetes, or Docker.
 * Executes Script and Noop actions directly; SmolVM (Circuit) actions are
 * delegated to the existing smolvm binary if available.
 *
 * This is the inner-loop execution path — isolated, no shared infrastructure.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { Workflow, Transition, Place, ScriptAction, CircuitAction, HttpAction } from "@circuit-breaker/core";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface StepResult {
  id: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  duration_ms: number;
  exit_code: number | null;
  output: string;
  error: string;
  started_at: string;
}

export interface CircuitRunResult {
  circuit: string;
  status: "passed" | "failed";
  steps: StepResult[];
  duration_ms: number;
  failed_step?: string;
}

// ─── Marking helpers ──────────────────────────────────────────────────────────

type Marking = Map<string, number>; // place_id → token count

function buildInitialMarking(places: Place[]): Marking {
  const m = new Map<string, number>();
  for (const p of places) m.set(p.id, p.initialTokens ?? 0);
  return m;
}

function isEnabled(t: Transition, marking: Marking): boolean {
  for (const arc of t.inputs) {
    const tokens = marking.get(arc.place) ?? 0;
    if (tokens < arc.weight) return false;
  }
  return true;
}

function fire(t: Transition, marking: Marking): void {
  for (const arc of t.inputs) {
    marking.set(arc.place, (marking.get(arc.place) ?? 0) - arc.weight);
  }
  for (const arc of t.outputs) {
    marking.set(arc.place, (marking.get(arc.place) ?? 0) + arc.weight);
  }
}

function findEnabled(workflow: Workflow, marking: Marking): Transition[] {
  return workflow.transitions.filter((t) => isEnabled(t, marking));
}

function isTerminal(workflow: Workflow, marking: Marking): boolean {
  return findEnabled(workflow, marking).length === 0;
}

// ─── Action execution ─────────────────────────────────────────────────────────

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  onOutput?: (line: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    chunks.push(text);
    if (onOutput) {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) onOutput(line);
    }
  }
  if (onOutput && buffer.trim()) onOutput(buffer);
  return chunks.join("");
}

async function execScript(
  script: string,
  cwd: string,
  env?: Record<string, string>,
  shell = "sh",
  onOutput?: (line: string) => void,
): Promise<{ exit_code: number; stdout: string; stderr: string; duration_ms: number }> {
  const start = performance.now();
  const proc = Bun.spawn([shell, "-e", "-c", script], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    collectStream(proc.stdout as ReadableStream<Uint8Array>, onOutput),
    collectStream(proc.stderr as ReadableStream<Uint8Array>, onOutput),
  ]);
  const exit_code = await proc.exited;
  return { exit_code, stdout, stderr, duration_ms: Math.round(performance.now() - start) };
}

// ─── Main executor ────────────────────────────────────────────────────────────

function buildVmPreamble(workdir?: string): string {
  const repoDir = workdir ?? "/workspace";
  return [
    "set -e",
    '[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" || true',
    '[ -f /etc/profile ] && . /etc/profile 2>/dev/null || true',
    // sudo shim — runner is already root; strip leading '--' then exec the command directly
    'command -v sudo >/dev/null 2>&1 || sudo() { [ "$1" = "--" ] && shift; "$@"; }',
    // nvm activation + per-project node version switching
    `if [ -f "$HOME/.nvm/nvm.sh" ]; then`,
    `  . "$HOME/.nvm/nvm.sh"`,
    `  _CB_NV=""`,
    `  if [ -f "${repoDir}/.nvmrc" ]; then _CB_NV=$(cat "${repoDir}/.nvmrc" 2>/dev/null | tr -d '[:space:]'); fi`,
    `  if [ -z "$_CB_NV" ] && [ -f "${repoDir}/.node-version" ]; then _CB_NV=$(cat "${repoDir}/.node-version" 2>/dev/null | tr -d '[:space:]'); fi`,
    `  if [ -z "$_CB_NV" ] && [ -f "${repoDir}/package.json" ] && command -v node >/dev/null 2>&1; then`,
    `    _CB_NV=$(node -e "try{var p=JSON.parse(require('fs').readFileSync('${repoDir}/package.json','utf8'));var e=(p.engines||{}).node||'';var m=e.match(/[0-9]+[.][0-9]+[.][0-9]+/);if(m)process.stdout.write(m[0]);}catch(ex){}" 2>/dev/null || echo '')`,
    `  fi`,
    `  if [ -n "$_CB_NV" ]; then nvm use "$_CB_NV" 2>/dev/null || (nvm install "$_CB_NV" 2>/dev/null && nvm use "$_CB_NV" 2>/dev/null) || true; fi`,
    `fi`,
    // GitHub Actions environment for inner-loop runs
    'export RUNNER_OS="Linux"',
    'export RUNNER_ARCH="$(uname -m | sed \'s/aarch64/ARM64/; s/x86_64/X64/\')"',
    'export RUNNER_TEMP="/tmp"',
    'export RUNNER_TOOL_CACHE="/opt/hostedtoolcache"',
    'export GITHUB_SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"',
    'export GITHUB_API_URL="${GITHUB_API_URL:-https://api.github.com}"',
    'export GITHUB_RUN_ID="${GITHUB_RUN_ID:-1}"',
    'export GITHUB_RUN_NUMBER="${GITHUB_RUN_NUMBER:-1}"',
    'export GITHUB_WORKFLOW="${GITHUB_WORKFLOW:-local}"',
    'export GITHUB_JOB="${GITHUB_JOB:-local}"',
    `export GITHUB_WORKSPACE="${repoDir}"`,
    'export GITHUB_OUTPUT="${GITHUB_OUTPUT:-/tmp/.cb/github_output}"',
    'export GITHUB_ENV="${GITHUB_ENV:-/tmp/.cb/github_env}"',
    'export GITHUB_PATH="${GITHUB_PATH:-/tmp/.cb/github_path}"',
    'export GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"',
    'mkdir -p /tmp/.cb /opt/hostedtoolcache',
    'touch "$GITHUB_OUTPUT" "$GITHUB_ENV" "$GITHUB_PATH"',
    // Source env/path written by previous steps
    'if [ -s "$GITHUB_ENV" ]; then while IFS= read -r _l || [ -n "$_l" ]; do [ -n "$_l" ] && export "$_l" 2>/dev/null || true; done < "$GITHUB_ENV"; fi',
    'if [ -s "$GITHUB_PATH" ]; then while IFS= read -r _l || [ -n "$_l" ]; do [ -n "$_l" ] && export PATH="$_l:$PATH"; done < "$GITHUB_PATH"; fi',
    // Trust virtiofs-mounted directories (host UID != VM root UID)
    'git config --global --add safe.directory \'*\' 2>/dev/null || true',
    // Default all GitHub context vars to empty string so set -u scripts never see unbound vars
    'export GITHUB_SHA="${GITHUB_SHA:-}"',
    'export GITHUB_REF="${GITHUB_REF:-}"',
    'export GITHUB_REF_NAME="${GITHUB_REF_NAME:-}"',
    'export GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}"',
    'export GITHUB_ACTOR="${GITHUB_ACTOR:-}"',
    'export GITHUB_HEAD_REF="${GITHUB_HEAD_REF:-}"',
    'export GITHUB_BASE_REF="${GITHUB_BASE_REF:-}"',
    'export GITHUB_EVENT_NAME="${GITHUB_EVENT_NAME:-}"',
    'export GITHUB_ACTION="${GITHUB_ACTION:-}"',
    // Derive GitHub context from git if available (overrides the empty defaults above)
    `if command -v git >/dev/null 2>&1 && git -C "${repoDir}" rev-parse --git-dir >/dev/null 2>&1; then`,
    `  _CB_SHA=$(git -C "${repoDir}" rev-parse HEAD 2>/dev/null || echo '')`,
    `  _CB_BRANCH=$(git -C "${repoDir}" branch --show-current 2>/dev/null || echo '')`,
    `  _CB_TAG=$(git -C "${repoDir}" describe --exact-match --tags HEAD 2>/dev/null || echo '')`,
    `  _CB_REMOTE=$(git -C "${repoDir}" remote get-url origin 2>/dev/null | sed 's|.*github\\.com[:/]||; s|\\.git$||' || echo '')`,
    `  _CB_ACTOR=$(git -C "${repoDir}" config user.name 2>/dev/null || echo '')`,
    '  [ -n "${_CB_SHA}" ] && export GITHUB_SHA="${_CB_SHA}"',
    '  [ -n "${_CB_BRANCH}${_CB_TAG}" ] && export GITHUB_REF_NAME="${_CB_BRANCH:-${_CB_TAG}}"',
    '  if [ -n "${_CB_BRANCH:-}" ]; then export GITHUB_REF="refs/heads/${_CB_BRANCH}"; elif [ -n "${_CB_TAG:-}" ]; then export GITHUB_REF="refs/tags/${_CB_TAG}"; fi',
    '  [ -n "${_CB_REMOTE}" ] && export GITHUB_REPOSITORY="${_CB_REMOTE}"',
    '  [ -n "${_CB_ACTOR}" ] && export GITHUB_ACTOR="${_CB_ACTOR}"',
    'fi',
    // Minimal event stub so scripts can `cat "$GITHUB_EVENT_PATH"`
    'if [ -z "${GITHUB_EVENT_PATH:-}" ] || [ ! -f "${GITHUB_EVENT_PATH:-/nonexistent}" ]; then',
    '  export GITHUB_EVENT_PATH="/tmp/.cb/github_event.json"',
    '  printf \'{"repository":{"full_name":"%s"}}\' "${GITHUB_REPOSITORY:-}" > "$GITHUB_EVENT_PATH"',
    'fi',
  ].join("\n");
}

async function execViaSmolvm(
  script: string,
  machine: string,
  workdir?: string,
  onOutput?: (line: string) => void,
): Promise<{ exit_code: number; stdout: string; stderr: string; duration_ms: number }> {
  const start = performance.now();
  const parts: string[] = [buildVmPreamble(workdir)];
  if (workdir) parts.push(`cd ${workdir} || true`);
  parts.push(script);
  const proc = Bun.spawn(
    ["smolvm", "machine", "exec", "--name", machine, "--stream", "--", "bash", "-c", parts.join("\n")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    collectStream(proc.stdout as ReadableStream<Uint8Array>, onOutput),
    collectStream(proc.stderr as ReadableStream<Uint8Array>, onOutput),
  ]);
  const exit_code = await proc.exited;
  return { exit_code, stdout, stderr, duration_ms: Math.round(performance.now() - start) };
}

export async function runCircuit(
  workflow: Workflow,
  source: string,
  options: {
    fromStep?: string;
    smolvmMachine?: string;
    smolvmWorkdir?: string;
    onStepStart?: (id: string, name: string) => void;
    onStepEnd?: (result: StepResult) => void;
    onOutput?: (line: string) => void;
  } = {},
): Promise<CircuitRunResult> {
  const marking = buildInitialMarking(workflow.places);
  const steps: StepResult[] = [];
  const startedAt = performance.now();
  let failed = false;
  let failedStep: string | undefined;
  let skipping = !!options.fromStep;

  // Topological execution: fire one enabled transition at a time.
  // For inner-loop circuits, we expect a mostly linear graph (chain of steps).
  // Concurrent firing is not attempted here; correctness > parallelism.
  const executed = new Set<string>();

  while (!isTerminal(workflow, marking)) {
    const enabled = findEnabled(workflow, marking);
    if (enabled.length === 0) break;

    // Pick the first enabled transition not yet executed
    const t = enabled.find((e) => !executed.has(e.id)) ?? enabled[0];
    if (!t || executed.has(t.id)) break; // guard against infinite loops

    executed.add(t.id);

    const stepId = t.id;
    const stepName = t.id; // display name = transition id

    if (skipping) {
      if (stepId === options.fromStep) skipping = false;
      // Fire the transition without executing to advance marking
      if (skipping) {
        fire(t, marking);
        steps.push({
          id: stepId,
          name: stepName,
          status: "skipped",
          duration_ms: 0,
          exit_code: null,
          output: "",
          error: "",
          started_at: new Date().toISOString(),
        });
        continue;
      }
    }

    // In a fanout, parallel branches are independent — continue executing them
    // even if a sibling branch failed. Only skip sequential steps after the join.
    const isParallelBranch = t.inputs.length > 0 && t.inputs.every(
      (arc) => arc.place.startsWith("fanout-") && arc.place.endsWith("-in"),
    );
    if (failed && !isParallelBranch) {
      fire(t, marking);
      steps.push({
        id: stepId,
        name: stepName,
        status: "skipped",
        duration_ms: 0,
        exit_code: null,
        output: "",
        error: "",
        started_at: new Date().toISOString(),
      });
      continue;
    }

    options.onStepStart?.(stepId, stepName);
    const startedAtStep = new Date().toISOString();

    let result: StepResult;

    const action = t.action;
    const isFanoutPlumbing = t.id.startsWith("fanout-fork-") || t.id.startsWith("fanout-join-");
    if (!action || action.type === "noop" || isFanoutPlumbing) {
      result = {
        id: stepId,
        name: stepName,
        status: "passed",
        duration_ms: 0,
        exit_code: 0,
        output: "",
        error: "",
        started_at: startedAtStep,
      };
    } else if (action.type === "script") {
      const sa = action as ScriptAction;
      // Inline code runs via sh -c (it's a shell command, not raw JS).
      // File-based scripts are invoked with the specified runtime.
      const scriptContent = sa.code ?? (sa.file ? `${sa.runtime ?? "bun"} "${sa.file}"` : "");
      const execResult = options.smolvmMachine && scriptContent
        ? await execViaSmolvm(scriptContent, options.smolvmMachine, options.smolvmWorkdir, options.onOutput)
        : await execScript(scriptContent, source, undefined, "sh", options.onOutput);
      const passed = execResult.exit_code === 0;
      result = {
        id: stepId,
        name: stepName,
        status: passed ? "passed" : "failed",
        duration_ms: execResult.duration_ms,
        exit_code: execResult.exit_code,
        output: execResult.stdout,
        error: execResult.stderr,
        started_at: startedAtStep,
      };
    } else if (action.type === "circuit") {
      result = await runCircuitAction(stepId, stepName, action as CircuitAction, source, startedAtStep);
    } else if (action.type === "http") {
      result = await runHttpAction(stepId, stepName, action as HttpAction, startedAtStep);
    } else {
      result = {
        id: stepId,
        name: stepName,
        status: "skipped",
        duration_ms: 0,
        exit_code: null,
        output: `Unsupported action type: ${(action as { type: string }).type}`,
        error: "",
        started_at: startedAtStep,
      };
    }

    steps.push(result);
    options.onStepEnd?.(result);

    if (result.status === "failed") {
      failed = true;
      failedStep = stepId;
    }

    fire(t, marking);
  }

  const duration_ms = Math.round(performance.now() - startedAt);
  const allPassed = steps.every((s) => s.status === "passed" || s.status === "skipped");

  return {
    circuit: workflow.name,
    status: allPassed ? "passed" : "failed",
    steps,
    duration_ms,
    failed_step: failedStep,
  };
}

// ─── Action type handlers ─────────────────────────────────────────────────────

async function runCircuitAction(
  stepId: string,
  stepName: string,
  action: CircuitAction,
  source: string,
  startedAt: string,
): Promise<StepResult> {
  const start = performance.now();

  // Check if smolvm is available
  const smolvmCheck = spawnSync("smolvm", ["--version"], { stdio: "pipe" });
  if (smolvmCheck.status !== 0) {
    return {
      id: stepId,
      name: stepName,
      status: "failed",
      duration_ms: 0,
      exit_code: 1,
      output: "",
      error: "smolvm not found; install smolvm to run circuit actions",
      started_at: startedAt,
    };
  }

  // Run the command in SmolVM (or fall back to host shell)
  const cmd = action.command;
  const shell = action.shell ?? "sh";
  const proc = Bun.spawn(
    ["smolvm", "machine", "exec", "--name", "cb-check", "--", shell, "-c", cmd],
    { stdout: "pipe", stderr: "pipe" },
  );
  const allOutput = [await new Response(proc.stdout).text()];
  const allErrors = [await new Response(proc.stderr).text()];
  const lastExit = await proc.exited;

  const duration_ms = Math.round(performance.now() - start);
  return {
    id: stepId,
    name: stepName,
    status: lastExit === 0 ? "passed" : "failed",
    duration_ms,
    exit_code: lastExit,
    output: allOutput.join(""),
    error: allErrors.join(""),
    started_at: startedAt,
  };
}

async function runHttpAction(
  stepId: string,
  stepName: string,
  action: HttpAction,
  startedAt: string,
): Promise<StepResult> {
  const start = performance.now();
  try {
    const resp = await fetch(action.url, {
      method: action.method ?? "POST",
      headers: action.headers,
      body: action.body,
    });
    const text = await resp.text();
    const duration_ms = Math.round(performance.now() - start);
    const expected = action.expectedStatus ?? [200, 201, 202, 204];
    const passed = expected.includes(resp.status);
    return {
      id: stepId,
      name: stepName,
      status: passed ? "passed" : "failed",
      duration_ms,
      exit_code: passed ? 0 : 1,
      output: text,
      error: passed ? "" : `HTTP ${resp.status}`,
      started_at: startedAt,
    };
  } catch (err) {
    return {
      id: stepId,
      name: stepName,
      status: "failed",
      duration_ms: Math.round(performance.now() - start),
      exit_code: 1,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      started_at: startedAt,
    };
  }
}
