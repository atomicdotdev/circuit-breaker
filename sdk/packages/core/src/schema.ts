/**
 * Zod schemas for Circuit Breaker workflow definitions.
 * These schemas match the JSON Schema contract in /schemas/workflow.schema.json
 *
 * @module
 */

import { z } from "zod";

// ============ Metadata ============

export const MetadataSchema = z.object({
  description: z.string().max(1000).optional(),
  labels: z.record(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

// ============ Token Schema (for colored Petri nets) ============

export const TokenSchemaSchema = z.record(z.any()).optional();

export type TokenSchema = z.infer<typeof TokenSchemaSchema>;

// ============ Place ============

export const PlaceSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z][a-z0-9_-]*$/,
      "Place ID must be lowercase alphanumeric with underscores/hyphens",
    ),
  initialTokens: z.number().int().min(0).default(0),
  capacity: z.number().int().min(1).nullable().default(null),
  tokenSchema: TokenSchemaSchema,
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
  annotations: z.record(z.string()).optional(),
});

export type Place = z.infer<typeof PlaceSchema>;

// ============ Arc ============

export const ArcSchema = z.object({
  place: z.string(),
  weight: z.number().int().min(1).default(1),
  expression: z.string().optional(), // CEL expression for token selection
});

export type Arc = z.infer<typeof ArcSchema>;

// ============ Resources ============

export const TolerationSchema = z.object({
  key: z.string().optional(),
  operator: z.enum(["Exists", "Equal"]).optional(),
  value: z.string().optional(),
  effect: z.enum(["NoSchedule", "PreferNoSchedule", "NoExecute"]).optional(),
});

export const ResourcesSchema = z.object({
  cpu: z
    .string()
    .regex(/^[0-9]+(m|)$/)
    .optional(),
  memory: z
    .string()
    .regex(/^[0-9]+(Ki|Mi|Gi)$/)
    .optional(),
  gpu: z.string().optional(),
  ephemeralStorage: z
    .string()
    .regex(/^[0-9]+(Ki|Mi|Gi)$/)
    .optional(),
  nodeSelector: z.record(z.string()).optional(),
  tolerations: z.array(TolerationSchema).optional(),
});

export type Resources = z.infer<typeof ResourcesSchema>;

// ============ Engine Configuration ============

/**
 * Engine execution mode for hybrid cloud support.
 * - local: Use local Dagger installation (fastest for development)
 * - cloud: Use Circuit Breaker Engine Service (for production/GPU)
 * - auto: Automatically select based on requirements
 */
export const EngineModeSchema = z
  .enum(["local", "cloud", "auto"])
  .default("auto");

export type EngineMode = z.infer<typeof EngineModeSchema>;

/**
 * Resource requirements that influence engine selection in auto mode.
 */
export const EngineRequirementsSchema = z.object({
  /** Require GPU access (forces cloud mode) */
  gpu: z.boolean().default(false),
  /** Minimum memory in GB (>16GB suggests cloud) */
  memoryGb: z.number().int().min(1).optional(),
  /** Minimum CPU cores (>8 suggests cloud) */
  cpuCores: z.number().int().min(1).optional(),
  /** Required Dagger engine version */
  engineVersion: z.string().optional(),
  /** Require audit trail for compliance (forces cloud) */
  requireAudit: z.boolean().default(false),
  /** Custom labels for engine selection */
  labels: z.record(z.string()).optional(),
});

export type EngineRequirements = z.infer<typeof EngineRequirementsSchema>;

/**
 * Engine configuration for a workflow or transition.
 * Controls whether execution happens locally or in the cloud.
 */
export const EngineConfigSchema = z.object({
  /** Execution mode: local, cloud, or auto */
  mode: EngineModeSchema,
  /** Resource requirements that influence auto mode selection */
  requirements: EngineRequirementsSchema.optional(),
});

export type EngineConfig = z.infer<typeof EngineConfigSchema>;

// ============ Actions ============

export const DaggerActionSchema = z.object({
  type: z.literal("dagger"),
  module: z.string(),
  function: z.string().optional(),
  args: z.record(z.any()).optional(),
  image: z.string().optional(),
  cache: z.boolean().default(true),
});

export type DaggerAction = z.infer<typeof DaggerActionSchema>;

export const HttpActionSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  expectedStatus: z.array(z.number().int()).default([200, 201, 202, 204]),
});

export type HttpAction = z.infer<typeof HttpActionSchema>;

export const ScriptActionSchema = z.object({
  type: z.literal("script"),
  runtime: z.enum(["bun", "deno", "node"]).default("bun"),
  code: z.string().optional(),
  file: z.string().optional(),
});

export type ScriptAction = z.infer<typeof ScriptActionSchema>;

