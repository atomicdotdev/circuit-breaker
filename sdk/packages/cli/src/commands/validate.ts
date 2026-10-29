/**
 * Validate command - validates a workflow definition without submitting.
 *
 * @module
 */

import { resolve, extname } from 'path';
import chalk from 'chalk';
import { WorkflowSchema, validateWorkflow, visualize, type Workflow } from '@circuit-breaker/core';
import { s } from "../lib/symbols";

interface ValidateOptions {
  strict?: boolean;
  checkDeadlocks?: boolean;
  checkReachability?: boolean;
}

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
 * Execute the validate command.
 */
export async function validate(workflowPath: string, options: ValidateOptions): Promise<void> {
  console.log(chalk.blue(`Validating workflow: ${workflowPath}\n`));

  // Load the workflow
  let workflow: Workflow;
  try {
    workflow = await loadWorkflow(workflowPath);
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`${s.cross} Failed to load workflow: ${error.message}`));
    }
    process.exit(1);
  }

  // Run validation
  const result = validateWorkflow(workflow, {
    strict: options.strict,
    checkDeadlocks: options.checkDeadlocks ?? true,
    checkReachability: options.checkReachability ?? true,
  });

  // Print workflow summary
  console.log(chalk.bold('Workflow Summary:'));
  console.log(`  Name:        ${workflow.name}`);
  console.log(`  Namespace:   ${workflow.namespace}`);
  console.log(`  Places:      ${workflow.places.length}`);
  console.log(`  Transitions: ${workflow.transitions.length}`);

  // Initial marking
  const initialPlaces = workflow.places.filter((p) => p.initialTokens > 0);
  if (initialPlaces.length > 0) {
    console.log(`  Initial:     ${initialPlaces.map((p) => `${p.id}(${p.initialTokens})`).join(', ')}`);
  }

  console.log('');

  // Print validation results
  if (result.valid) {
    console.log(chalk.green(`${s.check} Workflow is valid\n`));
  } else {
    console.log(chalk.red(`${s.cross} Workflow validation failed\n`));
  }

  // Print errors
  if (result.errors.length > 0) {
    console.log(chalk.red.bold('Errors:'));
    for (const error of result.errors) {
      console.log(chalk.red(`  • [${error.code}] ${error.message}`));
      if (error.details) {
        console.log(chalk.gray(`    ${JSON.stringify(error.details)}`));
      }
    }
    console.log('');
  }

  // Print warnings
  if (result.warnings.length > 0) {
    console.log(chalk.yellow.bold('Warnings:'));
    for (const warning of result.warnings) {
      console.log(chalk.yellow(`  • [${warning.code}] ${warning.message}`));
      if (warning.details) {
        console.log(chalk.gray(`    ${JSON.stringify(warning.details)}`));
      }
    }
    console.log('');
  }

  // Print structure analysis
  console.log(chalk.bold('Structure Analysis:'));

  // Places with no inputs (source places)
  const sourcePlaces = workflow.places.filter((p) => {
    return !workflow.transitions.some((t) => t.outputs.some((o) => o.place === p.id));
  });
  if (sourcePlaces.length > 0) {
    console.log(`  Source places:   ${sourcePlaces.map((p) => p.id).join(', ')}`);
  }

  // Places with no outputs (sink places)
  const sinkPlaces = workflow.places.filter((p) => {
    return !workflow.transitions.some((t) => t.inputs.some((i) => i.place === p.id));
  });
  if (sinkPlaces.length > 0) {
    console.log(`  Sink places:     ${sinkPlaces.map((p) => p.id).join(', ')}`);
  }

  // AND-joins (transitions with multiple inputs)
  const andJoins = workflow.transitions.filter((t) => t.inputs.length > 1);
  if (andJoins.length > 0) {
    console.log(`  AND-joins:       ${andJoins.map((t) => t.id).join(', ')}`);
  }

  // AND-splits (transitions with multiple outputs)
  const andSplits = workflow.transitions.filter((t) => t.outputs.length > 1);
  if (andSplits.length > 0) {
    console.log(`  AND-splits:      ${andSplits.map((t) => t.id).join(', ')}`);
  }

  // Transitions with guards
  const guarded = workflow.transitions.filter((t) => t.guard);
  if (guarded.length > 0) {
    console.log(`  Guarded:         ${guarded.map((t) => t.id).join(', ')}`);
  }

  console.log('');

  // Exit with error code if validation failed
  if (!result.valid) {
    process.exit(1);
  }
}

export default validate;
