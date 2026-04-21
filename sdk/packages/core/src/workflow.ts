/**
 * Fluent workflow builder API for Circuit Breaker.
 *
 * Provides a type-safe, ergonomic way to define Petri-net workflows.
 *
 * @example
 * ```ts
 * import { workflow } from '@circuit-breaker/core';
 *
 * const myWorkflow = workflow('ci-pipeline')
 *   .place('source', { initialTokens: 1 })
 *   .place('built')
 *   .place('deployed')
 *
 *   .transition('build')
 *     .from('source')
 *     .to('built')
 *     .dagger('./ci', 'build')
 *     .done()
 *
 *   .transition('deploy')
 *     .from('built')
 *     .to('deployed')
 *     .guard('ctx.branch == "main"')
 *     .dagger('./ci', 'deploy')
 *     .policy('./policies/deploy')
 *     .done()
 *
 *   .build();
 * ```
 *
 * @module
 */

import {
  WorkflowSchema,
  type Workflow,
  type Place,
  type Transition,
  type Arc,
  type Action,
  type Resources,
  type Metadata,
  type PolicyGate,
  type EngineConfig,
  type EngineRequirements,
  type EngineMode,
} from "./schema";

import { type OpenCodeTaskBuilder, OPENCODE_IMAGE } from "./opencode";

/**
 * Task action definition for container-based tasks.
 */
export interface TaskAction {
  type: "container";
  image: string;
  command: string[];
  env?: Record<string, string>;
  workdir?: string;
}

/**
 * Create a new workflow builder.
 *
 * @param name - Workflow name (must be DNS-compatible: lowercase, hyphens, 2-63 chars)
 * @returns A new WorkflowBuilder instance
 */
export function workflow(name: string): WorkflowBuilder {
  return new WorkflowBuilder(name);
}

/**
 * Options for creating a place.
 */
export interface PlaceOptions {
  /** Initial number of tokens in this place */
  initialTokens?: number;
  /** Maximum token capacity (null = unlimited) */
  capacity?: number | null;
  /** JSON Schema for typed tokens (colored Petri nets) */
  tokenSchema?: Record<string, unknown>;
  /**
   * Arbitrary key-value annotations attached to this place.
   *
   * Used by Sherpa and other consumers to attach metadata directly to
   * the place definition — tool availability, prompt keys, HITL flags,
   * or any other consumer-specific metadata.
   *
   * @example
   * // Sherpa workflow annotations
   * annotations: {
   *   "sherpa.tools":  "read_only",  // "none" | "read_only" | "read_and_todo" | "all" | "read_and_write"
   *   "sherpa.prompt": "casing",     // prompt key looked up in the engine's prompt registry
   *   "sherpa.hitl":   "false",      // "true" = LLM paused, waiting for human input
   * }
   */
  annotations?: Record<string, string>;
}

/**
 * Fluent builder for constructing Circuit Breaker workflows.
 */
export class WorkflowBuilder {
  private _workflow: {
    version: "1.0";
    name: string;
    namespace: string;
    metadata?: Metadata;
    engine?: EngineConfig;
    places: Place[];
    transitions: Transition[];
  };

  constructor(name: string) {
    this._workflow = {
      version: "1.0",
      name,
      namespace: "default",
      places: [],
      transitions: [],
    };
  }

  /**
   * Set the default engine configuration for all transitions.
   * Individual transitions can override this.
   *
   * @example
   * ```ts
   * workflow('my-pipeline')
   *   .engine('auto', { memoryGb: 8 })
   *   // ... transitions inherit this config
   * ```
   */
  engine(mode: EngineMode, requirements?: Partial<EngineRequirements>): this {
    this._workflow.engine = {
      mode,
      requirements: requirements as EngineRequirements,
    };
    return this;
  }

  /**
   * Configure for local-only execution (development mode).
   * Uses local Dagger installation, no cloud fallback.
   */
  localOnly(): this {
    return this.engine("local");
  }

  /**
   * Configure for cloud-only execution (production mode).
   * All transitions run via Engine Service with audit trail.
   */
  cloudOnly(requirements?: Partial<EngineRequirements>): this {
    return this.engine("cloud", { requireAudit: true, ...requirements });
  }

