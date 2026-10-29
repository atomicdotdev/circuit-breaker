/**
 * Inject command - inject a token into a specific place in a workflow run.
 *
 * This is useful for:
 * - Testing specific transitions without running the whole workflow
 * - Restarting failed transitions by re-injecting tokens
 * - Debugging workflow behavior
 *
 * @module
 */

import type { Command } from "commander";
import chalk from "chalk";
import { s } from "../lib/symbols";

interface InjectOptions {
  data?: string;
  json?: boolean;
  showSchema?: boolean;
  reason?: string;
}

interface InjectResponse {
  runId: string;
  placeId: string;
  tokenCount: number;
  enabledTransitions: string[];
  tokenSchema?: Record<string, unknown>;
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

/**
 * Execute the inject command.
 */
export async function inject(
  runId: string,
  placeId: string,
  options: InjectOptions,
  command: Command,
): Promise<void> {
  const globalOpts = command.optsWithGlobals();
  const apiUrl = globalOpts.apiUrl || "http://localhost:8080";

  try {
    // If --show-schema is passed, fetch and display the schema first
    if (options.showSchema) {
      await showPlaceSchema(apiUrl, runId, placeId);
      return;
    }

    // Parse optional data
    let tokenData: unknown = undefined;
    if (options.data) {
      try {
        tokenData = JSON.parse(options.data);
      } catch {
        console.error(chalk.red("Error: --data must be valid JSON"));
        process.exit(1);
      }
    }

    // Make the inject request
    const response = await fetch(`${apiUrl}/api/v1/runs/${runId}/inject`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        placeId,
        data: tokenData,
        reason: options.reason,
      }),
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ message: response.statusText }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    const result: InjectResponse = await response.json();

    // Output as JSON if requested
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Pretty print the result
    console.log(chalk.green(`${s.check} Token injected successfully`));
    console.log();
    console.log(`${chalk.cyan("Run ID:")}      ${result.runId}`);
    console.log(`${chalk.cyan("Place:")}       ${result.placeId}`);
    console.log(`${chalk.cyan("Token Count:")} ${result.tokenCount}`);
    console.log();

    if (result.enabledTransitions.length > 0) {
      console.log(chalk.cyan("Enabled Transitions:"));
      for (const transition of result.enabledTransitions) {
        console.log(`  ${chalk.yellow("→")} ${transition}`);
      }
      console.log();
      console.log(
        chalk.dim("These transitions will be executed by available runners."),
      );
    } else {
      console.log(chalk.dim("No transitions were enabled by this token."));
      console.log(
        chalk.dim("The transition may require tokens in other input places."),
      );
    }

    // Show schema hint if place has one
    if (result.tokenSchema) {
      console.log();
      console.log(
        chalk.yellow("Note:"),
        chalk.dim("This place has a token schema defined."),
      );
      console.log(
        chalk.dim("Use --show-schema to view the expected data format."),
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`Error: ${error.message}`));
    }
    process.exit(1);
  }
}

/**
 * Show the token schema for a specific place.
 */
async function showPlaceSchema(
  apiUrl: string,
  runId: string,
  placeId: string,
): Promise<void> {
  const response = await fetch(`${apiUrl}/api/v1/runs/${runId}/places`);

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  const result: DescribePlacesResponse = await response.json();
  const place = result.places.find((p) => p.placeId === placeId);

  if (!place) {
    console.error(chalk.red(`Error: Place '${placeId}' not found in workflow`));
    console.log();
    console.log(chalk.cyan("Available places:"));
    for (const p of result.places) {
      const schemaIndicator = p.requiresData
        ? chalk.yellow(" (has schema)")
        : "";
      const tokenIndicator =
        p.tokenCount > 0 ? chalk.green(` [${p.tokenCount} tokens]`) : "";
      console.log(`  - ${p.placeId}${schemaIndicator}${tokenIndicator}`);
    }
    process.exit(1);
  }

  console.log(chalk.bold(`Token Schema for place: ${placeId}`));
  console.log(chalk.dim("-".repeat(50)));
  console.log();

  if (place.tokenSchema) {
    console.log(chalk.cyan("Schema:"));
    console.log(JSON.stringify(place.tokenSchema, null, 2));
    console.log();
    console.log(chalk.cyan("Example usage:"));
    console.log(
      chalk.dim(
        `  cb inject ${runId} ${placeId} --data '${generateExampleFromSchema(place.tokenSchema)}'`,
      ),
    );
  } else {
    console.log(chalk.dim("No schema defined for this place."));
    console.log(chalk.dim("Tokens can be injected without data."));
    console.log();
    console.log(chalk.cyan("Usage:"));
    console.log(chalk.dim(`  cb inject ${runId} ${placeId}`));
    console.log();
    console.log(chalk.dim("Or with optional data:"));
    console.log(
      chalk.dim(`  cb inject ${runId} ${placeId} --data '{"key": "value"}'`),
    );
  }

  console.log();
  console.log(`${chalk.cyan("Current tokens:")} ${place.tokenCount}`);
}

/**
 * Generate an example JSON object from a JSON Schema.
 */
function generateExampleFromSchema(schema: Record<string, unknown>): string {
  if (schema.type === "object" && schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const example: Record<string, unknown> = {};

    for (const [key, prop] of Object.entries(props)) {
      example[key] = getExampleValue(prop);
    }

    return JSON.stringify(example);
  }

  if (schema.type === "string") return '"example"';
  if (schema.type === "number" || schema.type === "integer") return "0";
  if (schema.type === "boolean") return "true";
  if (schema.type === "array") return "[]";

  return "{}";
}

/**
 * Get an example value for a schema property.
 */
function getExampleValue(prop: Record<string, unknown>): unknown {
  if (prop.example !== undefined) return prop.example;
  if (prop.default !== undefined) return prop.default;
  if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0)
    return prop.enum[0];

  switch (prop.type) {
    case "string":
      return prop.format === "uri"
        ? "https://example.com"
        : prop.format === "email"
          ? "user@example.com"
          : "string";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

export default inject;
