/**
 * Check command — run GitHub Actions workflows locally via sealed SmolVM runners.
 *
 * The sealed runner model:
 *
 * 1. **Parse** — read the YAML, separate `uses:` steps (setup) from `run:` steps (execution)
 * 2. **Build** — create a VM from the base image, install baseline packages, exec resolved
 *    `uses:` install scripts, then seal it with `smolvm pack create --from-vm`
 * 3. **Cache** — hash the image + `uses:` refs + `with:` inputs as a cache key.
 *    If `~/.cb/runners/<key>.smolmachine` exists, skip the build.
 * 4. **Run** — boot from the sealed `.smolmachine`, exec each `run:` step as a Petri net transition
 * 5. **Report** — structured pass/fail per step with timing
 *
 * This is the agent hook entry point. Add to your CLAUDE.md:
 *
 *   Before completing work, run `cb check` and fix any failures.
 *
 * @module
 */

import type { Command } from "commander";
import chalk from "chalk";
import { resolve, basename, dirname } from "path";
import { existsSync, readdirSync, mkdirSync } from "fs";
import { parse as parseYAML } from "yaml";
import {
  fromGitHubActionsFile,
  validateWorkflow,
  resolveAction,
  BASELINE_INSTALL_STEPS,
  GITHUB_ACTIONS_SHIM,
  RUN_STEP_PREAMBLE,
  runnerCacheKey,
  runnerCachePath,
  RUNNER_CACHE_DIR,
  type Workflow,
  type GitHubActionsWorkflow,
  type ResolvedStep,
} from "@circuit-breaker/core";

// ============ Types ============

interface CheckOptions {
  workflow?: string;
  from?: string;
  json?: boolean;
  source?: string;
  shell?: boolean;
  rebuild?: boolean;
}

interface StepResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  duration_ms: number;
  exit_code: number;
  output: string;
  error: string;
}

interface CheckResult {
  workflow: string;
  image: string;
  runner_cache_key: string;
  status: "passed" | "failed";
  steps: StepResult[];
  duration_ms: number;
  failed_step?: string;
  runner_built: boolean;
}

/** A raw step from the GitHub Actions YAML. */
interface RawStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  if?: string;
  id?: string;
  shell?: string;
  "working-directory"?: string;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
}

/** A raw job from the GitHub Actions YAML. */
interface RawJob {
  "runs-on": string | string[];
  steps: RawStep[];
  needs?: string | string[];
  env?: Record<string, string>;
  name?: string;
  strategy?: {
    matrix?: Record<string, unknown>;
    "fail-fast"?: boolean;
  };
}

/** Top-level raw GitHub Actions YAML. */
interface RawWorkflow {
  name?: string;
  jobs: Record<string, RawJob>;
}

// ============ Constants ============

/** VM name for the builder (temporary, deleted after seal). */
const BUILDER_VM_PREFIX = "cb-build-";

/** VM name for the runner (created per check run). */
const RUNNER_VM = "cb-check";

// ============ Workflow Discovery ============

function discoverWorkflows(source: string): string[] {
  const workflowDir = resolve(source, ".github", "workflows");

  if (!existsSync(workflowDir)) {
    return [];
  }

  return readdirSync(workflowDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => resolve(workflowDir, f))
    .sort();
}

// ============ Step Separation ============

/**
 * Actions that don't need to be installed — they're handled by our
 * execution model (source is mounted, overlays handle caching).
 */
function isSkippableAction(uses: string): boolean {
  const action = uses.toLowerCase();
  if (action.startsWith("actions/checkout")) return true;
  if (action.startsWith("actions/cache")) return true;
  if (action.startsWith("actions/upload-artifact")) return true;
  if (action.startsWith("actions/download-artifact")) return true;
  return false;
}

/**
 * Separate a job's steps into setup (`uses:`) and execution (`run:`).
 *
 * - `uses:` steps that are skippable (checkout, cache) are excluded entirely
 * - `uses:` steps that need tools are collected for the build phase
 * - `run:` steps are collected for the execution phase
 */
function separateSteps(steps: RawStep[]): {
  usesSteps: {
    uses: string;
    with?: Record<string, unknown>;
    name?: string;
    env?: Record<string, string>;
  }[];
  runSteps: {
    id: string;
    command: string;
    env?: Record<string, string>;
    workdir?: string;
    shell?: string;
  }[];
} {
  const usesSteps: {
    uses: string;
    with?: Record<string, unknown>;
    name?: string;
    env?: Record<string, string>;
  }[] = [];
  const runSteps: {
    id: string;
    command: string;
    env?: Record<string, string>;
    workdir?: string;
    shell?: string;
  }[] = [];
  let stepIndex = 0;

  for (const step of steps) {
    if (step.uses) {
      if (!isSkippableAction(step.uses)) {
        usesSteps.push({
          uses: step.uses,
          with: step.with,
          name: step.name,
          env: step.env,
        });
      }
    } else if (step.run) {
      const id =
        step.id ?? (step.name ? slugify(step.name) : `step-${stepIndex}`);
      runSteps.push({
        id,
        command: step.run.trim(),
        env: step.env,
        workdir: step["working-directory"],
        shell: step.shell,
      });
      stepIndex++;
    }
  }

  return { usesSteps, runSteps };
}

