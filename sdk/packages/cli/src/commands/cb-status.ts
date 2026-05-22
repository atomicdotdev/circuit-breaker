/**
 * `cb status` (no args) — last run result + active seal summary.
 *
 * Shows what the inner loop last produced for this repo.
 * `cb status <runId>` falls through to the outer-loop run status (workflow engine).
 */
import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { openGraph, findGraphPath, type RunPayload } from "../lib/graph";
import { loadConfig, isConfigured } from "../lib/config";
import { machineKeyExists, getMachinePubkeyBase64 } from "../lib/signing";
import { s } from "../lib/symbols";

function statusBadge(status: string): string {
  switch (status) {
    case "Passed": return chalk.green.bold("PASSED");
    case "Failed": return chalk.red.bold("FAILED");
    case "Tripped": return chalk.yellow.bold("TRIPPED");
    case "Partial": return chalk.yellow.bold("PARTIAL");
    default: return chalk.dim(status);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

export async function cbStatus(): Promise<void> {
  const config = loadConfig();
  const keyOk = machineKeyExists();

  console.log(chalk.bold("\nCircuit Breaker - Inner Loop Status\n"));

  // ── Machine config ────────────────────────────────────────────────────────
  if (!isConfigured() || !keyOk) {
    console.log(chalk.yellow(`  ${s.warn}  Not configured. Run \`cb init\` to set up.`));
    console.log();
    return;
  }

  let pubkeyShort = "?";
  try { pubkeyShort = getMachinePubkeyBase64().slice(0, 20); } catch { /* ignore */ }

  console.log(chalk.bold("Machine:"));
  console.log(`  Seal signer:  ${config?.identity.seal_signer}`);
  console.log(`  Machine key:  ed25519:${pubkeyShort}...`);
  console.log();

  // ── Repo graph ────────────────────────────────────────────────────────────
  const dbPath = findGraphPath();
  if (!dbPath) {
    console.log(chalk.dim("  No .cb/ directory in this repo. Run `cb init` to initialize."));
    console.log();
    return;
  }

  const cbRoot = dirname(dirname(dirname(dbPath)));
  const graph = openGraph();
  if (!graph) {
    console.log(chalk.dim("  .cb/ found but graph not yet initialized."));
    console.log();
    return;
  }

  // ── Last run per circuit ──────────────────────────────────────────────────
  // Show the latest run for each active seal individually so a passing circuit
  // never masks a failing one. getLatestRun() with no args returns the global
  // most-recent row, which is misleading when multiple circuits ran and the
  // last one happened to pass.
  const sealsDir = join(cbRoot, ".cb", "seals");
  const sealDirs = existsSync(sealsDir)
    ? readdirSync(sealsDir).filter((d) => existsSync(join(sealsDir, d, "manifest.json")))
    : [];

  if (sealDirs.length === 0) {
    graph.close();
    console.log(chalk.dim("  No runs recorded yet. Run `cb check` to get started."));
    console.log();
    return;
  }

  const chain = graph.getRunChain(1);

  let anyRun = false;
  let anyFailed = false;

  console.log(chalk.bold("Last Run (per circuit):"));
  console.log();

  for (const dir of sealDirs.slice(0, 10)) {
    let manifest: Record<string, string>;
    try {
      manifest = JSON.parse(readFileSync(join(sealsDir, dir, "manifest.json"), "utf-8"));
    } catch { continue; }

    const last = graph.getLatestRun(manifest.seal_hash);
    if (!last) {
      console.log(`  ${chalk.dim(`cb/${manifest.circuit_name}:${dir}`)}  ${chalk.dim("no runs yet")}`);
      continue;
    }

    anyRun = true;
    const p: RunPayload = last.payload;
    const started = new Date(p.started_at);
    const finished = new Date(p.finished_at);
    const durationMs = finished.getTime() - started.getTime();
    const transitions = graph.getTransitionsByRun(last.nodeId);
    const passed = transitions.filter((t) => t.payload.status === "Passed").length;
    const total = transitions.length;

    if (p.status === "Failed") anyFailed = true;

    console.log(`  ${statusBadge(p.status)}  cb/${manifest.circuit_name}:${dir}  ${chalk.dim(`(${formatDuration(durationMs)})`)}`);
    console.log(`  ${chalk.dim(`Run: ${last.nodeId.slice(0, 12)}  Steps: ${passed}/${total}  When: ${started.toISOString()}`)}`);

    if (transitions.length > 0) {
      console.log();
      for (const t of transitions) {
        const icon = t.payload.status === "Passed"
          ? chalk.green(`    ${s.check}`)
          : t.payload.status === "Failed"
            ? chalk.red(`    ${s.cross}`)
            : chalk.dim(`    ${s.skip}`);
        console.log(`${icon} ${t.payload.name.padEnd(26)} ${chalk.dim(formatDuration(t.payload.duration_ms))}`);
      }
      console.log();
    }
  }

  graph.close();

  if (!anyRun) {
    console.log(chalk.dim("  No runs recorded yet. Run `cb check` to get started."));
    console.log();
    return;
  }

  console.log(chalk.dim("-".repeat(48)));
  if (anyFailed) {
    console.log(chalk.red.bold(`  Overall: FAILED`));
  } else {
    console.log(chalk.green.bold(`  Overall: PASSED`));
  }

  // ── Merkle root ───────────────────────────────────────────────────────────
  if (chain.length > 0) {
    console.log();
    console.log(chalk.dim(`  Merkle root: ${chain[0].merkleRoot.slice(0, 32)}...`));
  }

  console.log();
  console.log(chalk.dim("  Run `cb attest --json` to export signed evidence for VCS tooling."));
  console.log();
}

export function registerCbStatusCommand(program: Command): void {
  // This registers the *inner-loop* status (no args).
  // The outer-loop status (cb status <runId>) is handled separately in index.ts.
  program
    .command("status [runId]")
    .description("Show last inner-loop run result and active seals (no arg), or outer-loop run status (with run ID)")
    .option("-w, --watch", "Watch outer-loop run for updates (requires runId)")
    .action(async (runId: string | undefined, options: { watch?: boolean }, cmd: Command) => {
      if (!runId) {
        // Inner-loop status
        try {
          await cbStatus();
        } catch (err) {
          console.error(chalk.red(`${s.cross} ${err instanceof Error ? err.message : err}`));
          process.exit(1);
        }
        return;
      }

      // Delegate to outer-loop status
      const { CircuitBreakerClient } = await import("@circuit-breaker/core");
      const globalOpts = cmd.optsWithGlobals();
      const client = new CircuitBreakerClient({
        baseUrl: globalOpts.apiUrl,
        apiKey: globalOpts.apiKey,
      });

      try {
        if (options.watch) {
          console.log(chalk.dim(`Watching run ${runId}...\n`));
          for await (const status of client.watchRun(runId)) {
            console.clear();
            console.log(chalk.bold(`Run: ${runId}`));
            console.log(`Status: ${status.status}`);
            if (["completed", "failed", "cancelled"].includes(status.status)) break;
          }
        } else {
          const status = await client.getRunStatus(runId);
          if (globalOpts.output === "json") {
            console.log(JSON.stringify(status, null, 2));
          } else {
            console.log(chalk.bold(`Run: ${runId}`));
            console.log(`  Status:   ${status.status}`);
            console.log(`  Workflow: ${status.workflowName}`);
            console.log(`  Started:  ${status.startedAt}`);
            if (status.completedAt) console.log(`  Completed: ${status.completedAt}`);
          }
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