  /**
   * Configure for auto mode with GPU requirement.
   * Forces cloud execution for GPU workloads.
   */
  withGpu(memoryGb?: number): this {
    return this.engine("auto", { gpu: true, memoryGb });
  }

  /**
   * Set the namespace for multi-tenancy.
   */
  namespace(ns: string): this {
    this._workflow.namespace = ns;
    return this;
  }

  /**
   * Set a description for the workflow.
   */
  description(desc: string): this {
    this._workflow.metadata = {
      ...this._workflow.metadata,
      description: desc,
    };
    return this;
  }

  /**
   * Set labels for filtering and organization.
   */
  labels(labels: Record<string, string>): this {
    this._workflow.metadata = {
      ...this._workflow.metadata,
      labels,
    };
    return this;
  }

  /**
   * Set arbitrary annotations.
   */
  annotations(annotations: Record<string, string>): this {
    this._workflow.metadata = {
      ...this._workflow.metadata,
      annotations,
    };
    return this;
  }

  /**
   * Add a place (state) to the Petri net.
   *
   * @param id - Unique identifier for the place
   * @param options - Place configuration options
   */
  place(id: string, options: PlaceOptions = {}): this {
    this._workflow.places.push({
      id,
      initialTokens: options.initialTokens ?? 0,
      capacity: options.capacity ?? null,
      tokenSchema: options.tokenSchema,
      annotations: options.annotations,
    });
    return this;
  }

  /**
   * Start building a transition (action).
   *
   * @param id - Unique identifier for the transition
   * @returns A TransitionBuilder to configure the transition
   */
  transition(id: string): TransitionBuilder {
    return new TransitionBuilder(this, id);
  }

  /**
   * Internal method to add a completed transition.
   * @internal
   */
  _addTransition(transition: Transition): void {
    this._workflow.transitions.push(transition);
  }

  /**
   * Validate and build the workflow.
   *
   * @returns The validated Workflow object
   * @throws {z.ZodError} If validation fails
   */
  build(): Workflow {
    return WorkflowSchema.parse(this._workflow);
  }

  /**
   * Attempt to build the workflow, returning errors instead of throwing.
   *
   * @returns Object with success status and data or error
   */
  safeBuild():
    | { success: true; data: Workflow }
    | { success: false; error: Error } {
    const result = WorkflowSchema.safeParse(this._workflow);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: result.error };
  }

  /**
   * Serialize the workflow to JSON.
   *
   * @param pretty - Whether to format with indentation (default: true)
   */
  toJSON(pretty = true): string {
    const workflow = this.build();
    return JSON.stringify(workflow, null, pretty ? 2 : undefined);
  }

  /**
   * Get the current workflow state (for debugging).
   */
  inspect(): Readonly<typeof this._workflow> {
    return this._workflow;
  }
}

/**
 * Fluent builder for configuring a single transition.
 */
export class TransitionBuilder {
  private _transition: {
    id: string;
    inputs: Arc[];
    outputs: Arc[];
    guard?: string;
    action?: Action;
    policy?: PolicyGate;
    resources?: Resources;
    engine?: EngineConfig;
    timeout: string;
    retries: number;
    retryBackoff: "fixed" | "exponential";
    priority: number;
    annotations?: Record<string, string>;
  };

  constructor(
    private parent: WorkflowBuilder,
    id: string,
  ) {
    this._transition = {
      id,
      inputs: [],
      outputs: [],
      timeout: "5m",
      retries: 0,
      retryBackoff: "exponential",
      priority: 50,
    };
  }

  /**
   * Attach arbitrary key-value annotations to this transition.
   *
   * Used by Sherpa to describe HITL actions to the frontend:
   *   - `sherpa.label`   — human-readable button label (e.g. "Accept plan")
   *   - `sherpa.variant` — button style: "primary" | "danger" | "ghost"
   *
   * Other consumers can use any keys they need.
   *
   * @example
   * .transition("accept")
   *   .from("human_gate").to("executing")
   *   .annotate({ "sherpa.label": "Accept plan", "sherpa.variant": "primary" })
   *   .noop()
   *   .done()
   */
  annotate(annotations: Record<string, string>): this {
    this._transition.annotations = {
      ...this._transition.annotations,
      ...annotations,
    };
    return this;
  }

