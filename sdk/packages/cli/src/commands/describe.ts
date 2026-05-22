/**
 * Describe command - show workflow structure including places and their token schemas.
 *
 * This is useful for:
 * - Understanding the workflow structure
 * - Seeing what token data is expected at each place
 * - Debugging workflow state
 *
 * @module
 */

import type { Command } from "commander";
import chalk from "chalk";

interface DescribeOptions {
  json?: boolean;
}

interface PlaceSchemaInfo {
  placeId: string;
  tokenSchema?: Record<string, unknown>;
  tokenCount: number;
  requiresData: boolean;
}

interface DescribePlacesResponse {
  runId: string;
  workflowName: string;
  places: PlaceSchemaInfo[];
}

interface TransitionStatus {
  transitionId: string;
  status: string;
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface RunStatus {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  currentMarking: Record<string, number>;
  transitions: TransitionStatus[];
}

/**
 * Execute the describe command.
 */
export async function describe(
  runId: string,
  options: DescribeOptions,
  command: Command,
): Promise<void> {
  const globalOpts = command.optsWithGlobals();
  const apiUrl = globalOpts.apiUrl || "http://localhost:8080";

  try {
    // Fetch run status
    const statusResponse = await fetch(`${apiUrl}/api/v1/runs/${runId}`);
    if (!statusResponse.ok) {
      const error = await statusResponse
        .json()
        .catch(() => ({ message: statusResponse.statusText }));
      throw new Error(error.message || `HTTP ${statusResponse.status}`);
    }
    const runStatus: RunStatus = await statusResponse.json();

    // Fetch places info
    const placesResponse = await fetch(`${apiUrl}/api/v1/runs/${runId}/places`);
    if (!placesResponse.ok) {
      const error = await placesResponse
        .json()
        .catch(() => ({ message: placesResponse.statusText }));
      throw new Error(error.message || `HTTP ${placesResponse.status}`);
    }
    const placesInfo: DescribePlacesResponse = await placesResponse.json();

    // Output as JSON if requested
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            run: runStatus,
            places: placesInfo.places,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Pretty print
    console.log(chalk.bold(`Workflow: ${runStatus.workflowName}`));
    console.log(chalk.dim("-".repeat(60)));
    console.log();

    console.log(`${chalk.cyan("Run ID:")}     ${runStatus.runId}`);
    console.log(`${chalk.cyan("Status:")}     ${formatStatus(runStatus.status)}`);
    console.log(`${chalk.cyan("Started:")}    ${runStatus.startedAt}`);
    if (runStatus.completedAt) {
      console.log(`${chalk.cyan("Completed:")}  ${runStatus.completedAt}`);
    }
    console.log();

    // Places section
    console.log(chalk.bold.cyan("Places:"));
    console.log();

    for (const place of placesInfo.places) {
      const tokenIndicator =
        place.tokenCount > 0
          ? chalk.green(` ● ${place.tokenCount} token${place.tokenCount > 1 ? "s" : ""}`)
          : chalk.dim(" ○ empty");

      const schemaIndicator = place.requiresData
        ? chalk.yellow(" [schema]")
        : "";

      console.log(`  ${chalk.bold(place.placeId)}${tokenIndicator}${schemaIndicator}`);

      if (place.tokenSchema) {
        console.log(chalk.dim("    Token Schema:"));
        const schemaStr = JSON.stringify(place.tokenSchema, null, 2);
        const indentedSchema = schemaStr
          .split("\n")
          .map((line) => "      " + chalk.dim(line))
          .join("\n");
        console.log(indentedSchema);
      }
      console.log();
    }

    // Transitions section
    console.log(chalk.bold.cyan("Transitions:"));
    console.log();

    for (const transition of runStatus.transitions) {
      const statusColor =
        transition.status === "completed"
          ? chalk.green
          : transition.status === "failed"
            ? chalk.red
            : transition.status === "firing"
              ? chalk.yellow
              : chalk.dim;

      console.log(
        `  ${chalk.bold(transition.transitionId)}: ${statusColor(transition.status)}`,
      );

      if (transition.startedAt) {
        console.log(chalk.dim(`    Started: ${transition.startedAt}`));
      }
      if (transition.completedAt) {
        console.log(chalk.dim(`    Completed: ${transition.completedAt}`));
      }
      if (transition.error) {
        console.log(chalk.red(`    Error: ${transition.error}`));
      }
      if (transition.attempt > 1) {
        console.log(chalk.dim(`    Attempt: ${transition.attempt}`));
      }
    }

    console.log();
    console.log(chalk.dim("-".repeat(60)));
    console.log();
    console.log(chalk.dim("Commands:"));
    console.log(
      chalk.dim(`  Inject token:  cb inject ${runId} <place_id> --data '{...}'`),
    );
    console.log(chalk.dim(`  View logs:     cb logs ${runId}`));
    console.log(chalk.dim(`  View status:   cb status ${runId}`));
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`Error: ${error.message}`));
    }
    process.exit(1);
  }
}

/**
 * Format status with color.
 */
function formatStatus(status: string): string {
  switch (status) {
    case "completed":
      return chalk.green(status);
    case "failed":
      return chalk.red(status);
    case "running":
      return chalk.blue(status);
    case "pending":
      return chalk.yellow(status);
    case "cancelled":
      return chalk.gray(status);
    default:
      return status;
  }
}

export default describe;