// ============ OCI Image Resolution ============

function resolveRunsOnImage(runsOn: string | string[]): string {
  const label = Array.isArray(runsOn) ? runsOn[0] : runsOn;

  const imageMap: Record<string, string> = {
    "ubuntu-latest": "ubuntu:24.04",
    "ubuntu-24.04": "ubuntu:24.04",
    "ubuntu-22.04": "ubuntu:22.04",
    "ubuntu-20.04": "ubuntu:20.04",
  };

  return imageMap[label] ?? label;
}

// ============ SmolVM Subprocess Helpers ============

async function smolvm(
  args: string[],
  options?: { timeout?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["smolvm", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options?.timeout) {
    timer = setTimeout(() => {
      proc.kill();
    }, options.timeout);
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  if (timer) clearTimeout(timer);

  return { exitCode, stdout, stderr };
}

function hasSmolvmBinary(): boolean {
  try {
    const proc = Bun.spawnSync(["smolvm", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

// ============ Builder VM Lifecycle ============

async function createBuilderVM(
  vmName: string,
  image: string,
): Promise<boolean> {
  // Clean up any leftover builder VM with this name
  await smolvm(["machine", "stop", "--name", vmName]);
  await smolvm(["machine", "delete", vmName, "-f"]);

  const create = await smolvm([
    "machine",
    "create",
    "--image",
    image,
    "--net",
    vmName,
  ]);

  if (create.exitCode !== 0) {
    console.error(
      chalk.red(`  Failed to create builder VM: ${create.stderr.trim()}`),
    );
    return false;
  }

  const start = await smolvm(["machine", "start", "--name", vmName]);
  if (start.exitCode !== 0) {
    console.error(
      chalk.red(`  Failed to start builder VM: ${start.stderr.trim()}`),
    );
    return false;
  }

  return true;
}

async function execInBuilder(
  vmName: string,
  script: string,
  label?: string,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}> {
  const start = performance.now();

  if (label) {
    console.log(chalk.dim(`    ▶ ${label}`));
  }

  // Stream output live so the user can see what's happening during
  // long installs (apt-get, rustup, etc.) instead of staring at a
  // frozen terminal for minutes.
  const proc = Bun.spawn(
    ["smolvm", "machine", "exec", "--name", vmName, "--", "bash", "-c", script],
    { stdout: "pipe", stderr: "pipe" },
  );

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // 10 minute timeout for builder execs (baseline apt-get can take 3-5 min)
  const TIMEOUT_MS = 600_000;
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill();
  }, TIMEOUT_MS);

  // Stream stdout line by line, dimmed and indented
  const streamLines = async (
    stream: ReadableStream<Uint8Array>,
    chunks: string[],
    prefix: string,
  ) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      chunks.push(text);
      buffer += text;

      // Print complete lines as they arrive
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim().length > 0) {
          console.log(chalk.dim(`${prefix}${line}`));
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim().length > 0) {
      console.log(chalk.dim(`${prefix}${buffer}`));
    }
  };

  await Promise.all([
    streamLines(
      proc.stdout as ReadableStream<Uint8Array>,
      stdoutChunks,
      "      ",
    ),
    streamLines(
      proc.stderr as ReadableStream<Uint8Array>,
      stderrChunks,
      "      ",
    ),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const duration_ms = Math.round(performance.now() - start);
  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");

  if (label) {
    if (killed) {
      console.log(
        chalk.red(`    ✗ ${label} (timed out after ${TIMEOUT_MS / 1000}s)`),
      );
    } else if (exitCode === 0) {
      console.log(
        `    ${chalk.green("✓")} ${label} ${chalk.dim(`(${duration_ms}ms)`)}`,
      );
    } else {
      console.log(
        `    ${chalk.red("✗")} ${label} (exit code ${exitCode}) ${chalk.dim(`(${duration_ms}ms)`)}`,
      );
    }
  }

  return { exitCode, stdout, stderr, duration_ms };
}

async function sealBuilder(
  vmName: string,
  outputPath: string,
): Promise<boolean> {
  // smolvm pack create --from-vm requires the VM to be stopped first
  const stop = await smolvm(["machine", "stop", "--name", vmName]);
  if (stop.exitCode !== 0) {
    console.error(
      chalk.red(
        `    Failed to stop builder VM before seal: ${stop.stderr.trim()}`,
      ),
    );
    return false;
  }

  // Remove .smolmachine extension — smolvm pack create adds it
  const outputBase = outputPath.replace(/\.smolmachine$/, "");

  const result = await smolvm(
    ["pack", "create", "--from-vm", vmName, "-o", outputBase],
    { timeout: 300_000 },
  ); // 5 minute timeout — packing a full toolchain can be large

  if (result.exitCode !== 0) {
    const output = (result.stderr || result.stdout).trim();
    if (output) {
      console.error(chalk.red("    Seal error output:"));
      for (const line of output.split("\n").slice(-10)) {
        console.error(chalk.red(`      ${line}`));
      }
    } else {
      console.error(
        chalk.red(`    Seal exited with code ${result.exitCode} (no output)`),
      );
    }
  }

  return result.exitCode === 0;
}

async function destroyVM(vmName: string): Promise<void> {
  await smolvm(["machine", "stop", "--name", vmName]);
  await smolvm(["machine", "delete", vmName, "-f"]);
}

async function stopVM(vmName: string): Promise<void> {
  await smolvm(["machine", "stop", "--name", vmName]);
}

/**
 * Get the state of a VM from `smolvm machine ls --json`.
 *
 * Returns the machine's state string ("running", "stopped", etc.)
 * or null if the VM doesn't exist. This is reliable — unlike
 * `smolvm machine status` which returns exit 0 for non-existent VMs.
 */
async function getVmState(
  vmName: string,
): Promise<"running" | "stopped" | string | null> {
  const result = await smolvm(["machine", "ls", "--json"]);
  if (result.exitCode !== 0) return null;

  try {
    const machines = JSON.parse(result.stdout);
    const vm = machines.find((m: { name: string }) => m.name === vmName);
    return vm?.state ?? null;
  } catch {
    return null;
  }
}

// ============ Sealed Runner Build ============

/**
 * Build a sealed runner: install baseline packages + resolved `uses:` scripts,
 * then pack into a `.smolmachine`.
 */
async function buildSealedRunner(
  image: string,
  usesSteps: {
    uses: string;
    with?: Record<string, unknown>;
    name?: string;
    env?: Record<string, string>;
  }[],
  cacheKey: string,
  cachePath: string,
): Promise<boolean> {
  const builderVM = `${BUILDER_VM_PREFIX}${cacheKey.slice(0, 12)}`;

  console.log(chalk.bold("  Building sealed runner..."));
  console.log(chalk.dim(`    Base image: ${image}`));
  console.log(
    chalk.dim(`    Tools to install: ${usesSteps.length} uses: step(s)`),
  );

  // 1. Create builder VM
  const created = await createBuilderVM(builderVM, image);
  if (!created) return false;

  try {
    // 2. Install baseline packages (one exec per group to avoid pipe-buffering hangs)
    for (const step of BASELINE_INSTALL_STEPS) {
      const result = await execInBuilder(
        builderVM,
        step.script,
        `baseline: ${step.label}`,
      );
      if (result.exitCode !== 0) {
        console.error(
          chalk.red(`    Baseline install failed at: ${step.label}`),
        );
        const lines = (result.stderr || result.stdout)
          .trim()
          .split("\n")
          .slice(-5);
        for (const line of lines) {
          console.error(chalk.red(`      ${line}`));
        }
        return false;
      }
    }

    // 3. Set up GitHub Actions environment shim
    const shim = await execInBuilder(
      builderVM,
      GITHUB_ACTIONS_SHIM,
      "Setting up GitHub Actions environment",
    );
    if (shim.exitCode !== 0) {
      console.error(chalk.red("    Shim setup failed:"));
      const lines = (shim.stderr || shim.stdout).trim().split("\n").slice(-5);
      for (const line of lines) {
        console.error(chalk.red(`      ${line}`));
      }
      return false;
    }

    // 4. Resolve and execute each `uses:` step's install scripts
    for (const step of usesSteps) {
      const label = step.name ?? step.uses;

      const resolved = await resolveAction(step.uses, step.with);
      if (!resolved || resolved.length === 0) {
        console.log(chalk.dim(`    ⊘ ${label} (no install steps)`));
        continue;
      }

      // Combine all resolved scripts into a single bash invocation.
      // Prefix with _gh_source_env so each script sees env changes from prior steps.
      const combinedScript = [
        // Re-establish the shim functions (they don't persist across exec sessions)
        GITHUB_ACTIONS_SHIM,
        "",
        // Source env/path accumulated from prior steps
        "_gh_source_env",
        "",
        // Set step-level env vars
        ...(step.env
          ? Object.entries(step.env).map(
              ([k, v]) => `export ${k}=${shellQuote(v)}`,
            )
          : []),
        "",
        // The resolved install scripts
        ...resolved.map((r) => r.run),
      ].join("\n");

      const result = await execInBuilder(
        builderVM,
        combinedScript,
        `Installing ${label}`,
      );
      if (result.exitCode !== 0) {
        console.error(chalk.red(`    Install script for '${label}' failed:`));
        const lines = (result.stderr || result.stdout)
          .trim()
          .split("\n")
          .slice(-10);
        for (const line of lines) {
          console.error(chalk.red(`      ${line}`));
        }
        return false;
      }
    }

    // 5. Seal the builder VM into a .smolmachine
    console.log(chalk.dim("    Sealing runner..."));
    const sealStart = performance.now();

    // Ensure cache directory exists
    mkdirSync(RUNNER_CACHE_DIR, { recursive: true });

    const sealed = await sealBuilder(builderVM, cachePath);
    const sealDuration = Math.round(performance.now() - sealStart);

    if (!sealed) {
      console.error(chalk.red("    Failed to seal runner."));
      return false;
    }

    console.log(
      chalk.green(`    ✓ Runner sealed ${chalk.dim(`(${sealDuration}ms)`)}`),
    );
    console.log(chalk.dim(`    Cached at: ${cachePath}`));
    return true;
  } finally {
    // Always clean up the builder VM
    await destroyVM(builderVM);
  }
}

// ============ Run Steps in Sealed Runner ============

async function bootSealedRunner(
  cachePath: string,
  source: string,
): Promise<{ booted: boolean; reused: boolean }> {
  const absSource = resolve(source);
  const parentDir = dirname(absSource);

  // If the runner VM already exists, just start it.
  // The overlay disk preserves cargo target, node_modules, etc.
  const vmState = await getVmState(RUNNER_VM);

  if (vmState === "running") {
    return { booted: true, reused: true };
  }

  if (vmState === "stopped") {
    const start = await smolvm(["machine", "start", "--name", RUNNER_VM]);
    if (start.exitCode === 0) {
      return { booted: true, reused: true };
    }

    // Failed to start existing VM — delete and recreate
    console.log(
      chalk.dim("  Existing runner VM failed to start, recreating..."),
    );
    await destroyVM(RUNNER_VM);
  }

  // Create a fresh runner VM from the sealed .smolmachine.
  // Mount the parent directory so sibling path dependencies resolve.
  const create = await smolvm([
    "machine",
    "create",
    "--from",
    cachePath,
    "--net",
    "--volume",
    `${parentDir}:/projects`,
    RUNNER_VM,
  ]);

  if (create.exitCode !== 0) {
    console.error(
      chalk.red(`  Failed to create runner VM: ${create.stderr.trim()}`),
    );
    return { booted: false, reused: false };
  }

  const start = await smolvm(["machine", "start", "--name", RUNNER_VM]);
  if (start.exitCode !== 0) {
    console.error(
      chalk.red(`  Failed to start runner VM: ${start.stderr.trim()}`),
    );
    return { booted: false, reused: false };
  }

  return { booted: true, reused: false };
}

async function execRunStep(
  command: string,
  defaultWorkdir: string,
  env?: Record<string, string>,
  workdir?: string,
): Promise<{
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}> {
  const start = performance.now();

  // Build the full command:
  // 1. Source env/path from the build phase
  // 2. Set step-level env vars
  // 3. cd to workdir
  // 4. Run the command
  const parts: string[] = [RUN_STEP_PREAMBLE, ""];

  if (env) {
    for (const [key, value] of Object.entries(env)) {
      parts.push(`export ${key}=${shellQuote(value)}`);
    }
    parts.push("");
  }

  const wd = workdir ?? defaultWorkdir;
  parts.push(`cd ${wd}`);
  parts.push(command);

  const fullScript = parts.join("\n");

  // Stream output live so long-running compiles show progress instead
  // of appearing to hang for minutes with no output.
  const proc = Bun.spawn(
    [
      "smolvm",
      "machine",
      "exec",
      "--name",
      RUNNER_VM,
      "--",
      "bash",
      "-c",
      fullScript,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // 30 minute timeout — large projects (atomic) compile hundreds of crates
  const TIMEOUT_MS = 1_800_000;
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill();
  }, TIMEOUT_MS);

  const streamLines = async (
    stream: ReadableStream<Uint8Array>,
    chunks: string[],
    prefix: string,
  ) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      chunks.push(text);
      buffer += text;

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim().length > 0) {
          console.log(chalk.dim(`${prefix}${line}`));
        }
      }
    }

    if (buffer.trim().length > 0) {
      console.log(chalk.dim(`${prefix}${buffer}`));
    }
  };

  await Promise.all([
    streamLines(
      proc.stdout as ReadableStream<Uint8Array>,
      stdoutChunks,
      "    ",
    ),
    streamLines(
      proc.stderr as ReadableStream<Uint8Array>,
      stderrChunks,
      "    ",
    ),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const duration_ms = Math.round(performance.now() - start);

  if (killed) {
    console.log(chalk.red(`    (timed out after ${TIMEOUT_MS / 1000}s)`));
  }

  return {
    exit_code: killed ? 124 : exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    duration_ms,
  };
}

async function execLocally(
  command: string,
  source: string,
): Promise<{
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}> {
  const start = performance.now();

  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: source,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exit_code = await proc.exited;
  const duration_ms = Math.round(performance.now() - start);

  return { exit_code, stdout, stderr, duration_ms };
}

// ============ Helpers ============

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 63) || "step"
  );
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ============ Main Check Logic ============

