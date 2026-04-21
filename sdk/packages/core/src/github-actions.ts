/**
 * GitHub Actions YAML → Circuit Breaker Workflow converter.
 *
 * Parses a GitHub Actions workflow YAML file and converts it into
 * a Circuit Breaker Workflow object.
 *
 * - `run:` steps become `circuit` actions executed inside a SmolVM.
 * - `uses:` steps are resolved by fetching the action's `action.yml`
 *   from GitHub, parsing its composite steps, and substituting inputs.
 *   No hardcoded action mappings — any composite action works.
 * - `actions/checkout`, `actions/cache`, artifact actions are skipped
 *   (source is mounted via --volume, caching is handled by overlays).
 *
 * @module
 */

import { parse as parseYAML } from "yaml";
import { workflow as createWorkflow } from "./workflow";
import type { Workflow } from "./schema";
import { resolveAction, type ResolvedStep } from "./action-resolver";

// ============ Types for GitHub Actions YAML ============

/** A single step in a GitHub Actions job. */
interface GHStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  if?: string;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
  "working-directory"?: string;
  id?: string;
  shell?: string;
}

/** A single job in a GitHub Actions workflow. */
interface GHJob {
  "runs-on": string | string[];
  steps: GHStep[];
  needs?: string | string[];
  env?: Record<string, string>;
  "timeout-minutes"?: number;
  name?: string;
  if?: string;
  services?: Record<string, unknown>;
  strategy?: Record<string, unknown>;
}

/** Top-level GitHub Actions workflow structure. */
interface GHWorkflow {
  name?: string;
  on?: unknown;
  env?: Record<string, string>;
  jobs: Record<string, GHJob>;
}

// ============ Result Type ============

/**
 * Result of converting a GitHub Actions workflow.
 * Includes the workflow plus resolved metadata needed for execution.
 */
export interface GitHubActionsWorkflow {
  /** The converted Circuit Breaker workflow. */
  workflow: Workflow;
  /** Resolved OCI images per job, from `runs-on:`. */
  images: Record<string, string>;
  /** `uses:` actions found (for logging/debugging). */
  actions: string[];
}

// ============ Public API ============

/** Options for the conversion. */
export interface ConvertOptions {
  /** Override the workflow name. */
  name?: string;
  /** Source file path (for error messages). */
  filePath?: string;
}

/**
 * Convert a GitHub Actions workflow YAML string into a Circuit Breaker Workflow.
 *
 * This is async because `uses:` steps require fetching action.yml files
 * from GitHub to resolve composite action steps.
 *
 * @param yamlContent - Raw YAML string from a .github/workflows/*.yml file
 * @param options - Conversion options
 * @returns A GitHubActionsWorkflow with the workflow, resolved images, and actions
 */
export async function fromGitHubActions(
  yamlContent: string,
  options: ConvertOptions = {},
): Promise<GitHubActionsWorkflow> {
  const gh: GHWorkflow = parseYAML(yamlContent);

  if (!gh.jobs || Object.keys(gh.jobs).length === 0) {
    throw new Error("GitHub Actions workflow has no jobs");
  }

  const workflowName = slugify(options.name ?? gh.name ?? "gh-workflow");
  const jobEntries = Object.entries(gh.jobs);

  // Resolve images from runs-on
  const images: Record<string, string> = {};
  for (const [jobId, job] of jobEntries) {
    images[jobId] = resolveRunsOnImage(job["runs-on"]);
  }

  // Collect all uses: actions (for logging)
  const actions: string[] = [];
  for (const [, job] of jobEntries) {
    for (const step of job.steps) {
      if (step.uses) {
        actions.push(step.uses);
      }
    }
  }

  // Convert jobs to workflow
  const workflow =
    jobEntries.length === 1
      ? await convertSingleJob(workflowName, jobEntries[0], gh.env)
      : await convertMultiJob(workflowName, jobEntries, gh.env);

  return { workflow, images, actions };
}

/**
 * Parse a GitHub Actions YAML file from disk.
 *
 * @param filePath - Path to the .yml/.yaml file
 * @returns A GitHubActionsWorkflow with workflow, resolved images, and actions
 */
