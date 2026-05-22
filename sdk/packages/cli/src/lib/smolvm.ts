/**
 * SmolVM subprocess helpers — builder/runner VM lifecycle shared between
 * `cb check` (GHA circuits) and `cb seal` (runner ensurement).
 */
import chalk from "chalk";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE_INSTALL_STEPS,
  GITHUB_ACTIONS_SHIM,
  RUNNER_CACHE_DIR,
  resolveAction,
} from "@circuit-breaker/core";
import { hashFile, hashString } from "./hashing";
import { s } from "./symbols";

export { RUNNER_CACHE_DIR };

export const BUILDER_VM_PREFIX = "cb-build-";
export const RUNNER_VM = "cb-check";

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec === 0 ? `${m}m` : `${m}m${sec}s`;
}

function shellQuote(str: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// ─── SmolVM subprocess ────────────────────────────────────────────────────────

export async function smolvm(
  args: string[],
  options?: { timeout?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["smolvm", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options?.timeout) {
    timer = setTimeout(() => { proc.kill(); }, options.timeout);
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

export function hasSmolvmBinary(): boolean {
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

// ─── VM state ─────────────────────────────────────────────────────────────────

/**
 * Returns the VM state string ("running", "stopped", …) or null if the VM
 * doesn't exist.  More reliable than `smolvm machine status`, which returns
 * exit 0 for non-existent VMs.
 */
export async function getVmState(
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

// ─── Builder VM lifecycle ─────────────────────────────────────────────────────

export async function createBuilderVM(
  vmName: string,
  image: string,
): Promise<boolean> {
  await smolvm(["machine", "stop", "--name", vmName]);
  await smolvm(["machine", "delete", vmName, "-f"]);

  const create = await smolvm(["machine", "create", "--image", image, "--net", vmName]);
  if (create.exitCode !== 0) {
    console.error(chalk.red(`  Failed to create builder VM: ${create.stderr.trim()}`));
    return false;
  }

  const start = await smolvm(["machine", "start", "--name", vmName]);
  if (start.exitCode !== 0) {
    console.error(chalk.red(`  Failed to start builder VM: ${start.stderr.trim()}`));
    return false;
  }

  return true;
}

export async function execInBuilder(
  vmName: string,
  script: string,
  label?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; duration_ms: number }> {
  const start = performance.now();
  if (label) console.log(chalk.dim(`    ${s.play} ${label}`));

  const proc = Bun.spawn(
    ["smolvm", "machine", "exec", "--name", vmName, "--stream", "--", "bash", "-c", script],
    { stdout: "pipe", stderr: "pipe" },
  );

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // 10 minute timeout — baseline apt-get can take 3-5 min
  const TIMEOUT_MS = 600_000;
  let killed = false;
  const timer = setTimeout(() => { killed = true; proc.kill(); }, TIMEOUT_MS);

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
        if (line.trim().length > 0) console.log(chalk.dim(`${prefix}${line}`));
      }
    }
    if (buffer.trim().length > 0) console.log(chalk.dim(`${prefix}${buffer}`));
  };

  await Promise.all([
    streamLines(proc.stdout as ReadableStream<Uint8Array>, stdoutChunks, "      "),
    streamLines(proc.stderr as ReadableStream<Uint8Array>, stderrChunks, "      "),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const duration_ms = Math.round(performance.now() - start);
  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");

  if (label) {
    if (killed) {
      console.log(chalk.red(`    ${s.cross} ${label} (timed out after ${TIMEOUT_MS / 1000}s)`));
    } else if (exitCode === 0) {
      console.log(`    ${chalk.green(s.check)} ${label} ${chalk.dim(`(${fmtDuration(duration_ms)})`)}`);
    } else {
      console.log(`    ${chalk.red(s.cross)} ${label} (exit code ${exitCode}) ${chalk.dim(`(${fmtDuration(duration_ms)})`)}`);
    }
  }

  return { exitCode, stdout, stderr, duration_ms };
}

export async function sealBuilder(
  vmName: string,
  outputPath: string,
): Promise<boolean> {
  // smolvm pack create --from-vm requires the VM to be stopped first
  const stop = await smolvm(["machine", "stop", "--name", vmName]);
  if (stop.exitCode !== 0) {
    console.error(chalk.red(`    Failed to stop builder VM before seal: ${stop.stderr.trim()}`));
    return false;
  }

  const outputBase = outputPath.replace(/\.smolmachine$/, "");
  const result = await smolvm(
    ["pack", "create", "--from-vm", vmName, "-o", outputBase],
    { timeout: 300_000 },
  );

  if (result.exitCode !== 0) {
    const output = (result.stderr || result.stdout).trim();
    if (output) {
      console.error(chalk.red("    Seal error output:"));
      for (const line of output.split("\n").slice(-10)) {
        console.error(chalk.red(`      ${line}`));
      }
    } else {
      console.error(chalk.red(`    Seal exited with code ${result.exitCode} (no output)`));
    }
  }

  return result.exitCode === 0;
}

export async function destroyVM(vmName: string): Promise<void> {
  await smolvm(["machine", "stop", "--name", vmName]);
  await smolvm(["machine", "delete", vmName, "-f"]);
}

export async function stopVM(vmName: string): Promise<void> {
  await smolvm(["machine", "stop", "--name", vmName]);
}

// ─── Sealed runner build ──────────────────────────────────────────────────────

export async function buildSealedRunner(
  image: string,
  usesSteps: {
    uses: string;
    with?: Record<string, unknown>;
    name?: string;
    env?: Record<string, string>;
  }[],
  cacheKey: string,
  cachePath: string,
  options?: { repoRoot?: string },
): Promise<boolean> {
  const builderVM = `${BUILDER_VM_PREFIX}${cacheKey.slice(0, 12)}`;

  console.log(chalk.bold("  Building sealed runner..."));
  console.log(chalk.dim(`    Base image: ${image}`));
  console.log(chalk.dim(`    Tools to install: ${usesSteps.length} uses: step(s)`));

  const created = await createBuilderVM(builderVM, image);
  if (!created) return false;

  try {
    for (const step of BASELINE_INSTALL_STEPS) {
      const result = await execInBuilder(builderVM, step.script, `baseline: ${step.label}`);
      if (result.exitCode !== 0) {
        console.error(chalk.red(`    Baseline install failed at: ${step.label}`));
        for (const line of (result.stderr || result.stdout).trim().split("\n").slice(-5)) {
          console.error(chalk.red(`      ${line}`));
        }
        return false;
      }
    }

    const shim = await execInBuilder(builderVM, GITHUB_ACTIONS_SHIM, "Setting up GitHub Actions environment");
    if (shim.exitCode !== 0) {
      console.error(chalk.red("    Shim setup failed:"));
      for (const line of (shim.stderr || shim.stdout).trim().split("\n").slice(-5)) {
        console.error(chalk.red(`      ${line}`));
      }
      return false;
    }

    for (const step of usesSteps) {
      const label = step.name ?? step.uses;
      const resolved = await resolveAction(step.uses, step.with, { repoRoot: options?.repoRoot });
      if (!resolved || resolved.length === 0) {
        console.log(chalk.dim(`    ${s.skip} ${label} (no install steps)`));
        continue;
      }

      const combinedScript = [
        GITHUB_ACTIONS_SHIM,
        "",
        "_gh_source_env",
        "",
        ...(step.env
          ? Object.entries(step.env).map(([k, v]) => `export ${k}=${shellQuote(v)}`)
          : []),
        "",
        ...resolved.map((r) => r.run),
      ].join("\n");

      const result = await execInBuilder(builderVM, combinedScript, `Installing ${label}`);
      if (result.exitCode !== 0) {
        console.error(chalk.red(`    Install script for '${label}' failed:`));
        for (const line of (result.stderr || result.stdout).trim().split("\n").slice(-10)) {
          console.error(chalk.red(`      ${line}`));
        }
        return false;
      }
    }

    console.log(chalk.dim("    Sealing runner..."));
    const sealStart = performance.now();
    mkdirSync(RUNNER_CACHE_DIR, { recursive: true });

    const sealed = await sealBuilder(builderVM, cachePath);
    const sealDuration = Math.round(performance.now() - sealStart);

    if (!sealed) {
      console.error(chalk.red("    Failed to seal runner."));
      return false;
    }

    console.log(chalk.green(`    ${s.check} Runner sealed ${chalk.dim(`(${fmtDuration(sealDuration)})`)}`));
    console.log(chalk.dim(`    Cached at: ${cachePath}`));
    return true;
  } finally {
    await destroyVM(builderVM);
  }
}

// ─── Native runner pack ───────────────────────────────────────────────────────

/**
 * Fingerprint the native runner VM (cb-check) by querying its installed
 * package state rather than packing the whole disk image.
 *
 * Packing would create a multi-GB archive and hits smolvm's 4 GB cap once the
 * VM has nvm + Node + other tooling installed.  A hash of the package manifest
 * is just as effective for detecting runner changes.
 *
 * Returns a stable hex hash, or null if the VM doesn't exist.
 */
export async function fingerprintNativeRunner(): Promise<string | null> {
  if (!hasSmolvmBinary()) return null;

  const vmState = await getVmState(RUNNER_VM);
  if (!vmState) return null;

  const wasRunning = vmState === "running";
  if (!wasRunning) {
    const start = await smolvm(["machine", "start", "--name", RUNNER_VM]);
    if (start.exitCode !== 0) return null;
  }

  // Collect a lightweight fingerprint: dpkg manifest + key tool versions
  const fingerprint = await smolvm([
    "machine", "exec", "--name", RUNNER_VM, "--", "bash", "-c",
    [
      "dpkg-query -W -f='${Package} ${Version}\\n' 2>/dev/null | sort",
      '. "$HOME/.nvm/nvm.sh" 2>/dev/null; node --version 2>/dev/null || true',
      '. "$HOME/.nvm/nvm.sh" 2>/dev/null; nvm --version 2>/dev/null || true',
      "rustup --version 2>/dev/null || true",
      "gh --version 2>/dev/null | head -1 || true",
    ].join(" && "),
  ], { timeout: 30_000 });

  if (!wasRunning) {
    await smolvm(["machine", "stop", "--name", RUNNER_VM]);
  }

  if (fingerprint.exitCode !== 0) return null;
  return hashString(fingerprint.stdout);
}