export async function check(
  options: CheckOptions,
  _command: Command,
): Promise<void> {
  const source = resolve(options.source ?? ".");
  const startTime = performance.now();

  // Determine execution mode
  const useShell = options.shell === true;
  if (!useShell && !hasSmolvmBinary()) {
    console.error(chalk.red("✗ smolvm binary not found in PATH."));
    console.error(
      chalk.dim(
        "  Install smolvm (https://smolmachines.com) or use --shell for direct execution without VM isolation.",
      ),
    );
    process.exit(1);
  }

  // Discover or use specified workflow
  let workflowPaths: string[];

  if (options.workflow) {
    const specified = resolve(source, options.workflow);
    if (!existsSync(specified)) {
      if (existsSync(options.workflow)) {
        workflowPaths = [resolve(options.workflow)];
      } else {
        console.error(chalk.red(`✗ Workflow not found: ${options.workflow}`));
        process.exit(1);
      }
    } else {
      workflowPaths = [specified];
    }
  } else {
    workflowPaths = discoverWorkflows(source);
    if (workflowPaths.length === 0) {
      console.error(chalk.red("✗ No workflows found in .github/workflows/"));
      console.error(
        chalk.dim("  Create a .github/workflows/ci.yml to get started."),
      );
      process.exit(1);
    }
  }

  // Run each workflow
  const allResults: CheckResult[] = [];

  for (const wfPath of workflowPaths) {
    const wfName = basename(wfPath);
    console.log(chalk.bold(`▶ ${wfName}`));

    // ── Parse ──────────────────────────────────────────────────────

    // Parse with the full converter (for validation)
    let ghWorkflow: GitHubActionsWorkflow;
    try {
      ghWorkflow = await fromGitHubActionsFile(wfPath);
      const validation = validateWorkflow(ghWorkflow.workflow);
      if (!validation.valid) {
        console.error(chalk.red(`  ✗ Invalid workflow: ${wfName}`));
        for (const err of validation.errors) {
          console.error(chalk.red(`    ${err.message}`));
        }
        process.exit(1);
      }
    } catch (err) {
      console.error(
        chalk.red(
          `  ✗ Failed to parse ${wfName}: ${err instanceof Error ? err.message : err}`,
        ),
      );
      process.exit(1);
    }

    // Also read the raw YAML to separate uses: from run: steps
    const rawYaml = await Bun.file(wfPath).text();
    const raw: RawWorkflow = parseYAML(rawYaml);
    const jobEntries = Object.entries(raw.jobs);

    if (jobEntries.length === 0) {
      console.log(chalk.dim(`  ⊘ ${wfName} — no jobs, skipping`));
      continue;
    }

    // ── Collect all runnable jobs ────────────────────────────────────

    // Filter jobs: resolve runs-on, skip matrix non-ubuntu, separate steps.
    // All ubuntu-based jobs share the same sealed runner VM.
    const runnableJobs: {
      jobId: string;
      image: string;
      usesSteps: {
        uses: string;
        with?: Record<string, unknown>;
        name?: string;
        env?: Record<string, string>;
      }[];
      runSteps: {
        id: string;
        command: string;
        env?: Record<string, string>;
        workdir?: string;
        shell?: string;
      }[];
    }[] = [];

    for (const [jobId, job] of jobEntries) {
      const runsOn = job["runs-on"];
      const runsOnStr =
        typeof runsOn === "string"
          ? runsOn
          : Array.isArray(runsOn)
            ? runsOn[0]
            : String(runsOn);

      // Resolve matrix expressions to the ubuntu variant.
      // e.g., runs-on: ${{ matrix.os }} with matrix.os: [ubuntu-latest, macos-latest, windows-latest]
      // → resolve to "ubuntu-latest"
      let resolvedRunsOn = runsOnStr;

      if (runsOnStr.includes("${{") || runsOnStr.includes("matrix")) {
        // Extract the matrix variable name: "${{ matrix.os }}" → "os"
        const matrixVarMatch = runsOnStr.match(/\$\{\{\s*matrix\.(\w+)\s*\}\}/);
        const matrixVar = matrixVarMatch?.[1];
        const matrixValues = matrixVar
          ? job.strategy?.matrix?.[matrixVar]
          : undefined;

        if (Array.isArray(matrixValues)) {
          // Find the ubuntu variant in the matrix values
          const ubuntuVariant = matrixValues.find(
            (v: unknown) =>
              typeof v === "string" && v.toString().includes("ubuntu"),
          );

          if (ubuntuVariant) {
            resolvedRunsOn = String(ubuntuVariant);
            console.log(
              chalk.dim(
                `  ℹ ${jobId} — matrix job, using ${resolvedRunsOn} variant`,
              ),
            );
          } else {
            console.log(
              chalk.dim(
                `  ⊘ ${jobId} — matrix job with no ubuntu variant, skipping`,
              ),
            );
            continue;
          }
        } else {
          console.log(
            chalk.dim(
              `  ⊘ ${jobId} — unresolvable matrix expression, skipping`,
            ),
          );
          continue;
        }
      }

      const image = resolveRunsOnImage(resolvedRunsOn);

      // Skip non-ubuntu images (macos-latest, windows-latest, etc.)
      if (!image.startsWith("ubuntu")) {
        console.log(
          chalk.dim(`  ⊘ ${jobId} — ${resolvedRunsOn} (not ubuntu), skipping`),
        );
        continue;
      }

      const { usesSteps, runSteps } = separateSteps(job.steps);

      if (runSteps.length === 0) {
        console.log(chalk.dim(`  ⊘ ${jobId} — no run: steps, skipping`));
        continue;
      }

      // Prefix step IDs with job name to avoid collisions across jobs
      const prefixedRunSteps = runSteps.map((s) => ({
        ...s,
        id: `${jobId}/${s.id}`,
      }));

      runnableJobs.push({
        jobId,
        image,
        usesSteps,
        runSteps: prefixedRunSteps,
      });
    }

    if (runnableJobs.length === 0) {
      console.log(chalk.dim(`  ⊘ ${wfName} — no runnable jobs, skipping`));
      continue;
    }

    // Summary
    const totalRunSteps = runnableJobs.reduce(
      (n, j) => n + j.runSteps.length,
      0,
    );
    console.log(
      chalk.dim(`  Jobs: ${runnableJobs.map((j) => j.jobId).join(", ")}`),
    );
    console.log(
      chalk.dim(
        `  Run:  ${totalRunSteps} step(s) across ${runnableJobs.length} job(s)`,
      ),
    );

    // ── Shell mode (no VM) ─────────────────────────────────────────

    if (useShell) {
      const steps: StepResult[] = [];

      for (const job of runnableJobs) {
        console.log(chalk.bold(`  ▸ ${job.jobId}`));
        let skipRemaining = false;

        for (const cmd of job.runSteps) {
          if (skipRemaining) {
            steps.push({
              id: cmd.id,
              status: "skipped",
              duration_ms: 0,
              exit_code: 0,
              output: "",
              error: "",
            });
            console.log(chalk.dim(`    ⊘ ${cmd.id} (skipped)`));
            continue;
          }

          process.stdout.write(chalk.blue(`    ▶ ${cmd.id}...`));
          const result = await execLocally(cmd.command, source);
          const passed = result.exit_code === 0;

          steps.push({
            id: cmd.id,
            status: passed ? "passed" : "failed",
            duration_ms: result.duration_ms,
            exit_code: result.exit_code,
            output: result.stdout,
            error: result.stderr,
          });

          if (passed) {
            console.log(
              `\r    ${chalk.green("✓")} ${cmd.id} ${chalk.dim(`(${result.duration_ms}ms)`)}`,
            );
          } else {
            console.log(
              `\r    ${chalk.red("✗")} ${cmd.id} ${chalk.dim(`(${result.duration_ms}ms)`)}`,
            );
            const errorOutput = (result.stderr || result.stdout).trim();
            if (errorOutput) {
              for (const line of errorOutput.split("\n").slice(-10)) {
                console.log(chalk.red(`      ${line}`));
              }
            }
            skipRemaining = true;
          }
        }
      }

      const wfPassed = steps.every(
        (s) => s.status === "passed" || s.status === "skipped",
      );
      const failedStep = steps.find((s) => s.status === "failed");
      const totalDuration = Math.round(performance.now() - startTime);

      allResults.push({
        workflow: wfName,
        image: runnableJobs[0].image,
        runner_cache_key: "shell",
        status: wfPassed ? "passed" : "failed",
        steps,
        duration_ms: totalDuration,
        failed_step: failedStep?.id,
        runner_built: false,
      });

      if (wfPassed) {
        console.log(
          chalk.green(
            `  ✓ ${wfName} passed ${chalk.dim(`(${totalDuration}ms)`)}`,
          ),
        );
      } else {
        console.log(
          chalk.red(`  ✗ ${wfName} failed at step '${failedStep?.id}'`),
        );
      }
      console.log();
      continue;
    }

    // ── Sealed runner mode ─────────────────────────────────────────

    // Collect ALL uses: steps across all jobs for the sealed runner.
    // The runner gets every tool from every job baked in.
    //
    // Merge strategy: when the same action appears multiple times with
    // different `with:` inputs (e.g., dtolnay/rust-toolchain@stable used
    // by check with no components, fmt with components: rustfmt, and
    // clippy with components: clippy), we merge the inputs into a single
    // invocation. Comma-separated values (like components, targets) get
    // unioned. Other values use last-writer-wins.
    const allUsesSteps = runnableJobs.flatMap((j) => j.usesSteps);

    const mergedUsesMap = new Map<
      string,
      {
        uses: string;
        with?: Record<string, unknown>;
        name?: string;
        env?: Record<string, string>;
      }
    >();

    for (const step of allUsesSteps) {
      const existing = mergedUsesMap.get(step.uses);
      if (!existing) {
        // First occurrence — clone it
        mergedUsesMap.set(step.uses, {
          uses: step.uses,
          with: step.with ? { ...step.with } : undefined,
          name: step.name,
          env: step.env ? { ...step.env } : undefined,
        });
      } else {
        // Merge with: inputs into the existing entry
        if (step.with) {
          if (!existing.with) existing.with = {};
          for (const [key, value] of Object.entries(step.with)) {
            const prev = existing.with[key];
            if (prev === undefined || prev === "") {
              // New key or empty previous — take the new value
              existing.with[key] = value;
            } else if (
              typeof prev === "string" &&
              typeof value === "string" &&
              value !== ""
            ) {
              // Both are non-empty strings — union comma-separated values.
              // This handles `components: "rustfmt"` + `components: "clippy"`
              // → `components: "rustfmt,clippy"`
              const prevSet = new Set(
                prev
                  .split(",")
                  .map((s: string) => s.trim())
                  .filter(Boolean),
              );
              const newSet = value
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean);
              for (const v of newSet) {
                prevSet.add(v);
              }
              existing.with[key] = [...prevSet].join(",");
            }
            // For non-string values, last-writer-wins (first value kept)
          }
        }
        // Merge env
        if (step.env) {
          if (!existing.env) existing.env = {};
          Object.assign(existing.env, step.env);
        }
      }
    }

    const dedupedUses = [...mergedUsesMap.values()];

    const image = runnableJobs[0].image;
    const usesForCache = dedupedUses.map((s) => ({
      uses: s.uses,
      with: s.with,
    }));
    const cacheKey = runnerCacheKey(image, usesForCache);
    const cachePath = runnerCachePath(cacheKey);
    let runnerBuilt = false;

    console.log(chalk.dim(`  Runner cache key: ${cacheKey.slice(0, 16)}...`));

    // Build sealed runner if not cached (or --rebuild)
    if (options.rebuild || !existsSync(cachePath)) {
      if (options.rebuild && existsSync(cachePath)) {
        console.log(chalk.dim("  --rebuild: ignoring cached runner"));
      } else if (dedupedUses.length === 0) {
        console.log(chalk.dim("  No uses: steps — building baseline runner"));
      } else {
        console.log(chalk.dim("  Cache miss — building sealed runner"));
      }

      const built = await buildSealedRunner(
        image,
        dedupedUses,
        cacheKey,
        cachePath,
      );
      if (!built) {
        console.error(chalk.red("  ✗ Failed to build sealed runner."));
        process.exit(1);
      }
      runnerBuilt = true;
    } else {
      console.log(chalk.green("  ✓ Using cached runner"));
    }

    // Boot the sealed runner with source mounted (or reuse existing)
    console.log(chalk.dim("  Booting sealed runner..."));
    const bootStart = performance.now();
    const { booted, reused } = await bootSealedRunner(cachePath, source);
    const bootDuration = Math.round(performance.now() - bootStart);

    if (!booted) {
      console.error(chalk.red("  ✗ Failed to boot sealed runner."));
      process.exit(1);
    }
    // Compute the working directory inside the VM.
    // We mount the parent dir at /projects, so the project is at /projects/<dirname>.
    const absSource = resolve(source);
    const projectName = basename(absSource);
    const projectWorkdir = `/projects/${projectName}`;

    console.log(
      chalk.green(
        `  ✓ Runner ${reused ? "reused" : "ready"} ${chalk.dim(`(${bootDuration}ms)`)}`,
      ),
    );
    console.log(chalk.dim(`  Working directory: ${projectWorkdir}`));
    console.log();

    // Execute run: steps for all jobs sequentially, sharing the same VM
    const steps: StepResult[] = [];
    let workflowFailed = false;

    try {
      for (const job of runnableJobs) {
        console.log(chalk.bold(`  ▸ ${job.jobId}`));
        let skipRemaining = false;
        let fromReached = !options.from;

        for (const cmd of job.runSteps) {
          // Handle --from: skip until we reach the specified step
          if (!fromReached) {
            if (cmd.id === options.from) {
              fromReached = true;
            } else {
              steps.push({
                id: cmd.id,
                status: "skipped",
                duration_ms: 0,
                exit_code: 0,
                output: "",
                error: "",
              });
              console.log(
                chalk.dim(`    ⊘ ${cmd.id} (skipped — before --from)`),
              );
              continue;
            }
          }

          if (skipRemaining) {
            steps.push({
              id: cmd.id,
              status: "skipped",
              duration_ms: 0,
              exit_code: 0,
              output: "",
              error: "",
            });
            console.log(chalk.dim(`    ⊘ ${cmd.id} (skipped)`));
            continue;
          }

          // Execute the step
          process.stdout.write(chalk.blue(`    ▶ ${cmd.id}...`));

          const result = await execRunStep(
            cmd.command,
            projectWorkdir,
            cmd.env,
            cmd.workdir,
          );
          const passed = result.exit_code === 0;

          steps.push({
            id: cmd.id,
            status: passed ? "passed" : "failed",
            duration_ms: result.duration_ms,
            exit_code: result.exit_code,
            output: result.stdout,
            error: result.stderr,
          });

          if (passed) {
            console.log(
              `\r    ${chalk.green("✓")} ${cmd.id} ${chalk.dim(`(${result.duration_ms}ms)`)}`,
            );
          } else {
            console.log(
              `\r    ${chalk.red("✗")} ${cmd.id} ${chalk.dim(`(${result.duration_ms}ms)`)}`,
            );

            // Show last 10 lines of error output
            const errorOutput = (result.stderr || result.stdout).trim();
            if (errorOutput) {
              const lines = errorOutput.split("\n").slice(-10);
              for (const line of lines) {
                console.log(chalk.red(`      ${line}`));
              }
            }

            skipRemaining = true;
            workflowFailed = true;
          }
        }
      }
    } finally {
      // Stop the VM but keep it — overlay preserves build artifacts
      // (cargo target, node_modules, etc.) for the next run.
      await stopVM(RUNNER_VM);
    }

    if (!workflowFailed && options.from) {
      // Check if --from matched anything
      const allStepIds = runnableJobs.flatMap((j) =>
        j.runSteps.map((s) => s.id),
      );
      if (!allStepIds.includes(options.from ?? "")) {
        console.error(
          chalk.red(`\n✗ Step '${options.from}' not found in ${wfName}`),
        );
        console.error(chalk.dim(`  Available steps: ${allStepIds.join(", ")}`));
        process.exit(1);
      }
    }

    const wfPassed = steps.every(
      (s) => s.status === "passed" || s.status === "skipped",
    );
    const failedStep = steps.find((s) => s.status === "failed");
    const totalDuration = Math.round(performance.now() - startTime);

    const checkResult: CheckResult = {
      workflow: wfName,
      image,
      runner_cache_key: cacheKey,
      status: wfPassed ? "passed" : "failed",
      steps,
      duration_ms: totalDuration,
      failed_step: failedStep?.id,
      runner_built: runnerBuilt,
    };
    allResults.push(checkResult);

    if (wfPassed) {
      console.log(
        chalk.green(
          `  ✓ ${wfName} passed ${chalk.dim(`(${totalDuration}ms)`)}`,
        ),
      );
    } else {
      console.log(
        chalk.red(
          `  ✗ ${wfName} failed at step '${failedStep?.id}' ${chalk.dim(`(${totalDuration}ms)`)}`,
        ),
      );
      if (!options.from) {
        console.log(
          chalk.dim(
            `  Retry from the failed step: cb check --from ${failedStep?.id}`,
          ),
        );
      }
    }

    console.log();
  }

  // ── Summary ────────────────────────────────────────────────────

  if (options.json) {
    console.log(JSON.stringify(allResults, null, 2));
  }

  const allPassed = allResults.every((r) => r.status === "passed");
  const totalDuration = Math.round(performance.now() - startTime);

  if (!options.json) {
    console.log(chalk.dim("─".repeat(50)));
    if (allPassed) {
      console.log(
        chalk.green(`✓ All checks passed ${chalk.dim(`(${totalDuration}ms)`)}`),
      );
    } else {
      const failed = allResults.filter((r) => r.status === "failed");
      console.log(
        chalk.red(
          `✗ ${failed.length} of ${allResults.length} workflow(s) failed`,
        ),
      );
    }
  }

  if (!allPassed) {
    process.exit(1);
  }
}

// ============ Command Registration ============

/**
 * Register the check command on a Commander program.
 */
export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description(
      "Run GitHub Actions workflows locally via sealed SmolVM runners",
    )
    .option(
      "-w, --workflow <path>",
      "Path to a specific workflow file (default: auto-discover)",
    )
    .option(
      "--from <step>",
      "Skip run: steps before this one (retry from a specific step)",
    )
    .option("--json", "Output structured JSON results")
    .option(
      "--shell",
      "Run directly in host shell instead of SmolVM (no isolation)",
    )
    .option(
      "-s, --source <path>",
      "Source directory (default: current directory)",
      ".",
    )
    .option("--rebuild", "Force rebuild the sealed runner (ignore cache)")
    .action(check);
}

export default check;