export async function fromGitHubActionsFile(
  filePath: string,
  options: ConvertOptions = {},
): Promise<GitHubActionsWorkflow> {
  const file = Bun.file(filePath);
  const content = await file.text();
  return fromGitHubActions(content, { ...options, filePath });
}

// ============ Single-Job Conversion ============

async function convertSingleJob(
  workflowName: string,
  [jobId, job]: [string, GHJob],
  workflowEnv?: Record<string, string>,
): Promise<Workflow> {
  const image = resolveRunsOnImage(job["runs-on"]);
  const steps = await resolveAllSteps(job.steps);

  if (steps.length === 0) {
    throw new Error(`Job '${jobId}' has no executable steps after resolution.`);
  }

  const builder = createWorkflow(workflowName).namespace("default");

  // Create places: start → step1-done → step2-done → ... → done
  builder.place("start", { initialTokens: 1 });

  const placeIds: string[] = ["start"];
  for (let i = 0; i < steps.length; i++) {
    const placeId = i === steps.length - 1 ? "done" : `${steps[i].id}-done`;
    builder.place(placeId);
    placeIds.push(placeId);
  }

  // Create transitions
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const fromPlace = placeIds[i];
    const toPlace = placeIds[i + 1];

    let tb = builder
      .transition(step.id)
      .from(fromPlace)
      .to(toPlace)
      .circuit(step.run, {
        image,
        shell: step.shell ?? "sh",
        workdir: step.workdir ?? "/workspace",
      });

    // Merge environment: workflow → job → step
    const mergedEnv = {
      ...workflowEnv,
      ...job.env,
      ...step.env,
    };
    if (Object.keys(mergedEnv).length > 0) {
      tb = tb.annotate("env", JSON.stringify(mergedEnv));
    }

    // Timeout
    const timeoutMinutes = step.timeoutMinutes ?? job["timeout-minutes"];
    if (timeoutMinutes) {
      tb = tb.timeout(`${timeoutMinutes}m`);
    }

    // Guard condition
    if (step.condition) {
      tb = tb.guard(step.condition);
    }

    tb.done();
  }

  return builder.build();
}

// ============ Multi-Job Conversion ============

async function convertMultiJob(
  workflowName: string,
  jobEntries: [string, GHJob][],
  workflowEnv?: Record<string, string>,
): Promise<Workflow> {
  const builder = createWorkflow(workflowName).namespace("default");

  builder.place("start", { initialTokens: 1 });

  const jobFinalPlaces: Record<string, string> = {};

  for (const [jobId, job] of jobEntries) {
    const image = resolveRunsOnImage(job["runs-on"]);
    const steps = await resolveAllSteps(job.steps);
    if (steps.length === 0) continue;

    const needs = normalizeNeeds(job.needs);

    // Determine entry place for this job
    let entryPlace: string;
    if (needs.length === 0) {
      entryPlace = "start";
    } else if (needs.length === 1) {
      entryPlace = jobFinalPlaces[needs[0]] ?? "start";
    } else {
      // Fan-in: join place from multiple dependencies
      const joinPlace = `${jobId}-ready`;
      builder.place(joinPlace);

      const joinTransition = builder.transition(`${jobId}-join`);
      for (const dep of needs) {
        const depPlace = jobFinalPlaces[dep];
        if (depPlace) {
          joinTransition.from(depPlace);
        }
      }
      joinTransition.to(joinPlace).noop().done();
      entryPlace = joinPlace;
    }

    // Create places and transitions for this job's steps
    const placeIds: string[] = [entryPlace];
    for (let i = 0; i < steps.length; i++) {
      const placeId =
        i === steps.length - 1
          ? `${jobId}-done`
          : `${jobId}-${steps[i].id}-done`;
      builder.place(placeId);
      placeIds.push(placeId);
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const transitionId = `${jobId}-${step.id}`;
      const fromPlace = placeIds[i];
      const toPlace = placeIds[i + 1];

      let tb = builder
        .transition(transitionId)
        .from(fromPlace)
        .to(toPlace)
        .circuit(step.run, {
          image,
          shell: step.shell ?? "sh",
          workdir: step.workdir ?? "/workspace",
        });

      const mergedEnv = {
        ...workflowEnv,
        ...job.env,
        ...step.env,
      };
      if (Object.keys(mergedEnv).length > 0) {
        tb = tb.annotate("env", JSON.stringify(mergedEnv));
      }

      const timeoutMinutes = step.timeoutMinutes ?? job["timeout-minutes"];
      if (timeoutMinutes) {
        tb = tb.timeout(`${timeoutMinutes}m`);
      }

      if (step.condition) {
        tb = tb.guard(step.condition);
      }

      tb.done();
    }

    jobFinalPlaces[jobId] = placeIds[placeIds.length - 1];
  }

  return builder.build();
}

