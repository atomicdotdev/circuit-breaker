/**
 * `cb log` — query and display run history from the local graph.
 *
 * Usage:
 *   cb log                          # recent runs (all circuits)
 *   cb log --seal cb/ci:d4e5f6      # runs for a specific seal
 *   cb log --input <hash>           # runs for a specific input state
 *   cb log --limit 50               # control output size
 */
import type { Command } from "commander";
import chalk from "chalk";
import { openGraph, type RunPayload } from "../lib/graph";
import { s } from "../lib/symbols";

function statusIcon(status: string): string {
  switch (status) {
    case "Passed": return chalk.green(s.check);
    case "Failed": return chalk.red(s.cross);
    case "Tripped": return chalk.yellow("⚡");
    case "Partial": return chalk.yellow("~");
    default: return chalk.dim("?");
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function formatRow(
  nodeId: string,
  seq: number,
  payload: RunPayload,
): string {
  const started = new Date(payload.started_at);
  const finished = new Date(payload.finished_at);
  const durationMs = finished.getTime() - started.getTime();
  const icon = statusIcon(payload.status);
  const id = nodeId.slice(0, 12);
  const sealRef = payload.seal_id.split(":")[1]?.slice(0, 8) ?? payload.seal_id.slice(0, 8);
  const timeStr = started.toISOString().replace("T", " ").slice(0, 16);
  const dur = formatDuration(durationMs);
  const input = payload.input_hash.slice(0, 8);

  return `${icon} ${chalk.dim(`#${seq.toString().padStart(4)}`)}  ${id}  seal:${sealRef}  input:${input}  ${timeStr}  ${chalk.dim(dur)}`;
}

export async function logRuns(options: {
  seal?: string;
  input?: string;
  limit?: string;
  json?: boolean;
}): Promise<void> {
  const graph = openGraph();
  if (!graph) {
    console.error(chalk.red(`${s.cross} No .cb/ directory found. Run \`cb init\` to set up.`));
    process.exit(1);
  }

  const limit = parseInt(options.limit ?? "20", 10);

  let rows: Array<{ nodeId: string; seq: number; payload: RunPayload }> = [];

  if (options.seal) {
    const sealHash = options.seal.includes(":") ? options.seal.split(":")[1] ?? "" : options.seal;
    // Look up by seal prefix
    const chain = graph.getRunChain(200);
    const allSeals = chain.map((r) => {
      const p = graph.getRunByNodeId(r.runNodeId);
      return p ? { nodeId: r.runNodeId, seq: r.seq, payload: p } : null;
    }).filter((r): r is { nodeId: string; seq: number; payload: RunPayload } => r !== null);

    rows = allSeals
      .filter((r) => r.payload.seal_id.includes(sealHash))
      .slice(0, limit);
  } else if (options.input) {
    const byInput = graph.getRunsByInput(options.input);
    const chain = graph.getRunChain(200);
    rows = byInput
      .map((r) => {
        const chainEntry = chain.find((c) => c.runNodeId === r.nodeId);
        return chainEntry ? { nodeId: r.nodeId, seq: chainEntry.seq, payload: r.payload } : null;
      })
      .filter((r): r is { nodeId: string; seq: number; payload: RunPayload } => r !== null)
      .slice(0, limit);
  } else {
    const chain = graph.getRunChain(limit);
    rows = chain
      .map((r) => {
        const p = graph.getRunByNodeId(r.runNodeId);
        return p ? { nodeId: r.runNodeId, seq: r.seq, payload: p } : null;
      })
      .filter((r): r is { nodeId: string; seq: number; payload: RunPayload } => r !== null);
  }

  graph.close();

  if (options.json) {
    console.log(JSON.stringify(rows.map((r) => ({
      run_id: r.nodeId,
      seq: r.seq,
      ...r.payload,
    })), null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(chalk.dim("No runs recorded yet."));
    return;
  }

  console.log();
  for (const row of rows) {
    console.log(formatRow(row.nodeId, row.seq, row.payload));
  }
  console.log();
  console.log(chalk.dim(`  Showing ${rows.length} run(s). Run ID prefix can be used with \`cb attest\` and \`cb verify\`.`));
  console.log();
}

export function registerLogCommand(program: Command): void {
  program
    .command("log")
    .description("Show run history from the local graph")
    .option("--seal <ref>", "Filter by seal reference (e.g. cb/ci:d4e5f6)")
    .option("--input <hash>", "Filter by input hash")
    .option("--limit <n>", "Max runs to show", "20")
    .option("--json", "Machine-readable JSON")
    .action(async (options: { seal?: string; input?: string; limit?: string; json?: boolean }) => {
      try {
        await logRuns(options);
      } catch (err) {
        console.error(chalk.red(`${s.cross} ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}

