/**
 * Submit command - submits a workflow definition to the Circuit Breaker API.
 *
 * @module
 */

import { parseArgs } from 'util';
import { resolve, extname } from 'path';
import { WorkflowSchema, type Workflow } from '@circuit-breaker/core';
import { CircuitBreakerClient } from '@circuit-breaker/core';
import { validateWorkflow } from '@circuit-breaker/core';
import { s } from "../lib/symbols";

interface SubmitOptions {
  /** Watch for completion after submit */
  watch: boolean;
  /** Run immediately after submit */
  run: boolean;
  /** Namespace to submit to */
  namespace?: string;
  /** API endpoint URL */
  api?: string;
  /** Output format */
  format: 'text' | 'json';
  /** Dry run - validate only, don't submit */
  dryRun: boolean;
  /** Input parameters (JSON string) */
  inputs?: string;
}

/**
 * Parse command line arguments for submit command.
 */
export function parseSubmitArgs(args: string[]): { workflowPath: string; options: SubmitOptions } {
  const { values, positionals } = parseArgs({
    args,
    options: {
      watch: {
        type: 'boolean',
        short: 'w',
        default: false,
      },
      run: {
        type: 'boolean',
        short: 'r',
        default: false,
      },
      namespace: {
        type: 'string',
        short: 'n',
      },
      api: {
        type: 'string',
        short: 'a',
      },
      format: {
        type: 'string',
        short: 'f',
        default: 'text',
      },
      'dry-run': {
        type: 'boolean',
        default: false,
      },
      inputs: {
        type: 'string',
        short: 'i',
      },
    },
    allowPositionals: true,
  });

  if (positionals.length === 0) {
    throw new Error('Missing required argument: workflow file path');
  }

  return {
    workflowPath: positionals[0]!,
    options: {
      watch: values.watch ?? false,
      run: values.run ?? false,
      namespace: values.namespace,
      api: values.api,
      format: (values.format as 'text' | 'json') ?? 'text',
      dryRun: values['dry-run'] ?? false,
      inputs: values.inputs,
    },
  };
}

/**
 * Load a workflow from a TypeScript or JSON file.
 */
async function loadWorkflow(filePath: string): Promise<Workflow> {
  const absolutePath = resolve(process.cwd(), filePath);
  const ext = extname(filePath).toLowerCase();

  if (ext === '.json') {
    // Load JSON file directly
    const file = Bun.file(absolutePath);
    const content = await file.json();
    return WorkflowSchema.parse(content);
  }

  if (ext === '.ts' || ext === '.js' || ext === '.mts' || ext === '.mjs') {
    // Import TypeScript/JavaScript module
    const module = await import(absolutePath);

    // Support both default export and named 'workflow' export
    const workflow = module.default ?? module.workflow;

    if (!workflow) {
      throw new Error(
        `No workflow found in ${filePath}. Export your workflow as default or named 'workflow'.`
      );
    }

    // If it's a WorkflowBuilder, call build()
    if (typeof workflow.build === 'function') {
      return workflow.build();
    }

    // Otherwise assume it's already a Workflow object
    return WorkflowSchema.parse(workflow);
  }

  throw new Error(`Unsupported file extension: ${ext}. Use .ts, .js, or .json`);
}

/**
 * Format output based on format option.
 */
function formatOutput(data: Record<string, unknown>, format: 'text' | 'json'): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  // Text format
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

/**
 * Print workflow validation results.
 */
function printValidation(workflow: Workflow, format: 'text' | 'json'): boolean {
  const result = validateWorkflow(workflow);

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return result.valid;
  }

  if (result.valid) {
    console.log(`${s.check} Workflow is valid`);
    console.log(`  Name: ${workflow.name}`);
    console.log(`  Namespace: ${workflow.namespace}`);
    console.log(`  Places: ${workflow.places.length}`);
    console.log(`  Transitions: ${workflow.transitions.length}`);
  } else {
    console.error(`${s.cross} Workflow validation failed:`);
    for (const error of result.errors) {
      console.error(`  - [${error.code}] ${error.message}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) {
      console.log(`  - [${warning.code}] ${warning.message}`);
    }
  }

  return result.valid;
}

/**
 * Execute the submit command.
 */
export async function submitCommand(args: string[]): Promise<void> {
  const { workflowPath, options } = parseSubmitArgs(args);

  console.log(`Loading workflow from ${workflowPath}...`);

  // Load the workflow
  let workflow: Workflow;
  try {
    workflow = await loadWorkflow(workflowPath);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Failed to load workflow: ${error.message}`);
    }
    process.exit(1);
  }

  // Override namespace if provided
  if (options.namespace) {
    workflow = { ...workflow, namespace: options.namespace };
  }

  // Validate
  const isValid = printValidation(workflow, options.format);
  if (!isValid) {
    process.exit(1);
  }

  // Dry run - stop here
  if (options.dryRun) {
    console.log('\nDry run complete. Workflow was not submitted.');
    return;
  }

  // Create client and submit
  const client = new CircuitBreakerClient({
    baseUrl: options.api,
  });

  try {
    console.log('\nSubmitting workflow...');
    const submitResult = await client.submitWorkflow(workflow);

    console.log(
      formatOutput(
        {
          status: 'submitted',
          workflowId: submitResult.workflowId,
          name: submitResult.name,
          namespace: submitResult.namespace,
          createdAt: submitResult.createdAt,
        },
        options.format
      )
    );

    // Run if requested
    if (options.run) {
      console.log('\nStarting workflow run...');

      let inputs: Record<string, unknown> | undefined;
      if (options.inputs) {
        try {
          inputs = JSON.parse(options.inputs);
        } catch {
          console.error('Failed to parse inputs JSON');
          process.exit(1);
        }
      }

      const runResult = await client.runWorkflow(submitResult.workflowId, { inputs });

      console.log(
        formatOutput(
          {
            status: 'running',
            runId: runResult.runId,
            workflowId: runResult.workflowId,
            startedAt: runResult.startedAt,
          },
          options.format
        )
      );

      // Watch if requested
      if (options.watch) {
        console.log('\nWatching for completion...\n');

        for await (const status of client.watchRun(runResult.runId)) {
          const timestamp = new Date().toISOString();
          console.log(`[${timestamp}] Status: ${status.status}`);

          // Show transition states
          for (const t of status.transitions) {
            if (t.status !== 'pending') {
              console.log(`  - ${t.transitionId}: ${t.status}`);
            }
          }

          if (status.status === 'completed') {
            console.log('\n' + s.check + ' Workflow completed successfully');
            break;
          } else if (status.status === 'failed') {
            console.error('\n' + s.cross + ' Workflow failed');
            if (status.error) {
              console.error(`  Error: ${status.error.message}`);
            }
            process.exit(1);
          } else if (status.status === 'cancelled') {
            console.log('\n' + s.skip + ' Workflow was cancelled');
            break;
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`API error: ${error.message}`);
    }
    process.exit(1);
  }
}

export default submitCommand;
