/**
 * Run command - submits and immediately executes a workflow.
 *
 * @module
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolve, extname } from 'path';
import {
import { s } from "../lib/symbols";
  WorkflowSchema,
  CircuitBreakerClient,
  validateWorkflow,
  type Workflow,
} from '@circuit-breaker/core';

/**
 * Load a workflow from a TypeScript or JSON file.
 */
async function loadWorkflow(filePath: string): Promise<Workflow> {
  const absolutePath = resolve(process.cwd(), filePath);
  const ext = extname(filePath).toLowerCase();

  if (ext === '.json') {
    const file = Bun.file(absolutePath);
    const content = await file.json();
    return WorkflowSchema.parse(content);
  }

  if (ext === '.ts' || ext === '.js' || ext === '.mts' || ext === '.mjs') {
    const module = await import(absolutePath);
    const workflow = module.default ?? module.workflow;

    if (!workflow) {
      throw new Error(
        `No workflow found in ${filePath}. Export your workflow as default or named 'workflow'.`
      );
    }

    if (typeof workflow.build === 'function') {
      return workflow.build();
    }

    return WorkflowSchema.parse(workflow);
  }

  throw new Error(`Unsupported file extension: ${ext}. Use .ts, .js, or .json`);
}

/**
 * Parse input parameters from CLI options.
 */
async function parseInputs(
  inputJson?: string,
  inputFile?: string
): Promise<Record<string, unknown> | undefined> {
  if (inputJson) {
    try {
      return JSON.parse(inputJson);
    } catch {
      throw new Error('Failed to parse --input JSON');
    }
  }

  if (inputFile) {
    const file = Bun.file(resolve(process.cwd(), inputFile));
    return file.json();
  }

  return undefined;
}

/**
 * Parse labels from CLI format (key=value) to object.
 */
function parseLabels(labels?: string[]): Record<string, string> | undefined {
  if (!labels || labels.length === 0) return undefined;

  const result: Record<string, string> = {};
  for (const label of labels) {
    const [key, ...valueParts] = label.split('=');
    if (key && valueParts.length > 0) {
      result[key] = valueParts.join('=');
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Execute the run command.
 */
export async function run(
  workflowPath: string,
  options: {
    watch?: boolean;
    input?: string;
    inputFile?: string;
    label?: string[];
  },
  command: Command
): Promise<void> {
  const globalOpts = command.optsWithGlobals();
  const spinner = ora();

  try {
    // Load workflow
    spinner.start(`Loading workflow from ${chalk.cyan(workflowPath)}...`);
    const workflow = await loadWorkflow(workflowPath);
    spinner.succeed(`Loaded workflow: ${chalk.bold(workflow.name)}`);

    // Validate
    spinner.start('Validating workflow...');
    const validation = validateWorkflow(workflow);

    if (!validation.valid) {
      spinner.fail('Workflow validation failed');
      for (const error of validation.errors) {
        console.error(chalk.red(`  ${s.cross} [${error.code}] ${error.message}`));
      }
      process.exit(1);
    }
    spinner.succeed('Workflow is valid');

    // Show warnings
    if (validation.warnings.length > 0) {
      console.log(chalk.yellow('\nWarnings:'));
      for (const warning of validation.warnings) {
        console.log(chalk.yellow(`  ${s.warn} [${warning.code}] ${warning.message}`));
      }
    }

    // Parse inputs and labels
    const inputs = await parseInputs(options.input, options.inputFile);
    const labels = parseLabels(options.label);

    // Create client
    const client = new CircuitBreakerClient({
      baseUrl: globalOpts.apiUrl,
      apiKey: globalOpts.apiKey,
    });

    // Submit workflow
    spinner.start('Submitting workflow...');
    const submitResult = await client.submitWorkflow(workflow);
    spinner.succeed(`Submitted workflow: ${chalk.cyan(submitResult.workflowId)}`);

    // Start run
    spinner.start('Starting workflow run...');
    const runResult = await client.runWorkflow(submitResult.workflowId, {
      inputs,
      labels,
    });
    spinner.succeed(`Started run: ${chalk.cyan(runResult.runId)}`);

    console.log('\n' + chalk.dim('-'.repeat(50)));
    console.log(`  ${chalk.bold('Run ID:')}      ${runResult.runId}`);
    console.log(`  ${chalk.bold('Workflow:')}    ${workflow.name}`);
    console.log(`  ${chalk.bold('Namespace:')}   ${workflow.namespace}`);
    console.log(`  ${chalk.bold('Status:')}      ${chalk.blue(runResult.status)}`);
    console.log(`  ${chalk.bold('Started At:')}  ${runResult.startedAt}`);
    console.log(chalk.dim('-'.repeat(50)) + '\n');

    // Watch if requested
    if (options.watch) {
      console.log(chalk.dim('Watching for updates... (Ctrl+C to stop)\n'));

      let lastStatus = '';
      for await (const status of client.watchRun(runResult.runId)) {
        // Only log when status changes
        if (status.status !== lastStatus) {
          const timestamp = new Date().toLocaleTimeString();
          const statusColor =
            status.status === 'completed'
              ? chalk.green
              : status.status === 'failed'
                ? chalk.red
                : status.status === 'running'
                  ? chalk.blue
                  : chalk.yellow;

          console.log(`[${chalk.dim(timestamp)}] Status: ${statusColor(status.status)}`);

          // Log transition updates
          for (const t of status.transitions) {
            if (t.status === 'firing') {
              console.log(`  ${chalk.yellow(s.play)} ${t.transitionId}: executing...`);
            } else if (t.status === 'completed') {
              console.log(`  ${chalk.green(s.check)} ${t.transitionId}: completed`);
            } else if (t.status === 'failed') {
              console.log(`  ${chalk.red(s.cross)} ${t.transitionId}: failed`);
            }
          }

          lastStatus = status.status;
        }

        // Handle terminal states
        if (status.status === 'completed') {
          console.log(chalk.green(`\n${s.check} Workflow completed successfully`));
          if (status.currentMarking) {
            console.log(chalk.dim('\nFinal marking:'));
            for (const [place, tokens] of Object.entries(status.currentMarking)) {
              if (tokens > 0) {
                console.log(`  ${place}: ${tokens} token(s)`);
              }
            }
          }
          return;
        }

        if (status.status === 'failed') {
          console.log(chalk.red(`\n${s.cross} Workflow failed`));
          if (status.error) {
            console.error(chalk.red(`  Error: ${status.error.message}`));
            if (status.error.transition) {
              console.error(chalk.red(`  Failed transition: ${status.error.transition}`));
            }
          }
          process.exit(1);
        }

        if (status.status === 'cancelled') {
          console.log(chalk.yellow(`\n${s.skip} Workflow was cancelled`));
          return;
        }
      }
    } else {
      console.log(chalk.dim(`Use ${chalk.cyan(`cb status ${runResult.runId}`)} to check progress`));
      console.log(
        chalk.dim(`Use ${chalk.cyan(`cb logs ${runResult.runId}`)} to view execution logs`)
      );
    }
  } catch (error) {
    spinner.fail('Command failed');
    if (error instanceof Error) {
      console.error(chalk.red(`Error: ${error.message}`));
      if (globalOpts.verbose) {
        console.error(chalk.dim(error.stack));
      }
    }
    process.exit(1);
  }
}

export default run;