  /**
   * Define input places (where tokens are consumed from).
   *
   * @param places - One or more place IDs
   */
  from(...places: string[]): this {
    this._transition.inputs = places.map((place) => ({ place, weight: 1 }));
    return this;
  }

  /**
   * Define input places with custom weights.
   *
   * @param arcs - Array of arc definitions with place and optional weight
   */
  fromArcs(
    arcs: Array<{ place: string; weight?: number; expression?: string }>,
  ): this {
    this._transition.inputs = arcs.map((arc) => ({
      place: arc.place,
      weight: arc.weight ?? 1,
      expression: arc.expression,
    }));
    return this;
  }

  /**
   * Define output places (where tokens are produced to).
   *
   * @param places - One or more place IDs
   */
  to(...places: string[]): this {
    this._transition.outputs = places.map((place) => ({ place, weight: 1 }));
    return this;
  }

  /**
   * Define output places with custom weights.
   *
   * @param arcs - Array of arc definitions with place and optional weight
   */
  toArcs(
    arcs: Array<{ place: string; weight?: number; expression?: string }>,
  ): this {
    this._transition.outputs = arcs.map((arc) => ({
      place: arc.place,
      weight: arc.weight ?? 1,
      expression: arc.expression,
    }));
    return this;
  }

  /**
   * Set a guard condition (CEL expression).
   * The transition will only fire if the guard evaluates to true.
   *
   * @param expression - CEL expression (e.g., 'ctx.branch == "main"')
   */
  guard(expression: string): this {
    this._transition.guard = expression;
    return this;
  }

  /**
   * Configure the transition to execute a Dagger pipeline.
   *
   * @param module - Path to Dagger module (e.g., './ci' or 'github.com/org/repo/ci')
   * @param fn - Optional function name to call
   * @param args - Optional arguments to pass
   */
  dagger(module: string, fn?: string, args?: Record<string, unknown>): this {
    this._transition.action = {
      type: "dagger",
      module,
      function: fn,
      args,
      cache: true,
    };
    return this;
  }

  /**
   * Configure the transition to execute a Dagger pipeline with full options.
   */
  daggerAction(config: {
    module: string;
    function?: string;
    args?: Record<string, unknown>;
    image?: string;
    cache?: boolean;
  }): this {
    this._transition.action = {
      type: "dagger",
      ...config,
      cache: config.cache ?? true,
    };
    return this;
  }

