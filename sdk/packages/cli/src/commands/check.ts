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
import { resolve, basename, dirname, join } from "path";
import { existsSync, readdirSync, mkdirSync, readFileSync } from "fs";
import { parse as parseYAML } from "yaml";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  fromGitHubActionsFile,
  validateWorkflow,
  WorkflowSchema,
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
import { hashFile, hashString, hashDirectory, hashConcat, canonicalJSON } from "../lib/hashing";
import { openOrCreateGraph, findGraphPath, type RunPayload, type TransitionPayload, type RunStatus } from "../lib/graph";
import { signWithMachineKey, getMachinePubkeyBase64, machineKeyExists, generateMachineKey } from "../lib/signing";
import { runCircuit } from "../lib/local-runner";
import { verifySeal } from "./seal";
import { loadConfig } from "../lib/config";
import { s } from "../lib/symbols";

// ============ Types ============

interface CheckOptions {
  workflow?: string;
  circuit?: string;        // specific native circuit path
  from?: string;
  json?: boolean;
  source?: string;
  shell?: boolean;
  rebuild?: boolean;
  githubActions?: boolean; // force GitHub Actions bridge mode
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
    console.log(chalk.dim(`    ${s.play} ${label}`));
  }

  // Stream output live so the user can see what's happening during
  // long installs (apt-get, rustup, etc.) instead of staring at a
  // frozen terminal for minutes.
  const proc = Bun.spawn(
    ["smolvm", "machine", "exec", "--name", vmName, "--stream", "--", "bash", "-c", script],
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
        chalk.red(`    ${s.cross} ${label} (timed out after ${TIMEOUT_MS / 1000}s)`),
      );
    } else if (exitCode === 0) {
      console.log(
        `    ${chalk.green(s.check)} ${label} ${chalk.dim(`(${fmtDuration(duration_ms)})`)}`,
      );
    } else {
      console.log(
        `    ${chalk.red(s.cross)} ${label} (exit code ${exitCode}) ${chalk.dim(`(${fmtDuration(duration_ms)})`)}`,
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
        console.log(chalk.dim(`    ${s.skip} ${label} (no install steps)`));
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
      chalk.green(`    ${s.check} Runner sealed ${chalk.dim(`(${fmtDuration(sealDuration)})`)}`),
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
      "--stream",
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

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

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

// ============ Circuit File Loader ============

/** Spawn a subprocess rooted at cbRoot to load a circuit file as a Workflow object.
 *  Running via subprocess ensures `@circuit-breaker/core` resolves from the
 *  project's own node_modules, not the circuit file's directory. */
async function loadCircuitWorkflow(circuitPath: string, cbRoot: string): Promise<Workflow> {
  const { fileURLToPath } = await import("node:url");
  const { existsSync: _exists } = await import("node:fs");
  const thisFile = fileURLToPath(import.meta.url);
  // When running from source (src/commands/check.ts), go up two dirs to reach src/lib/.
  // When running from built dist (dist/index.js), go up one dir to reach dist/lib/.
  // Try .js first (built), then .ts (source/dev).
  const candidates = [
    resolve(thisFile, "../lib/circuit-loader.js"),     // dist/lib/
    resolve(thisFile, "../../lib/circuit-loader.ts"),  // src/lib/
    resolve(thisFile, "../../lib/circuit-loader.js"),  // src/lib/ (built)
  ];
  const loaderPath = candidates.find(_exists) ?? candidates[0]!;

  // Add the CLI's own node_modules to NODE_PATH so @circuit-breaker/core
  // resolves even when the circuit lives in a project that doesn't have it installed.
  const cliNodeModules = resolve(thisFile, "../../node_modules");
  const existingNodePath = process.env.NODE_PATH ?? "";
  const nodePath = existingNodePath ? `${cliNodeModules}:${existingNodePath}` : cliNodeModules;

  const proc = Bun.spawn(["bun", loaderPath, circuitPath], {
    cwd: cbRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_PATH: nodePath },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;

  if (exit !== 0) {
    throw new Error(stderr.trim() || "Failed to load circuit");
  }

  return WorkflowSchema.parse(JSON.parse(stdout));
}

// ============ Inner Loop — Native Circuits ============

const CB_VERSION = "0.1.0";

/** Walk up from source to find the .cb/ root. */
function findCbRoot(source: string): string | null {
  let current = resolve(source);
  while (true) {
    if (existsSync(join(current, ".cb"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Compute a stable hash of the working directory state for run attestation. */
function computeInputHash(source: string): string {
  try {
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (head.status === 0) {
      const headHash = head.stdout.trim();
      const dirty = spawnSync("git", ["status", "--porcelain"], {
        cwd: source,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const dirtyContent = dirty.stdout?.trim() ?? "";
      if (!dirtyContent) return hashString("git:" + headHash);
      return hashString("git:" + headHash + ":dirty:" + hashString(dirtyContent));
    }
  } catch { /* not a git repo */ }
  return hashDirectory(source, [".cb", "node_modules", ".git", "target", "dist"]);
}

/** Get VCS change hashes (recent commits) for the change_hashes field. */
function getChangeHashes(source: string): string[] {
  try {
    const result = spawnSync(
      "git",
      ["log", "--format=%H", "-10"],
      { cwd: source, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (result.status === 0) {
      return result.stdout.trim().split("\n").filter(Boolean);
    }
  } catch { /* ignore */ }
  return [];
}

/** Find circuit files in .cb/circuits/. */
function discoverNativeCircuits(cbRoot: string): string[] {
  const dir = join(cbRoot, ".cb", "circuits");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".json"))
    .map((f) => join(dir, f))
    .sort();
}

/** Find the seal directory for a circuit file. Returns prefix or null. */
function findSealForCircuit(cbRoot: string, circuitPath: string): string | null {
  const circuitHash = hashFile(circuitPath);
  const sealsDir = join(cbRoot, ".cb", "seals");
  if (!existsSync(sealsDir)) return null;

  for (const prefix of readdirSync(sealsDir)) {
    const manifestPath = join(sealsDir, prefix, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (m.circuit_hash === circuitHash) return prefix;
    } catch { /* skip */ }
  }
  return null;
}

/** Write a completed run + its steps into the local graph. */
async function writeRunToGraph(params: {
  cbRoot: string;
  sealId: string;
  sealNodeId: string;
  source: string;
  startedAt: Date;
  finishedAt: Date;
  status: RunStatus;
  steps: StepResult[];
}): Promise<string> {
  if (!machineKeyExists()) return ""; // can't sign without machine key

  const { cbRoot, sealId, sealNodeId, source, startedAt, finishedAt, status, steps } = params;
  const graph = openOrCreateGraph(cbRoot);

  // Build per-step log chunks + transition nodes
  const logChunks: string[] = [];
  const transitions: TransitionPayload[] = [];
  let runLogHash = hashString("empty");

  for (const step of steps) {
    const combinedLog = step.output + (step.error ? "\n--- stderr ---\n" + step.error : "");
    const chunkHash = graph.addLogChunk(Buffer.from(combinedLog, "utf-8"));
    logChunks.push(chunkHash);

    transitions.push({
      run_id: "", // filled after run node created
      name: step.id,
      status: step.status === "passed" ? "Passed" : step.status === "failed" ? "Failed" : "Skipped",
      started_at: step.started_at ?? startedAt.toISOString(),
      duration_ms: step.duration_ms,
      exit_code: step.exit_code,
      log_hash: chunkHash,
    });
  }

  // Combine all log chunks into run-level log hash
  if (logChunks.length > 0) {
    runLogHash = hashString(logChunks.join(","));
  }

  const inputHash = computeInputHash(source);
  const changeHashes = getChangeHashes(source);
  const cbPubkey = getMachinePubkeyBase64();

  // Fields to sign (everything except signature and merkle_at_record)
  const toSign = {
    cb_pubkey: cbPubkey,
    cb_version: CB_VERSION,
    change_hashes: changeHashes,
    finished_at: finishedAt.toISOString(),
    input_hash: inputHash,
    log_hash: runLogHash,
    seal_id: sealId,
    started_at: startedAt.toISOString(),
    status,
  };
  const signData = Buffer.from(canonicalJSON(toSign), "utf-8");
  const { signature } = signWithMachineKey(signData);

  const runPayload: Omit<RunPayload, "merkle_at_record"> = {
    ...toSign,
    signature,
  };

  const { nodeId: runNodeId } = graph.addRun(sealNodeId, runPayload);

  // Link log chunks to run
  for (const chunk of logChunks) graph.linkLog(runNodeId, chunk, "log");

  // Add transition nodes
  for (const t of transitions) {
    graph.addTransition(runNodeId, { ...t, run_id: runNodeId });
  }

  graph.close();
  return runNodeId;
}

/** Ensure a synthetic seal node exists for GitHub Actions workflows (GH Actions bridge). */
function ensureSyntheticSeal(
  cbRoot: string,
  workflowName: string,
  cacheKey: string,
): { sealNodeId: string; sealId: string } {
  const graph = openOrCreateGraph(cbRoot);
  const circuitHash = hashString("github-actions:" + workflowName);
  const runnerHash = hashString("runner:" + cacheKey);
  const sealHash = hashConcat(circuitHash, runnerHash);
  const prefix = sealHash.slice(0, 12);
  const sealId = `cb/${workflowName.replace(/\.ya?ml$/, "")}:${prefix}`;

  // Check if already exists
  const existing = graph.getSealByHash(sealHash);
  if (existing) {
    graph.close();
    return { sealNodeId: existing.nodeId, sealId };
  }

  const nodeId = graph.addSeal({
    circuit_hash: circuitHash,
    runner_hash: runnerHash,
    seal_hash: sealHash,
    cb_version: CB_VERSION,
    sealed_at: new Date().toISOString(),
    seal_pubkey: "",
    signature: "",
    alg: "none",
    circuit_name: workflowName,
    circuit_path: "",
  });

  graph.close();
  return { sealNodeId: nodeId, sealId };
}

/** Run all native circuits in .cb/circuits/ (or a specific one). */
async function checkNativeCircuits(
  options: CheckOptions,
  source: string,
): Promise<CheckResult[] | null> {
  const cbRoot = findCbRoot(source);
  if (!cbRoot) return null;

  let circuitPaths: string[];
  if (options.circuit) {
    const p = resolve(source, options.circuit);
    if (!existsSync(p)) {
      console.error(chalk.red(`${s.cross} Circuit not found: ${options.circuit}`));
      process.exit(1);
    }
    circuitPaths = [p];
  } else {
    circuitPaths = discoverNativeCircuits(cbRoot);
  }

  if (circuitPaths.length === 0) return null;

  // Auto-generate machine identity key on first run so graph writes work
  if (!machineKeyExists()) {
    try {
      generateMachineKey();
    } catch { /* non-fatal — graph writes will be skipped */ }
  }

  // Boot smolvm for native circuit execution if available
  let smolvmMachine: string | undefined;
  let smolvmWorkdir: string | undefined;
  if (hasSmolvmBinary()) {
    const vmState = await getVmState(RUNNER_VM);
    let vmRunning = vmState === "running";
    if (vmState === "stopped") {
      const startResult = await smolvm(["machine", "start", "--name", RUNNER_VM]);
      vmRunning = startResult.exitCode === 0;
    }
    if (vmRunning) {
      // Bootstrap Rust/rustup if not already installed — matches default GitHub Actions ubuntu runner environment
      const rustCheck = await smolvm([
        "machine", "exec", "--name", RUNNER_VM, "--",
        "bash", "-c",
        '[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" && rustup --version >/dev/null 2>&1',
      ]);
      if (rustCheck.exitCode !== 0) {
        console.log(chalk.dim("  Bootstrapping Rust toolchain in runner VM..."));
        await smolvm([
          "machine", "exec", "--name", RUNNER_VM, "--",
          "bash", "-c",
          "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal",
        ], { timeout: 120_000 });
      }
      // Install gh CLI if not present (needed for release workflows)
      const ghCheck = await smolvm(["machine", "exec", "--name", RUNNER_VM, "--", "bash", "-c", "command -v gh"]);
      if (ghCheck.exitCode !== 0) {
        console.log(chalk.dim("  Bootstrapping gh CLI in runner VM..."));
        const ghInstall = "GH_VER=$(curl -s https://api.github.com/repos/cli/cli/releases/latest | grep '\"tag_name\"' | sed 's/.*\"v\\([^\"]*\\)\".*/\\1/' 2>/dev/null || echo '2.68.0'); curl -sL \"https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_linux_arm64.tar.gz\" | tar xz -C /tmp/ && cp /tmp/gh_*/bin/gh /usr/local/bin/gh";
        await smolvm(["machine", "exec", "--name", RUNNER_VM, "--", "bash", "-c", ghInstall], { timeout: 60_000 });
      }
      smolvmMachine = RUNNER_VM;
      smolvmWorkdir = `/projects/${basename(resolve(source))}`;
      // Stop the VM on any exit (clean or error) so RAM is freed
      process.on("exit", () => {
        Bun.spawnSync(["smolvm", "machine", "stop", "--name", RUNNER_VM]);
      });
    }
  }

  const config = loadConfig();
  const allResults: CheckResult[] = [];
  const startTime = performance.now();

  for (const circuitPath of circuitPaths) {
    const circuitName = basename(circuitPath);
    console.log(chalk.bold(`${s.play} ${circuitName}`));

    // ── Seal verification ──────────────────────────────────────────────
    const sealPrefix = findSealForCircuit(cbRoot, circuitPath);
    if (!sealPrefix) {
      console.error(
        chalk.red(`  ${s.cross} No seal found for ${circuitName}`),
      );
      console.error(
        chalk.dim(`  Run \`cb seal ${circuitPath}\` to create a seal, then commit .cb/seals/`),
      );
      process.exit(1);
    }

    const sealDir = join(cbRoot, ".cb", "seals", sealPrefix);
    const sealVerification = verifySeal(sealDir, circuitPath);
    if (!sealVerification.valid) {
      console.error(chalk.red(`  ${s.cross} Seal invalid: ${sealVerification.reason}`));
      console.error(
        chalk.dim(`  Run \`cb seal ${circuitPath}\` to re-seal, then commit .cb/seals/`),
      );
      process.exit(1);
    }

    // Warn if seal not committed
    const gitCheck = spawnSync("git", ["status", "--porcelain", sealDir], {
      encoding: "utf-8",
      cwd: cbRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (gitCheck.status === 0 && gitCheck.stdout?.trim()) {
      console.log(
        chalk.yellow(`  ${s.warn}  Seal uncommitted - commit .cb/seals/ to activate for policy gates`),
      );
    }

    // Load the workflow by running the circuit file in a subprocess rooted at
    // cbRoot so that module resolution finds node_modules from the project.
    let workflow: Workflow;
    try {
      workflow = await loadCircuitWorkflow(circuitPath, cbRoot);
    } catch (err) {
      console.error(
        chalk.red(`  ${s.cross} Failed to load circuit: ${err instanceof Error ? err.message : err}`),
      );
      process.exit(1);
    }

    console.log(chalk.dim(`  Seal: cb/${basename(circuitPath).split(".")[0]}:${sealPrefix}`));

    // ── Execute ────────────────────────────────────────────────────────
    const stepStartedAt = new Date();
    const runStart = performance.now();

    const runResult = await runCircuit(workflow, source, {
      fromStep: options.from,
      smolvmMachine,
      smolvmWorkdir,
      onStepStart: (id) => {
        process.stdout.write(chalk.blue(`  ${s.play} ${id}...\n`));
      },
      onOutput: (line) => {
        if (line.trim()) console.log(chalk.dim(`    ${line}`));
      },
      onStepEnd: (result) => {
        if (result.status === "passed") {
          console.log(`  ${chalk.green(s.check)} ${result.id} ${chalk.dim(`(${result.duration_ms}ms)`)}`);
        } else if (result.status === "failed") {
          console.log(`  ${chalk.red(s.cross)} ${result.id} ${chalk.dim(`(${result.duration_ms}ms)`)}`);
        } else {
          console.log(`  ${chalk.dim(s.skip)} ${result.id} (skipped)`);
        }
      },
    });

    const finishedAt = new Date();
    const totalDuration = Math.round(performance.now() - runStart);

    // ── Graph write-back ───────────────────────────────────────────────
    const manifestPath = join(sealDir, "manifest.json");
    let sealNodeId = "";
    let sealId = `cb/${basename(circuitPath).split(".")[0]}:${sealPrefix}`;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const graph = openOrCreateGraph(cbRoot);
      const existing = graph.getSealByHash(manifest.seal_hash);
      sealNodeId = existing?.nodeId ?? graph.addSeal(manifest);
      graph.close();
      sealId = `cb/${manifest.circuit_name}:${sealPrefix}`;
    } catch { /* best-effort */ }

    if (sealNodeId) {
      try {
        await writeRunToGraph({
          cbRoot,
          sealId,
          sealNodeId,
          source,
          startedAt: stepStartedAt,
          finishedAt,
          status: runResult.status === "passed" ? "Passed" : "Failed",
          steps: runResult.steps.map((s) => ({
            id: s.id,
            status: s.status,
            duration_ms: s.duration_ms,
            exit_code: s.exit_code,
            output: s.output,
            error: s.error,
            started_at: s.started_at,
          })),
        });
      } catch { /* best-effort — don't fail the run for graph errors */ }
    }

    const checkResult: CheckResult = {
      workflow: circuitName,
      image: "local",
      runner_cache_key: sealPrefix,
      status: runResult.status,
      steps: runResult.steps.map((s) => ({
        id: s.id,
        status: s.status,
        duration_ms: s.duration_ms,
        exit_code: s.exit_code ?? 0,
        output: s.output,
        error: s.error,
      })),
      duration_ms: totalDuration,
      failed_step: runResult.failed_step,
      runner_built: false,
    };

    allResults.push(checkResult);

    if (runResult.status === "passed") {
      console.log(chalk.green(`  ${s.check} ${circuitName} passed ${chalk.dim(`(${fmtDuration(totalDuration)})`)}`));
    } else {
      console.log(chalk.red(`  ${s.cross} ${circuitName} failed at '${runResult.failed_step}'`));
      if (!options.from) {
        console.log(chalk.dim(`  Retry from failed step: cb check -c ${circuitPath} --from ${runResult.failed_step}`));
      }
    }
    console.log();
  }

  if (smolvmMachine) await stopVM(smolvmMachine);

  return allResults;
}

// ============ Main Check Logic ============

export async function check(
  options: CheckOptions,
  _command: Command,
): Promise<void> {
  const source = resolve(options.source ?? ".");
  const startTime = performance.now();

  // ── Native circuit path (primary) ─────────────────────────────────────────
  if (!options.githubActions) {
    const nativeResults = await checkNativeCircuits(options, source);
    if (nativeResults !== null) {
      if (options.json) console.log(JSON.stringify(nativeResults, null, 2));
      const allPassed = nativeResults.every((r) => r.status === "passed");
      const totalDuration = Math.round(performance.now() - startTime);
      if (!options.json) {
        console.log(chalk.dim("-".repeat(50)));
        if (allPassed) {
          console.log(chalk.green(`${s.check} All checks passed ${chalk.dim(`(${fmtDuration(totalDuration)})`)}`));
        } else {
          const failed = nativeResults.filter((r) => r.status === "failed");
          console.log(chalk.red(`${s.cross} ${failed.length} of ${nativeResults.length} circuit(s) failed`));
        }
      }
      if (!allPassed) process.exit(1);
      return;
    }
    // No native circuits found — fall through to GitHub Actions bridge
  }

  // ── GitHub Actions bridge (legacy / explicit) ─────────────────────────────
  // Determine execution mode
  const useShell = options.shell === true;
  if (!useShell && !hasSmolvmBinary()) {
    console.error(chalk.red(`${s.cross} smolvm binary not found in PATH.`));
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
        console.error(chalk.red(`${s.cross} Workflow not found: ${options.workflow}`));
        process.exit(1);
      }
    } else {
      workflowPaths = [specified];
    }
  } else {
    workflowPaths = discoverWorkflows(source);
    if (workflowPaths.length === 0) {
      console.error(chalk.red(`${s.cross} No workflows found in .github/workflows/`));
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
    console.log(chalk.bold(`${s.play} ${wfName}`));

    // ── Parse ──────────────────────────────────────────────────────

    // Parse with the full converter (for validation)
    let ghWorkflow: GitHubActionsWorkflow;
    try {
      ghWorkflow = await fromGitHubActionsFile(wfPath);
      const validation = validateWorkflow(ghWorkflow.workflow);
      if (!validation.valid) {
        console.error(chalk.red(`  ${s.cross} Invalid workflow: ${wfName}`));
        for (const err of validation.errors) {
          console.error(chalk.red(`    ${err.message}`));
        }
        process.exit(1);
      }
    } catch (err) {
      console.error(
        chalk.red(
          `  ${s.cross} Failed to parse ${wfName}: ${err instanceof Error ? err.message : err}`,
        ),
      );
      process.exit(1);
    }

    // Also read the raw YAML to separate uses: from run: steps
    const rawYaml = await Bun.file(wfPath).text();
    const raw: RawWorkflow = parseYAML(rawYaml);
    const jobEntries = Object.entries(raw.jobs);

    if (jobEntries.length === 0) {
      console.log(chalk.dim(`  ${s.skip} ${wfName} - no jobs, skipping`));
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
                `  ${s.skip} ${jobId} — matrix job with no ubuntu variant, skipping`,
              ),
            );
            continue;
          }
        } else {
          console.log(
            chalk.dim(
              `  ${s.skip} ${jobId} — unresolvable matrix expression, skipping`,
            ),
          );
          continue;
        }
      }

      const image = resolveRunsOnImage(resolvedRunsOn);

      // Skip non-ubuntu images (macos-latest, windows-latest, etc.)
      if (!image.startsWith("ubuntu")) {
        console.log(
          chalk.dim(`  ${s.skip} ${jobId} - ${resolvedRunsOn} (not ubuntu), skipping`),
        );
        continue;
      }

      const { usesSteps, runSteps } = separateSteps(job.steps);

      if (runSteps.length === 0) {
        console.log(chalk.dim(`  ${s.skip} ${jobId} - no run: steps, skipping`));
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
      console.log(chalk.dim(`  ${s.skip} ${wfName} - no runnable jobs, skipping`));
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
            console.log(chalk.dim(`    ${s.skip} ${cmd.id} (skipped)`));
            continue;
          }

          process.stdout.write(chalk.blue(`    ${s.play} ${cmd.id}...`));
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
              `\r    ${chalk.green(s.check)} ${cmd.id} ${chalk.dim(`(${result.duration_ms}ms)`)}`,
            );
          } else {
            console.log(
              `\r    ${chalk.red(s.cross)} ${cmd.id} ${chalk.dim(`(${result.duration_ms}ms)`)}`,
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
            `  ${s.check} ${wfName} passed ${chalk.dim(`(${fmtDuration(totalDuration)})`)}`,
          ),
        );
      } else {
        console.log(
          chalk.red(`  ${s.cross} ${wfName} failed at step '${failedStep?.id}'`),
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
        console.log(chalk.dim("  No uses: steps - building baseline runner"));
      } else {
        console.log(chalk.dim("  Cache miss - building sealed runner"));
      }

      const built = await buildSealedRunner(
        image,
        dedupedUses,
        cacheKey,
        cachePath,
      );
      if (!built) {
        console.error(chalk.red(`  ${s.cross} Failed to build sealed runner.`));
        process.exit(1);
      }
      runnerBuilt = true;
    } else {
      console.log(chalk.green(`  ${s.check} Using cached runner`));
    }

    // Boot the sealed runner with source mounted (or reuse existing)
    console.log(chalk.dim("  Booting sealed runner..."));
    const bootStart = performance.now();
    const { booted, reused } = await bootSealedRunner(cachePath, source);
    const bootDuration = Math.round(performance.now() - bootStart);

    if (!booted) {
      console.error(chalk.red(`  ${s.cross} Failed to boot sealed runner.`));
      process.exit(1);
    }
    // Compute the working directory inside the VM.
    // We mount the parent dir at /projects, so the project is at /projects/<dirname>.
    const absSource = resolve(source);
    const projectName = basename(absSource);
    const projectWorkdir = `/projects/${projectName}`;

    console.log(
      chalk.green(
        `  ${s.check} Runner ${reused ? "reused" : "ready"} ${chalk.dim(`(${fmtDuration(bootDuration)})`)}`,
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
                chalk.dim(`    ${s.skip} ${cmd.id} (skipped - before --from)`),
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
            console.log(chalk.dim(`    ${s.skip} ${cmd.id} (skipped)`));
            continue;
          }

          // Execute the step
          process.stdout.write(chalk.blue(`    ${s.play} ${cmd.id}...`));

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
              `\r    ${chalk.green(s.check)} ${cmd.id} ${chalk.dim(`(${result.duration_ms}ms)`)}`,
            );
          } else {
            console.log(
              `\r    ${chalk.red(s.cross)} ${cmd.id} ${chalk.dim(`(${result.duration_ms}ms)`)}`,
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
          chalk.red(`\n${s.cross} Step '${options.from}' not found in ${wfName}`),
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
          `  ${s.check} ${wfName} passed ${chalk.dim(`(${fmtDuration(totalDuration)})`)}`,
        ),
      );
    } else {
      console.log(
        chalk.red(
          `  ${s.cross} ${wfName} failed at step '${failedStep?.id}' ${chalk.dim(`(${fmtDuration(totalDuration)})`)}`,
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

  // ── Graph write-back (GitHub Actions bridge) ──────────────────────────────
  const cbRoot = findCbRoot(source);
  if (cbRoot && machineKeyExists()) {
    const ghStartedAt = new Date(Date.now() - Math.round(performance.now() - startTime));
    const ghFinishedAt = new Date();
    for (const result of allResults) {
      try {
        const { sealNodeId, sealId } = ensureSyntheticSeal(
          cbRoot,
          result.workflow,
          result.runner_cache_key,
        );
        await writeRunToGraph({
          cbRoot,
          sealId,
          sealNodeId,
          source,
          startedAt: ghStartedAt,
          finishedAt: ghFinishedAt,
          status: result.status === "passed" ? "Passed" : "Failed",
          steps: result.steps.map((s) => ({
            ...s,
            started_at: ghStartedAt.toISOString(),
          })),
        });
      } catch { /* best-effort */ }
    }
  }

  // ── Summary ────────────────────────────────────────────────────

  if (options.json) {
    console.log(JSON.stringify(allResults, null, 2));
  }

  const allPassed = allResults.every((r) => r.status === "passed");
  const totalDuration = Math.round(performance.now() - startTime);

  if (!options.json) {
    console.log(chalk.dim("-".repeat(50)));
    if (allPassed) {
      console.log(
        chalk.green(`${s.check} All checks passed ${chalk.dim(`(${fmtDuration(totalDuration)})`)}`),
      );
    } else {
      const failed = allResults.filter((r) => r.status === "failed");
      console.log(
        chalk.red(
          `${s.cross} ${failed.length} of ${allResults.length} workflow(s) failed`,
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
      "Run circuits in .cb/circuits/ (or GitHub Actions workflows with --github-actions)",
    )
    .option(
      "-c, --circuit <path>",
      "Run a specific circuit file (default: all in .cb/circuits/)",
    )
    .option(
      "-w, --workflow <path>",
      "GitHub Actions: path to a specific workflow file",
    )
    .option(
      "--from <step>",
      "Resume from a specific step (skip earlier steps)",
    )
    .option("--json", "Output structured JSON results")
    .option(
      "--shell",
      "GitHub Actions: run in host shell instead of SmolVM",
    )
    .option(
      "-s, --source <path>",
      "Source directory (default: current directory)",
      ".",
    )
    .option("--rebuild", "Force rebuild the sealed runner (ignore cache)")
    .option(
      "--github-actions",
      "Explicitly run GitHub Actions workflows via the bridge (legacy mode)",
    )
    .action(check);
}

export default check;
