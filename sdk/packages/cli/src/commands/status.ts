/**
 * Status command - get status of a workflow run.
 *
 * @module
 */

import { CircuitBreakerClient } from '@circuit-breaker/core';
import { s } from "../lib/symbols";

interface StatusOptions {
  watch?: boolean;
  pollInterval?: string;
}

/**
 * Execute the status command.
 */
export async function status(
  runId: string,
  options: StatusOptions,
  command: { parent: { opts: () => { apiUrl?: string; apiKey?: string; output?: string } } }
): Promise<void> {
  const parentOpts = command.parent.opts();
  const client = new CircuitBreakerClient({
    baseUrl: parentOpts.apiUrl,
    apiKey: parentOpts.apiKey,
  });

  const outputFormat = parentOpts.output ?? 'table';

  try {
    if (options.watch) {
      const pollInterval = parseInt(options.pollInterval ?? '1000', 10);

      console.log(`Watching run ${runId}...\n`);

      for await (const runStatus of client.watchRun(runId, { pollInterval })) {
        console.clear();
        printStatus(runStatus, outputFormat);

        if (['completed', 'failed', 'cancelled'].includes(runStatus.status)) {
          break;
        }
      }
    } else {
      const runStatus = await client.getRunStatus(runId);
      printStatus(runStatus, outputFormat);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    }
    process.exit(1);
  }
}

/**
 * Print run status in the specified format.
 */
function printStatus(
  status: Awaited<ReturnType<CircuitBreakerClient['getRunStatus']>>,
  format: string
): void {
  if (format === 'json') {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  // Table/text format
  const statusIcon =
    status.status === 'completed'
      ? s.check
      : status.status === 'failed'
        ? s.cross
        : status.status === 'running'
          ? '⟳'
          : '○';

  console.log(`${statusIcon} Run: ${status.runId}`);
  console.log(`  Workflow: ${status.workflowName} (${status.workflowId})`);
  console.log(`  Status: ${status.status}`);
  console.log(`  Started: ${status.startedAt}`);

  if (status.completedAt) {
    console.log(`  Completed: ${status.completedAt}`);
  }

  // Current marking
  console.log('\n  Current Marking:');
  for (const [place, tokens] of Object.entries(status.currentMarking)) {
    if (tokens > 0) {
      console.log(`    ${place}: ${tokens} token${tokens > 1 ? 's' : ''}`);
    }
  }

  // Transition states
  console.log('\n  Transitions:');
  for (const t of status.transitions) {
    const icon =
      t.status === 'completed'
        ? s.check
        : t.status === 'failed'
          ? s.cross
          : t.status === 'firing'
            ? '⟳'
            : t.status === 'retrying'
              ? '↻'
              : '○';
    console.log(`    ${icon} ${t.transitionId}: ${t.status} (attempt ${t.attempt})`);

    if (t.error) {
      console.log(`       Error: ${t.error}`);
    }
  }

  // Error info
  if (status.error) {
    console.log('\n  Error:');
    console.log(`    Code: ${status.error.code}`);
    console.log(`    Message: ${status.error.message}`);
    if (status.error.transition) {
      console.log(`    Transition: ${status.error.transition}`);
    }
  }
}

export default status;