// ============ Step Resolution ============

/** A normalized step ready for conversion to a transition. */
interface NormalizedStep {
  id: string;
  run: string;
  env?: Record<string, string>;
  condition?: string;
  continueOnError?: boolean;
  timeoutMinutes?: number;
  shell?: string;
  workdir?: string;
}

/**
 * Resolve all steps in a job — both `run:` and `uses:` — into
 * normalized shell commands.
 *
 * `run:` steps pass through directly.
 * `uses:` steps are resolved by fetching the action's action.yml,
 * parsing its composite steps, and substituting input variables.
 * Skippable actions (checkout, cache) return nothing.
 */
async function resolveAllSteps(steps: GHStep[]): Promise<NormalizedStep[]> {
  const result: NormalizedStep[] = [];
  let stepIndex = 0;

  for (const step of steps) {
    if (step.run) {
      // run: step — use the command directly
      const id =
        step.id ?? (step.name ? slugify(step.name) : `step-${stepIndex}`);

      result.push({
        id,
        run: step.run.trim(),
        env: step.env,
        condition: step.if,
        continueOnError: step["continue-on-error"],
        timeoutMinutes: step["timeout-minutes"],
        shell: step.shell,
        workdir: step["working-directory"],
      });

      stepIndex++;
    } else if (step.uses) {
      // uses: step — resolve by fetching the action's action.yml
      const resolved = await resolveAction(step.uses, step.with);

      if (resolved) {
        // A composite action may produce multiple shell steps.
        // Concatenate them into a single command with && chaining
        // so they execute atomically as one transition.
        const combinedCommand = resolved
          .map((r) => r.run.trim())
          .filter((cmd) => cmd.length > 0)
          .join(" && ");

        if (combinedCommand.length > 0) {
          const id =
            step.id ?? (step.name ? slugify(step.name) : slugify(step.uses));

          // Merge env from all resolved steps
          const combinedEnv: Record<string, string> = {};
          for (const r of resolved) {
            if (r.env) {
              Object.assign(combinedEnv, r.env);
            }
          }
          // Also include env from the workflow step's own env
          if (step.env) {
            Object.assign(combinedEnv, step.env);
          }

          result.push({
            id,
            run: combinedCommand,
            env: Object.keys(combinedEnv).length > 0 ? combinedEnv : undefined,
            condition: step.if,
            continueOnError: step["continue-on-error"],
            timeoutMinutes: step["timeout-minutes"],
            shell: "bash",
            workdir: step["working-directory"],
          });

          stepIndex++;
        }
      }
      // If resolveAction returned null, the action is skipped (checkout, cache, etc.)
    }
  }

  return result;
}

// ============ Helpers ============

/**
 * Map GitHub `runs-on` to an OCI image.
 * This is just the base image — toolchain setup happens via `uses:` steps
 * resolved from the actual action.yml files.
 */
function resolveRunsOnImage(runsOn: string | string[]): string {
  const label = Array.isArray(runsOn) ? runsOn[0] : runsOn;

  const imageMap: Record<string, string> = {
    "ubuntu-latest": "ubuntu:24.04",
    "ubuntu-24.04": "ubuntu:24.04",
    "ubuntu-22.04": "ubuntu:22.04",
    "ubuntu-20.04": "ubuntu:20.04",
  };

  return imageMap[label] ?? label;
}

/** Normalize `needs` to an array. */
function normalizeNeeds(needs: string | string[] | undefined): string[] {
  if (!needs) return [];
  if (typeof needs === "string") return [needs];
  return needs;
}

/** Convert a string to a DNS-compatible slug. */
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 63) || "workflow"
  );
}