export const CircuitActionSchema = z.object({
  type: z.literal("circuit"),
  command: z.string(),
  image: z.string().optional(),
  shell: z.string().default("sh"),
  workdir: z.string().default("/workspace"),
});

export type CircuitAction = z.infer<typeof CircuitActionSchema>;

export const NoopActionSchema = z.object({
  type: z.literal("noop"),
});

export type NoopAction = z.infer<typeof NoopActionSchema>;

export const ActionSchema = z.discriminatedUnion("type", [
  DaggerActionSchema,
  HttpActionSchema,
  ScriptActionSchema,
  CircuitActionSchema,
  NoopActionSchema,
]);

export type Action = z.infer<typeof ActionSchema>;

// ============ Policy Gate ============

export const PolicyGateSchema = z.object({
  path: z.string(),
  query: z.string().default("data.main.deny"),
  input: z.string().default("*.json"),
  failOpen: z.boolean().default(false),
});

export type PolicyGate = z.infer<typeof PolicyGateSchema>;

// ============ Transition ============

export const TransitionSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z][a-z0-9_-]*$/,
      "Transition ID must be lowercase alphanumeric with underscores/hyphens",
    ),
  inputs: z.array(ArcSchema),
  outputs: z.array(ArcSchema),
  guard: z.string().optional(), // CEL expression (pre-check)
  action: ActionSchema,
  policy: PolicyGateSchema.optional(), // OPA/conftest policy gate (post-check)
  resources: ResourcesSchema.optional(),
  /** Engine configuration override for this transition */
  engine: EngineConfigSchema.optional(),
  timeout: z
    .string()
    .regex(/^[0-9]+(s|m|h)$/)
    .default("5m"),
  retries: z.number().int().min(0).max(10).default(0),
  retryBackoff: z.enum(["fixed", "exponential"]).default("exponential"),
  priority: z.number().int().min(0).max(100).default(50),
  /**
   * Arbitrary key-value annotations attached to this transition.
   *
   * Used by Sherpa and other consumers to attach metadata directly to
   * the transition definition — human-readable labels, UI variant hints,
   * or any other consumer-specific metadata.
   *
   * @example
   * // Sherpa HITL action annotations
   * annotations: {
   *   "sherpa.label":   "Accept plan",  // human-readable button label
   *   "sherpa.variant": "primary",      // "primary" | "danger" | "ghost"
   * }
   */
  annotations: z.record(z.string()).optional(),
});

export type Transition = z.infer<typeof TransitionSchema>;

// ============ Workflow ============

const WorkflowNameSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(
    /^[a-z][a-z0-9-]*[a-z0-9]$/,
    "Workflow name must be DNS-compatible (lowercase, hyphens)",
  );

const NamespaceSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/)
  .default("default");

export const WorkflowSchema = z
  .object({
    version: z.literal("1.0"),
    name: WorkflowNameSchema,
    namespace: NamespaceSchema,
    metadata: MetadataSchema.optional(),
    /** Default engine configuration for all transitions */
    engine: EngineConfigSchema.optional(),
    places: z.array(PlaceSchema).min(1),
    transitions: z.array(TransitionSchema).min(1),
  })
  .refine(
    (workflow) => {
      // Validate that all arc references point to valid places
      const placeIds = new Set(workflow.places.map((p) => p.id));

      for (const transition of workflow.transitions) {
        for (const input of transition.inputs) {
          if (!placeIds.has(input.place)) {
            return false;
          }
        }
        for (const output of transition.outputs) {
          if (!placeIds.has(output.place)) {
            return false;
          }
        }
      }
      return true;
    },
    {
      message: "All arc references must point to valid place IDs",
    },
  )
  .refine(
    (workflow) => {
      // Validate unique place IDs
      const placeIds = workflow.places.map((p) => p.id);
      return new Set(placeIds).size === placeIds.length;
    },
    {
      message: "Place IDs must be unique",
    },
  )
  .refine(
    (workflow) => {
      // Validate unique transition IDs
      const transitionIds = workflow.transitions.map((t) => t.id);
      return new Set(transitionIds).size === transitionIds.length;
    },
    {
      message: "Transition IDs must be unique",
    },
  );

export type Workflow = z.infer<typeof WorkflowSchema>;

// ============ Partial schemas for building ============

export const PartialPlaceSchema = PlaceSchema.partial().required({ id: true });
export const PartialTransitionSchema = TransitionSchema.partial().required({
  id: true,
  inputs: true,
  outputs: true,
  action: true,
});

// ============ Validation helpers ============

export function parseWorkflow(data: unknown): Workflow {
  return WorkflowSchema.parse(data);
}

export function safeParseWorkflow(
  data: unknown,
): z.SafeParseReturnType<unknown, Workflow> {
  return WorkflowSchema.safeParse(data);
}

export function isValidWorkflow(data: unknown): data is Workflow {
  return WorkflowSchema.safeParse(data).success;
}
