/**
 * @circuit-breaker/core
 *
 * Core TypeScript SDK for Circuit Breaker workflow orchestration.
 * Provides type-safe workflow definitions using Petri-net semantics.
 *
 * @packageDocumentation
 */

// Schema exports
export {
  WorkflowSchema,
  PlaceSchema,
  TransitionSchema,
  ArcSchema,
  ResourcesSchema,
  DaggerActionSchema,
  HttpActionSchema,
  ScriptActionSchema,
  NoopActionSchema,
  ActionSchema,
  MetadataSchema,
  PolicyGateSchema,
} from "./schema";

// Type exports
export type {
  Workflow,
  Place,
  Transition,
  Arc,
  Resources,
  DaggerAction,
  HttpAction,
  ScriptAction,
  NoopAction,
  Action,
  Metadata,
  TokenSchema,
  PolicyGate,
} from "./schema";

// Builder exports
export {
  workflow,
  WorkflowBuilder,
  TransitionBuilder,
  type TaskAction,
} from "./workflow";

// GitHub Actions YAML converter
export {
  fromGitHubActions,
  fromGitHubActionsFile,
  type ConvertOptions,
  type GitHubActionsWorkflow,
} from "./github-actions";

// GitHub Actions composite action resolver
export {
  resolveAction,
  clearActionCache,
  type ResolvedStep,
} from "./action-resolver";

// Sealed runner baseline
export {
  BASELINE_PACKAGES,
  BASELINE_INSTALL_SCRIPT,
  BASELINE_INSTALL_STEPS,
  GITHUB_ACTIONS_SHIM,
  RUN_STEP_PREAMBLE,
  runnerCacheKey,
  runnerCachePath,
  RUNNER_CACHE_DIR,
} from "./runner-baseline";

// OpenCode AI agent integration
export {
  opencode,
  OpenCodeTaskBuilder,
  OpenCodeTasks,
  opencodeToDagger,
  OPENCODE_IMAGE,
  OPENCODE_DOCKERFILE,
  type OpenCodeConfig,
  type OpenCodeResult,
  type OpenCodeProvider,
  type OpenCodeModel,
  type OpenCodeAgent,
} from "./opencode";

// Client exports
export { CircuitBreakerClient, type ClientOptions } from "./client";

// Event types
export type {
  WorkflowEvent,
  WorkflowSubmittedEvent,
  WorkflowStartedEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  TransitionEvent,
  TransitionFiredEvent,
  TransitionCompletedEvent,
  TransitionFailedEvent,
  TokenEvent,
  TaskEvent,
} from "./events";

// Utility exports
export { validateWorkflow, ValidationError } from "./validate";
export {
  visualize,
  getGraphvizUrl,
  getMermaidUrl,
  type VisualizationOptions,
} from "./visualize";

// Re-export zod for convenience
export { z } from "zod";
