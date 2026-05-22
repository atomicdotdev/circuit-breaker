/**
 * Logs command - retrieve logs for workflow runs.
 *
 * @module
 */

import type { Command } from "commander";
import chalk from "chalk";
import { CircuitBreakerClient } from "@circuit-breaker/core";

interface LogsOptions {
  transition?: string;
  follow?: boolean;
  tail?: string;
  json?: boolean;
}

interface TaskLog {
  taskId: string;
  runId: string;
  transitionId: string;
  status: string;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

interface LogsResponse {
  runId: string;
  logs: TaskLog[];
}

/**
 * Execute the logs command.
 */
export async function logs(
  runId: string,
  options: LogsOptions,
  command: Command,
): Promise<void> {
  const globalOpts = command.optsWithGlobals();
  const apiUrl = globalOpts.apiUrl || "http://localhost:8080";

  const client = new CircuitBreakerClient({
    baseUrl: apiUrl,
    apiKey: globalOpts.apiKey,
  });

  try {
    // Get run status first to validate run exists
    const status = await client.getRunStatus(runId);

    if (!options.json) {
      console.log(chalk.bold(`Logs for run: ${runId}`));
      console.log(chalk.dim(`Workflow: ${status.workflowName}`));
      console.log(chalk.dim(`Status: ${status.status}`));
      console.log(chalk.dim("-".repeat(60)));
      console.log();
    }

    // Fetch logs from API
    const response = await fetch(`${apiUrl}/api/v1/runs/${runId}/logs`);

    if (!response.ok) {
      throw new Error(`Failed to fetch logs: ${response.statusText}`);
    }

    const logsData: LogsResponse = await response.json();

    // Filter by transition if specified
    let logs = logsData.logs;
    if (options.transition) {
      logs = logs.filter((log) => log.transitionId === options.transition);
    }

    // Output as JSON if requested
    if (options.json) {
      console.log(JSON.stringify(logsData, null, 2));
      return;
    }

    if (logs.length === 0) {
      console.log(chalk.dim("No logs available yet."));
      console.log();
    } else {
      for (const log of logs) {
        const statusColor =
          log.status === "completed"
            ? chalk.green
            : log.status === "failed"
              ? chalk.red
              : chalk.yellow;

        console.log(`${chalk.cyan("Transition:")} ${log.transitionId}`);
        console.log(`${chalk.cyan("Status:")} ${statusColor(log.status)}`);
        console.log(`${chalk.cyan("Task ID:")} ${chalk.dim(log.taskId)}`);

        if (log.durationMs) {
          console.log(
            `${chalk.cyan("Duration:")} ${(log.durationMs / 1000).toFixed(2)}s`,
          );
        }

        if (log.startedAt) {
          console.log(`${chalk.cyan("Started:")} ${chalk.dim(log.startedAt)}`);
        }

        if (log.completedAt) {
          console.log(
            `${chalk.cyan("Completed:")} ${chalk.dim(log.completedAt)}`,
          );
        }

        if (log.error) {
          console.log();
          console.log(chalk.red("Error:"));
          console.log(chalk.red(log.error));
        }

        if (log.output) {
          console.log();
          console.log(chalk.cyan("Output:"));
          console.log(chalk.dim("-".repeat(40)));

          // Pretty print the output
          if (typeof log.output === "object") {
            const outputObj = log.output as Record<string, unknown>;

            // If output has a string 'output' field, display it nicely
            if (typeof outputObj.output === "string") {
              console.log(outputObj.output);
            } else if (
              typeof outputObj.stderr === "string" &&
              outputObj.stderr
            ) {
              console.log(chalk.yellow("stderr:"));
              console.log(outputObj.stderr);
            } else {
              console.log(JSON.stringify(log.output, null, 2));
            }
          } else {
            console.log(String(log.output));
          }

          console.log(chalk.dim("-".repeat(40)));
        }

        console.log();
      }
    }

    // Follow mode
    if (
      options.follow &&
      !["completed", "failed", "cancelled"].includes(status.status)
    ) {
      console.log(chalk.yellow("Following logs (Ctrl+C to stop)..."));
      console.log();

      let lastLogCount = logs.length;

      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Fetch updated logs
        const updatedResponse = await fetch(
          `${apiUrl}/api/v1/runs/${runId}/logs`,
        );
        if (updatedResponse.ok) {
          const updatedLogs: LogsResponse = await updatedResponse.json();

          // Show new logs
          const newLogs = updatedLogs.logs.slice(lastLogCount);
          for (const log of newLogs) {
            const statusColor =
              log.status === "completed"
                ? chalk.green
                : log.status === "failed"
                  ? chalk.red
                  : chalk.yellow;

            console.log(
              `${chalk.cyan(log.transitionId)} ${statusColor(log.status)}`,
            );

            if (log.output && typeof log.output === "object") {
              const outputObj = log.output as Record<string, unknown>;
              if (typeof outputObj.output === "string") {
                console.log(outputObj.output);
              }
            }
          }

          lastLogCount = updatedLogs.logs.length;
        }

        // Check if run is complete
        const currentStatus = await client.getRunStatus(runId);
        if (
          ["completed", "failed", "cancelled"].includes(currentStatus.status)
        ) {
          console.log();
          console.log(chalk.dim("-".repeat(60)));

          const finalColor =
            currentStatus.status === "completed"
              ? chalk.green
              : currentStatus.status === "failed"
                ? chalk.red
                : chalk.yellow;

          console.log(finalColor(`Run ${currentStatus.status}`));
          break;
        }
      }
    }

    console.log(chalk.dim("-".repeat(60)));
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`Error: ${error.message}`));
    }
    process.exit(1);
  }
}

export default logs;