  /**
   * Configure the transition to make an HTTP request.
   */
  http(
    url: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      headers?: Record<string, string>;
      body?: string;
      expectedStatus?: number[];
    } = {},
  ): this {
    this._transition.action = {
      type: "http",
      url,
      method: options.method ?? "POST",
      headers: options.headers,
      body: options.body,
      expectedStatus: options.expectedStatus ?? [200, 201, 202, 204],
    };
    return this;
  }

  /**
   * Configure the transition to run an inline script.
   *
   * @param code - Script code to execute
   * @param runtime - Runtime to use (default: 'bun')
   */
  script(code: string, runtime: "bun" | "deno" | "node" = "bun"): this {
    this._transition.action = {
      type: "script",
      runtime,
      code,
    };
    return this;
  }

  /**
   * Configure the transition to run a script from a file.
   *
   * @param file - Path to script file
   * @param runtime - Runtime to use (default: 'bun')
   */
  scriptFile(file: string, runtime: "bun" | "deno" | "node" = "bun"): this {
    this._transition.action = {
      type: "script",
      runtime,
      file,
    };
    return this;
  }

  /**
   * Configure the transition to run a shell command inside a SmolVM.
   *
   * @param command - Shell command to execute inside the VM
   * @param options - Optional image, shell, and workdir overrides
   */
  circuit(
    command: string,
    options?: { image?: string; shell?: string; workdir?: string },
  ): this {
    this._transition.action = {
      type: "circuit" as any,
      command,
      image: options?.image,
      shell: options?.shell ?? "sh",
      workdir: options?.workdir ?? "/workspace",
    };
    return this;
  }

  /**
   * Configure as a no-op transition (for synchronization points like fan-in joins).
   */
  noop(): this {
    this._transition.action = { type: "noop" };
    return this;
  }

  /**
   * Configure the transition to run an OpenCode AI agent task.
   *
   * OpenCode is an open-source AI coding agent that can perform code generation,
   * review, refactoring, and more. This method allows you to integrate AI-powered
   * tasks directly into your workflow pipelines.
   *
   * @param task - OpenCode task builder configured with prompt and options
   *
   * @example
   * // AI-powered code review
   * import { opencode } from '@circuit-breaker/core/opencode';
   *
   * .transition('review')
   *   .from('source').to('reviewed')
   *   .opencode(opencode("Review this code for security issues")
   *     .plan()
   *     .files("src/auth.ts"))
   *   .done()
   *
   * @example
   * // AI-powered bug fix
   * import { opencode } from '@circuit-breaker/core/opencode';
   *
   * .transition('fix')
   *   .from('reviewed').to('fixed')
   *   .opencode(opencode("Fix the authentication bypass vulnerability")
   *     .model("anthropic", "claude-sonnet-4-20250514")
   *     .autoApprove())
   *   .done()
   *
   * @example
   * // Using preset tasks
   * import { OpenCodeTasks } from '@circuit-breaker/core/opencode';
   *
   * .transition('add-tests')
   *   .from('fixed').to('tested')
   *       .opencode(OpenCodeTasks.addTests(["src/**‍/*.ts"], "vitest")))
   *   .done()
   */
  opencode(task: OpenCodeTaskBuilder): this {
    const taskAction = task.toAction();
    this._transition.action = {
      type: "dagger",
      module: "opencode",
      image: taskAction.image,
      args: {
        command: taskAction.command,
        env: taskAction.env,
        workdir: taskAction.workdir,
      },
      cache: false, // AI tasks should not be cached
    };
    return this;
  }

  /**
   * Configure the transition to run a container-based task.
   *
   * @param image - Container image to run
   * @param command - Command to execute
   * @param options - Additional container options
   */
  container(
    image: string,
    command: string[],
    options?: {
      env?: Record<string, string>;
      workdir?: string;
    },
  ): this {
    this._transition.action = {
      type: "dagger",
      module: "container",
      image,
      args: {
        command,
        env: options?.env,
        workdir: options?.workdir,
      },
      cache: true,
    };
    return this;
  }

  /**
   * Set a custom action directly.
   */
  action(action: Action): this {
    this._transition.action = action;
    return this;
  }

  /**
   * Add a policy gate to validate action outputs.
   * Runs conftest with the specified policies against the action's output.
   *
   * Policy is a special Dagger mini-pipeline that runs conftest/OPA
   * to validate the outputs from the previous dagger step.
   *
   * @param path - Path to policy directory containing .rego files
   * @param options - Optional policy configuration
   *
   * @example
   * // Simple usage - validate trivy scan results
   * .transition('security-scan')
   *   .from('source').to('scanned')
   *   .dagger('./pipelines/trivy', 'scan')
   *   .policy('./policies/security')
   *   .done()
   *
   * @example
   * // With custom query
   * .transition('coverage-check')
   *   .from('source').to('covered')
   *   .dagger('./pipelines/coverage', 'run')
   *   .policy('./policies/coverage', {
   *     query: 'data.coverage.allow',
   *     input: 'coverage.json',
   *   })
   *   .done()
   */
  policy(
    path: string,
    options?: {
      /** Rego query to evaluate (default: 'data.main.deny') */
      query?: string;
      /** Input file pattern from action outputs (default: '*.json') */
      input?: string;
      /** Fail-open behavior - allow on error (default: false) */
      failOpen?: boolean;
    },
  ): this {
    this._transition.policy = {
      path,
      query: options?.query ?? "data.main.deny",
      input: options?.input ?? "*.json",
      failOpen: options?.failOpen ?? false,
    };
    return this;
  }

  /**
   * Set resource requirements for execution.
   */
  resources(resources: Resources): this {
    this._transition.resources = resources;
    return this;
  }

  /**
   * Set CPU requirement.
   *
   * @param cpu - CPU request (e.g., '100m', '2')
   */
  cpu(cpu: string): this {
    this._transition.resources = {
      ...this._transition.resources,
      cpu,
    };
    return this;
  }

  /**
   * Set memory requirement.
   *
   * @param memory - Memory request (e.g., '256Mi', '4Gi')
   */
  memory(memory: string): this {
    this._transition.resources = {
      ...this._transition.resources,
      memory,
    };
    return this;
  }

  /**
   * Set execution timeout.
   *
   * @param timeout - Timeout string (e.g., '5m', '1h', '30s')
   */
  timeout(timeout: string): this {
    this._transition.timeout = timeout;
    return this;
  }

  /**
   * Set retry configuration.
   *
   * @param count - Number of retry attempts
   * @param backoff - Backoff strategy (default: 'exponential')
   */
  retries(
    count: number,
    backoff: "fixed" | "exponential" = "exponential",
  ): this {
    this._transition.retries = count;
    this._transition.retryBackoff = backoff;
    return this;
  }

  /**
   * Set scheduling priority (0-100, higher = more priority).
   */
  priority(priority: number): this {
    this._transition.priority = priority;
    return this;
  }

  /**
   * Set engine configuration for this transition (overrides workflow default).
   *
   * @param mode - Engine mode: 'local', 'cloud', or 'auto'
   * @param requirements - Optional resource requirements
   *
   * @example
   * ```ts
   * .transition('deploy')
   *   .engine('cloud', { requireAudit: true })
   *   .dagger('./ci', 'deploy')
   * ```
   */
  engine(mode: EngineMode, requirements?: Partial<EngineRequirements>): this {
    this._transition.engine = {
      mode,
      requirements: requirements as EngineRequirements,
    };
    return this;
  }

  /**
   * Force local execution for this transition.
   */
  local(): this {
    return this.engine("local");
  }

  /**
   * Force cloud execution for this transition.
   */
  cloud(requirements?: Partial<EngineRequirements>): this {
    return this.engine("cloud", requirements);
  }

  /**
   * Require GPU for this transition (forces cloud execution).
   */
  gpu(memoryGb?: number): this {
    return this.engine("auto", { gpu: true, memoryGb });
  }

  /**
   * Require audit trail for this transition (forces cloud execution).
   */
  audit(): this {
    return this.engine("cloud", { requireAudit: true });
  }

  /**
   * Finish configuring this transition and return to the workflow builder.
   *
   * @returns The parent WorkflowBuilder
   * @throws {Error} If no action was configured
   */
  done(): WorkflowBuilder {
    if (!this._transition.action) {
      throw new Error(
        `Transition '${this._transition.id}' must have an action. ` +
          "Use .dagger(), .http(), .script(), or .noop()",
      );
    }

    this.parent._addTransition(this._transition as Transition);
    return this.parent;
  }
}

// ============ Convenience functions ============

/**
 * Create a simple linear workflow (place1 -> transition1 -> place2 -> transition2 -> ...).
 *
 * @param name - Workflow name
 * @param steps - Array of step definitions
 */
export function linearWorkflow(
  name: string,
  steps: Array<{
    place: string;
    transition?: {
      id: string;
      action: Action;
      resources?: Resources;
      timeout?: string;
    };
  }>,
): Workflow {
  const builder = workflow(name);

  // Add places
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    builder.place(step.place, { initialTokens: i === 0 ? 1 : 0 });
  }

  // Add transitions
  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i]!;
    const nextStep = steps[i + 1]!;

    if (step.transition) {
      let tb = builder
        .transition(step.transition.id)
        .from(step.place)
        .to(nextStep.place)
        .action(step.transition.action);

      if (step.transition.resources) {
        tb = tb.resources(step.transition.resources);
      }
      if (step.transition.timeout) {
        tb = tb.timeout(step.transition.timeout);
      }
      tb.done();
    }
  }

  return builder.build();
}
