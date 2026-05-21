/**
 * `cb attest` — print or export the signed run result.
 *
 * The `--json` form is what agents pipe to VCS tooling as inner-loop evidence.
 *
 * Usage:
 *   cb attest              # last run
 *   cb attest <run_id>     # specific run by node ID prefix
 *   cb attest --json       # machine-readable JSON
 *   cb attest --changes <hash,...>  # attach specific VCS change hashes
 */
import type { Command } from "commander";
import chalk from "chalk";
import { openGraph, type RunPayload } from "../lib/graph";
import { s } from "../lib/symbols";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function statusIcon(status: string): string {
  switch (status) {
    case "Passed": return chalk.green(s.check);
    case "Failed": return chalk.red(s.cross);
    case "Tripped": return chalk.yellow("⚡");
    case "Partial": return chalk.yellow("~");
    default: return chalk.dim("?");
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export async function attest(
  runId: string | undefined,
  options: { json?: boolean; changes?: string },
): Promise<void> {
  const graph = openGraph();
  if (!graph) {
    console.error(chalk.red(`${s.cross} No .cb/ directory found. Run \`cb init\` to set up.`));
    process.exit(1);
  }

  let run: { nodeId: string; payload: RunPayload } | null = null;

  if (runId) {
    // Find run by node ID prefix
    const chain = graph.getRunChain(100);
    const match = chain.find((r) => r.runNodeId.startsWith(runId));
    if (!match) {
      graph.close();
      console.error(chalk.red(`${s.cross} Run not found: ${runId}`));
      process.exit(1);
    }
    const payload = graph.getRunByNodeId(match.runNodeId);
    if (!payload) {
      graph.close();
      console.error(chalk.red(`${s.cross} Run not found: ${runId}`));
      process.exit(1);
    }
    run = { nodeId: match.runNodeId, payload };
  } else {
    run = graph.getLatestRun();
  }

  if (!run) {
    graph.close();
    console.log(chalk.dim("No runs recorded yet. Run `cb check` first."));
    process.exit(0);
  }

  const transitions = graph.getTransitionsByRun(run.nodeId);
  graph.close();

  // Attach additional change hashes if provided
  const changeHashes = options.changes
    ? [...run.payload.change_hashes, ...options.changes.split(",").filter(Boolean)]
    : run.payload.change_hashes;

  if (options.json) {
    const out = {
      run_id: run.nodeId,
      seal_id: run.payload.seal_id,
      input_hash: run.payload.input_hash,
      change_hashes: changeHashes,
      started_at: run.payload.started_at,
      finished_at: run.payload.finished_at,
      status: run.payload.status,
      log_hash: run.payload.log_hash,
      merkle_at_record: run.payload.merkle_at_record,
      cb_version: run.payload.cb_version,
      cb_pubkey: run.payload.cb_pubkey,
      signature: run.payload.signature,
      steps: transitions.map((t) => ({
        name: t.payload.name,
        status: t.payload.status,
        duration_ms: t.payload.duration_ms,
        exit_code: t.payload.exit_code,
      })),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Human-readable output
  const p = run.payload;
  const runIdShort = run.nodeId.slice(0, 12);
  const started = new Date(p.started_at);
  const finished = new Date(p.finished_at);
  const durationMs = finished.getTime() - started.getTime();

  console.log();
  console.log(`${statusIcon(p.status)} Run:      ${runIdShort}`);
  console.log(`  Circuit: ${p.seal_id.slice(0, 40)}`);
  console.log(`  Input:   sha256:${truncate(p.input_hash, 24)}`);
  if (changeHashes.length > 0) {
    console.log(`  Changes: [${changeHashes.slice(0, 3).map((h) => h.slice(0, 12)).join(", ")}${changeHashes.length > 3 ? `, +${changeHashes.length - 3} more` : ""}]`);
  }
  console.log(`  Status:  ${p.status} (${transitions.filter((t) => t.payload.status === "Passed").length}/${transitions.length} steps)`);

  if (transitions.length > 0) {
    for (const t of transitions) {
      const icon = t.payload.status === "Passed"
        ? chalk.green(`  ${s.check}`)
        : t.payload.status === "Failed"
          ? chalk.red(`  ${s.cross}`)
          : chalk.dim(`  ${s.skip}`);
      const dur = formatDuration(t.payload.duration_ms);
      console.log(`${icon} ${t.payload.name.padEnd(24)} ${chalk.dim(dur)}`);
    }
  }

  console.log(`  Machine: ed25519:${p.cb_pubkey.slice(0, 16)}...`);
  console.log(`  Sig:     ${p.signature.slice(0, 16)}...`);
  console.log(`  Merkle:  ${p.merkle_at_record.slice(0, 16)}...`);
  console.log(`  Time:    ${started.toISOString()} (${formatDuration(durationMs)})`);
  console.log();
}

export function registerAttestCommand(program: Command): void {
  program
    .command("attest [runId]")
    .description("Print or export the signed run result as inner-loop evidence")
    .option("--json", "Machine-readable JSON (for VCS tooling)")
    .option("--changes <hashes>", "Comma-separated VCS change hashes to attach")
    .action(async (runId: string | undefined, options: { json?: boolean; changes?: string }) => {
      try {
        await attest(runId, options);
      } catch (err) {
        console.error(chalk.red(`${s.cross} ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
