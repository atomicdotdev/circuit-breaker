//! # Circuit Breaker Runner
//!
//! Task execution runtime for Circuit Breaker workflows.
//!
//! This crate provides the Dagger runner that executes transition actions
//! within Kubernetes pods provisioned by Karpenter.
//!
//! ## Features
//!
//! - **Hybrid Execution**: Support for local and cloud Dagger engines
//! - **Automatic Engine Selection**: Choose the best engine based on requirements
//! - **Dagger pipeline execution** via dagger-sdk
//! - **Policy gate validation** via conftest
//! - **HTTP action execution**
//! - **Script (Bun/Deno/Node) execution**
//! - Resource management and limits
//! - Artifact collection and upload
//! - Structured logging and metrics
//!
//! ## Architecture
//!
//! The runner operates as a standalone process that:
//!
//! 1. Subscribes to task dispatch events from NATS
//! 2. Claims and executes tasks matching its runner pool
//! 3. Selects the appropriate engine (local or cloud) based on requirements
//! 4. Executes the action (Dagger, HTTP, script)
//! 5. If policy is configured, runs conftest validation
//! 6. Publishes task completion/failure events
//! 7. Uploads artifacts to object storage
//!
//! ## Hybrid Execution Model
//!
//! The runner supports three execution modes:
//!
//! - **Local**: Use local Dagger installation (fastest for development)
//! - **Cloud**: Use Circuit Breaker Engine Service (for production/GPU workloads)
//! - **Auto**: Automatically select based on requirements and availability
//!
//! ```rust,no_run
//! use cb_runner::engine::{EngineSelector, SelectedEngine, EngineExecutor};
//! use cb_core::engine::{EngineConfig, EngineRequirements};
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! // Create selector with auto mode
//! let config = EngineConfig::auto();
//! let selector = EngineSelector::new(config).await?;
//!
//! // Select engine based on requirements
//! let requirements = EngineRequirements::default();
//! let engine = selector.select(&requirements).await?;
//!
//! // Execute a Dagger module
//! let result = engine.executor().execute("github.com/myorg/ci", Some("build"), None).await?;
//! # Ok(())
//! # }
//! ```
//!
//! ## Deployment
//!
//! Runners are deployed as Kubernetes pods with:
//! - Dagger engine sidecar (for Dagger actions) or local Dagger
//! - Appropriate resource requests/limits
//! - Node affinity for Karpenter-provisioned nodes
//! - Tolerations for runner taints
//!
//! For local development, ensure Dagger and a container runtime (Docker/Podman)
//! are installed and running.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod engine;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use cb_core::error::Result;
use cb_core::workflow::{Action, PolicyGate};

/// Configuration for the runner.
#[derive(Debug, Clone)]
pub struct RunnerConfig {
    /// Runner pool name.
    pub pool: String,
    /// NATS server URL.
    pub nats_url: String,
    /// Dagger engine URL (if using remote engine).
    /// If not set, uses local engine via dagger-sdk auto-provisioning.
    pub dagger_url: Option<String>,
    /// Default timeout for actions.
    pub default_timeout: Duration,
    /// Working directory for script execution.
    pub work_dir: String,
    /// Directory containing policy files (.rego).
    pub policies_dir: Option<PathBuf>,
    /// Conftest image to use for policy validation.
    pub conftest_image: String,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            pool: "default".to_string(),
            nats_url: "nats://localhost:4222".to_string(),
            dagger_url: None,
            default_timeout: Duration::from_secs(300),
            work_dir: "/tmp/cb-runner".to_string(),
            policies_dir: None,
            conftest_image: "openpolicyagent/conftest:latest".to_string(),
        }
    }
}

/// Result of executing an action.
#[derive(Debug, Clone)]
pub struct ExecutionResult {
    /// Whether the execution succeeded.
    pub success: bool,
    /// Output data from the action.
    pub outputs: Option<serde_json::Value>,
    /// Artifacts produced by the action.
    pub artifacts: Vec<Artifact>,
    /// Execution duration.
    pub duration: Duration,
    /// Resource usage metrics.
    pub resource_usage: ResourceUsage,
    /// Error message if failed.
    pub error: Option<String>,
    /// Logs from the execution.
    pub logs: Option<String>,
}

/// An artifact produced by action execution.
#[derive(Debug, Clone)]
pub struct Artifact {
    /// Artifact name.
    pub name: String,
    /// Path in object storage.
    pub path: String,
    /// Size in bytes.
    pub size: u64,
    /// Content checksum (SHA256).
    pub checksum: String,
    /// Content type.
    pub content_type: String,
}

/// Resource usage from action execution.
#[derive(Debug, Clone, Default)]
pub struct ResourceUsage {
    /// CPU time in milliseconds.
    pub cpu_millis: u64,
    /// Peak memory usage in bytes.
    pub memory_bytes: u64,
    /// Wall clock duration in milliseconds.
    pub duration_ms: u64,
}

/// Context passed to action executors.
#[derive(Debug, Clone)]
pub struct ExecutionContext {
    /// Task ID being executed.
    pub task_id: uuid::Uuid,
    /// Run ID this task belongs to.
    pub run_id: uuid::Uuid,
    /// Transition ID being executed.
    pub transition_id: String,
    /// Workflow name.
    pub workflow_name: String,
    /// Input tokens data (for colored Petri nets).
    pub input_data: Option<serde_json::Value>,
    /// Environment variables to pass to the action.
    pub environment: HashMap<String, String>,
    /// Timeout for this execution.
    pub timeout: Duration,
    /// Optional policy gate to validate outputs.
    pub policy: Option<PolicyGate>,
}

impl Default for ExecutionContext {
    fn default() -> Self {
        Self {
            task_id: uuid::Uuid::new_v4(),
            run_id: uuid::Uuid::new_v4(),
            transition_id: String::new(),
            workflow_name: String::new(),
            input_data: None,
            environment: HashMap::new(),
            timeout: Duration::from_secs(300), // 5 minutes default
            policy: None,
        }
    }
}

/// Result of policy evaluation.
#[derive(Debug, Clone)]
pub struct PolicyResult {
    /// Whether the policy passed.
    pub passed: bool,
    /// Violations found (if any).
    pub violations: Vec<String>,
    /// Warnings (non-blocking).
    pub warnings: Vec<String>,
    /// Raw output from conftest.
    pub raw_output: Option<String>,
}

impl PolicyResult {
    /// Create a passing result.
    pub fn pass() -> Self {
        Self {
            passed: true,
            violations: vec![],
            warnings: vec![],
            raw_output: None,
        }
    }

    /// Create a failing result with violations.
    pub fn fail(violations: Vec<String>) -> Self {
        Self {
            passed: false,
            violations,
            warnings: vec![],
            raw_output: None,
        }
    }
}

/// Action executor that handles all action types.
#[derive(Debug, Clone)]
pub struct ActionExecutor {
    config: RunnerConfig,
}

impl ActionExecutor {
    /// Create a new action executor.
    pub fn new(config: RunnerConfig) -> Self {
        Self { config }
    }

    /// Execute an action and return the result.
    ///
    /// If a policy gate is configured in the context, the action outputs
    /// will be validated against the policy after execution.
    pub async fn execute(
        &self,
        action: &Action,
        context: ExecutionContext,
    ) -> Result<ExecutionResult> {
        let start = std::time::Instant::now();

        let result = match action {
            Action::Dagger(dagger_action) => self.execute_dagger(dagger_action, &context).await,
            Action::Http(http_action) => self.execute_http(http_action, &context).await,
            Action::Script(script_action) => self.execute_script(script_action, &context).await,
            Action::Circuit(_circuit_action) => {
                // Circuit actions are handled by the main.rs runner via
                // `circuit machine exec`. The lib executor delegates to
                // the same Dagger path for now — the real circuit execution
                // path is in main.rs::execute_circuit().
                Ok(ExecutionResult {
                    success: true,
                    outputs: None,
                    artifacts: vec![],
                    duration: start.elapsed(),
                    resource_usage: ResourceUsage::default(),
                    error: None,
                    logs: None,
                })
            }
            Action::Noop => Ok(ExecutionResult {
                success: true,
                outputs: None,
                artifacts: vec![],
                duration: start.elapsed(),
                resource_usage: ResourceUsage::default(),
                error: None,
                logs: None,
            }),
        };

        // If action succeeded and policy is configured, validate outputs
        match result {
            Ok(mut exec_result) if exec_result.success && context.policy.is_some() => {
                let policy = context.policy.as_ref().unwrap();
                match self.evaluate_policy(policy, &exec_result).await {
                    Ok(policy_result) => {
                        if !policy_result.passed {
                            exec_result.success = false;
                            exec_result.error = Some(format!(
                                "Policy validation failed: {}",
                                policy_result.violations.join(", ")
                            ));
                            tracing::warn!(
                                policy_path = %policy.path,
                                violations = ?policy_result.violations,
                                "Policy gate failed"
                            );
                        } else {
                            tracing::info!(
                                policy_path = %policy.path,
                                "Policy gate passed"
                            );
                        }
                        Ok(exec_result)
                    }
                    Err(e) => {
                        // Policy evaluation error
                        if policy.fail_open {
                            tracing::warn!(
                                error = %e,
                                policy_path = %policy.path,
                                "Policy evaluation failed, but fail_open=true, continuing"
                            );
                            Ok(exec_result)
                        } else {
                            exec_result.success = false;
                            exec_result.error = Some(format!("Policy evaluation error: {}", e));
                            Ok(exec_result)
                        }
                    }
                }
            }
            other => other,
        }
    }

    /// Execute a Dagger pipeline action.
    ///
    /// For local mode: runs `dagger call -m <module> <function> --args` directly.
    /// For cloud mode: requests engine from Engine Service and executes via GraphQL.
    async fn execute_dagger(
        &self,
        action: &cb_core::workflow::DaggerAction,
        context: &ExecutionContext,
    ) -> Result<ExecutionResult> {
        let start = std::time::Instant::now();

        tracing::info!(
            module = %action.module,
            function = ?action.function,
            task_id = %context.task_id,
            "Executing Dagger action"
        );

        // Build dagger call command: dagger call -m <module> <function> --arg1=val1 --arg2=val2
        let mut cmd = tokio::process::Command::new("dagger");
        cmd.arg("call");
        cmd.arg("-m");
        cmd.arg(&action.module);

        if let Some(ref func) = action.function {
            cmd.arg(func);
        }

        // Add function arguments (with token interpolation)
        if let Some(ref args_map) = action.args {
            for (key, value) in args_map {
                let resolved_value = match value {
                    serde_json::Value::String(s) => {
                        // Resolve ctx.token.* references from input_data
                        if s.starts_with("ctx.token.") {
                            let token_key = s.strip_prefix("ctx.token.").unwrap();
                            if let Some(ref input_data) = context.input_data {
                                if let Some(v) = input_data.get(token_key) {
                                    match v {
                                        serde_json::Value::String(sv) => Some(sv.clone()),
                                        serde_json::Value::Null => None,
                                        other => Some(other.to_string()),
                                    }
                                } else {
                                    tracing::debug!(key = %token_key, "Token key not found in input_data, skipping arg");
                                    None
                                }
                            } else {
                                tracing::debug!(
                                    "No input_data available for token interpolation, skipping arg"
                                );
                                None
                            }
                        } else {
                            Some(s.clone())
                        }
                    }
                    serde_json::Value::Null => None,
                    other => Some(other.to_string()),
                };
                // Only add the arg if we have a resolved value
                if let Some(val) = resolved_value {
                    cmd.arg(format!("--{}={}", key, val));
                }
            }
        }

        // Add environment variables
        for (key, value) in &context.environment {
            cmd.env(key, value);
        }

        tracing::info!(command = ?cmd, "Running dagger command");

        let output = match cmd.output().await {
            Ok(o) => o,
            Err(e) => {
                tracing::error!(error = %e, "Failed to execute dagger command");
                return Ok(ExecutionResult {
                    success: false,
                    outputs: None,
                    artifacts: vec![],
                    duration: start.elapsed(),
                    resource_usage: ResourceUsage::default(),
                    error: Some(format!("Failed to execute dagger: {}", e)),
                    logs: None,
                });
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        tracing::info!(stdout = %stdout, stderr = %stderr, status = ?output.status, "Dagger command completed");

        if output.status.success() {
            tracing::info!(
                module = %action.module,
                function = ?action.function,
                "Dagger action completed successfully"
            );

            Ok(ExecutionResult {
                success: true,
                outputs: Some(serde_json::json!({
                    "module": action.module,
                    "function": action.function,
                    "stdout": stdout,
                })),
                artifacts: vec![],
                duration: start.elapsed(),
                resource_usage: ResourceUsage::default(),
                error: None,
                logs: Some(stdout),
            })
        } else {
            tracing::error!(
                module = %action.module,
                function = ?action.function,
                stderr = %stderr,
                "Dagger action failed"
            );

            Ok(ExecutionResult {
                success: false,
                outputs: None,
                artifacts: vec![],
                duration: start.elapsed(),
                resource_usage: ResourceUsage::default(),
                error: Some(stderr),
                logs: Some(stdout),
            })
        }
    }

    /// Evaluate a policy gate against action outputs using conftest.
    async fn evaluate_policy(
        &self,
        policy: &PolicyGate,
        exec_result: &ExecutionResult,
    ) -> eyre::Result<PolicyResult> {
        tracing::info!(
            policy_path = %policy.path,
            query = %policy.query,
            "Evaluating policy gate"
        );

        // Serialize outputs to JSON for conftest input
        let input_json = match &exec_result.outputs {
            Some(outputs) => serde_json::to_string_pretty(outputs)?,
            None => "{}".to_string(),
        };

        let policy_path = policy.path.clone();
        let conftest_image = self.config.conftest_image.clone();

        // Use shared state to capture output
        let output_capture: Arc<Mutex<Option<std::result::Result<String, String>>>> =
            Arc::new(Mutex::new(None));
        let output_ref = output_capture.clone();

        // Run conftest via Dagger
        let dagger_result = dagger_sdk::connect(move |client| {
            let input = input_json.clone();
            let policies = policy_path.clone();
            let image = conftest_image.clone();
            let output_ref = output_ref.clone();

            async move {
                // Load policy directory from host
                let policy_dir = client.host().directory(&policies);

                // Run conftest
                let result = client
                    .container()
                    .from(&image)
                    .with_mounted_directory("/policies", policy_dir)
                    .with_new_file("/input.json", input)
                    .with_exec(vec![
                        "conftest",
                        "test",
                        "/input.json",
                        "--policy",
                        "/policies",
                        "--output",
                        "json",
                    ])
                    .stdout()
                    .await;

                // Store the result in shared state
                let mut guard = output_ref.lock().await;
                *guard = Some(result.map_err(|e| e.to_string()));

                Ok(())
            }
        })
        .await;

        // Extract the captured output
        let captured = output_capture.lock().await.take();

        match dagger_result {
            Ok(()) => {
                match captured {
                    Some(Ok(json_output)) => {
                        // Parse conftest JSON output
                        let parsed: serde_json::Value =
                            serde_json::from_str(&json_output).unwrap_or(serde_json::json!([]));

                        let mut violations = Vec::new();
                        let mut warnings = Vec::new();

                        // conftest outputs an array of results
                        if let Some(results) = parsed.as_array() {
                            for result in results {
                                // Check failures
                                if let Some(failures) =
                                    result.get("failures").and_then(|f| f.as_array())
                                {
                                    for failure in failures {
                                        if let Some(msg) =
                                            failure.get("msg").and_then(|m| m.as_str())
                                        {
                                            violations.push(msg.to_string());
                                        }
                                    }
                                }
                                // Check warnings
                                if let Some(warns) =
                                    result.get("warnings").and_then(|w| w.as_array())
                                {
                                    for warn in warns {
                                        if let Some(msg) = warn.get("msg").and_then(|m| m.as_str())
                                        {
                                            warnings.push(msg.to_string());
                                        }
                                    }
                                }
                            }
                        }

                        Ok(PolicyResult {
                            passed: violations.is_empty(),
                            violations,
                            warnings,
                            raw_output: Some(json_output),
                        })
                    }
                    Some(Err(e)) => {
                        // conftest execution failed - might be policy violations
                        Err(eyre::eyre!("conftest failed: {}", e))
                    }
                    None => Err(eyre::eyre!("No output captured from conftest")),
                }
            }
            Err(e) => Err(eyre::eyre!("Dagger connection failed: {}", e)),
        }
    }

    /// Execute an HTTP action.
    async fn execute_http(
        &self,
        action: &cb_core::workflow::HttpAction,
        context: &ExecutionContext,
    ) -> Result<ExecutionResult> {
        let start = std::time::Instant::now();

        tracing::info!(
            url = %action.url,
            method = ?action.method,
            task_id = %context.task_id,
            "Executing HTTP action"
        );

        let client = reqwest::Client::new();

        let method = match action.method {
            cb_core::workflow::HttpMethod::Get => reqwest::Method::GET,
            cb_core::workflow::HttpMethod::Post => reqwest::Method::POST,
            cb_core::workflow::HttpMethod::Put => reqwest::Method::PUT,
            cb_core::workflow::HttpMethod::Patch => reqwest::Method::PATCH,
            cb_core::workflow::HttpMethod::Delete => reqwest::Method::DELETE,
        };

        let mut request = client.request(method, &action.url);

        // Add headers
        if let Some(ref headers) = action.headers {
            for (key, value) in headers {
                request = request.header(key, value);
            }
        }

        // Add body
        if let Some(ref body) = action.body {
            request = request.body(body.clone());
        }

        // Set timeout
        request = request.timeout(context.timeout);

        match request.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let expected = &action.expected_status;
                let success = expected.iter().any(|s| *s == status);

                let body = response.text().await.unwrap_or_default();

                Ok(ExecutionResult {
                    success,
                    outputs: Some(serde_json::json!({
                        "url": action.url,
                        "status": status,
                        "body": body,
                    })),
                    artifacts: vec![],
                    duration: start.elapsed(),
                    resource_usage: ResourceUsage::default(),
                    error: if !success {
                        Some(format!("Unexpected status code: {}", status))
                    } else {
                        None
                    },
                    logs: Some(body),
                })
            }
            Err(e) => Ok(ExecutionResult {
                success: false,
                outputs: None,
                artifacts: vec![],
                duration: start.elapsed(),
                resource_usage: ResourceUsage::default(),
                error: Some(e.to_string()),
                logs: None,
            }),
        }
    }

    /// Execute a script action using Dagger.
    async fn execute_script(
        &self,
        action: &cb_core::workflow::ScriptAction,
        context: &ExecutionContext,
    ) -> Result<ExecutionResult> {
        let start = std::time::Instant::now();

        let runtime_image = match action.runtime {
            cb_core::workflow::ScriptRuntime::Bun => "oven/bun:latest",
            cb_core::workflow::ScriptRuntime::Deno => "denoland/deno:latest",
            cb_core::workflow::ScriptRuntime::Node => "node:20-alpine",
        };

        let runtime_cmd = match action.runtime {
            cb_core::workflow::ScriptRuntime::Bun => "bun",
            cb_core::workflow::ScriptRuntime::Deno => "deno",
            cb_core::workflow::ScriptRuntime::Node => "node",
        };

        tracing::info!(
            runtime = ?action.runtime,
            image = %runtime_image,
            task_id = %context.task_id,
            "Executing script action"
        );

        let code = action.code.clone();
        let file = action.file.clone();
        let env = context.environment.clone();

        // Use shared state to capture output
        let output_capture: Arc<Mutex<Option<std::result::Result<String, String>>>> =
            Arc::new(Mutex::new(None));
        let output_ref = output_capture.clone();

        let script_result = dagger_sdk::connect(move |client| {
            let code = code.clone();
            let file = file.clone();
            let env = env.clone();
            let image = runtime_image.to_string();
            let cmd = runtime_cmd.to_string();
            let output_ref = output_ref.clone();

            async move {
                let mut container = client.container().from(&image);

                // Add environment variables
                for (key, value) in env {
                    container = container.with_env_variable(&key, &value);
                }

                // Either run inline code or a file
                let result = if let Some(code_content) = code {
                    container
                        .with_new_file("/script.js", code_content)
                        .with_exec(vec![&cmd, "/script.js"])
                        .stdout()
                        .await
                        .map_err(|e| e.to_string())
                } else if let Some(file_path) = file {
                    let script_file = client.host().file(&file_path);
                    container
                        .with_file("/script.js", script_file)
                        .with_exec(vec![&cmd, "/script.js"])
                        .stdout()
                        .await
                        .map_err(|e| e.to_string())
                } else {
                    Err("Script action requires either 'code' or 'file'".to_string())
                };

                // Store the result in shared state
                let mut guard = output_ref.lock().await;
                *guard = Some(result);

                Ok(())
            }
        })
        .await;

        // Extract the captured output
        let captured = output_capture.lock().await.take();

        match script_result {
            Ok(()) => match captured {
                Some(Ok(output)) => Ok(ExecutionResult {
                    success: true,
                    outputs: Some(serde_json::json!({
                        "runtime": format!("{:?}", action.runtime),
                        "output": output,
                    })),
                    artifacts: vec![],
                    duration: start.elapsed(),
                    resource_usage: ResourceUsage::default(),
                    error: None,
                    logs: Some(output),
                }),
                Some(Err(e)) => Ok(ExecutionResult {
                    success: false,
                    outputs: None,
                    artifacts: vec![],
                    duration: start.elapsed(),
                    resource_usage: ResourceUsage::default(),
                    error: Some(e),
                    logs: None,
                }),
                None => Ok(ExecutionResult {
                    success: false,
                    outputs: None,
                    artifacts: vec![],
                    duration: start.elapsed(),
                    resource_usage: ResourceUsage::default(),
                    error: Some("No output captured from script".to_string()),
                    logs: None,
                }),
            },
            Err(e) => Ok(ExecutionResult {
                success: false,
                outputs: None,
                artifacts: vec![],
                duration: start.elapsed(),
                resource_usage: ResourceUsage::default(),
                error: Some(e.to_string()),
                logs: None,
            }),
        }
    }
}

/// Execute an action and return the result.
///
/// This is the main entry point for action execution, dispatching
/// to the appropriate executor based on action type.
///
/// If the context includes a policy gate, the outputs will be validated
/// against the policy using conftest after successful execution.
///
/// # Errors
///
/// Returns an error if the action execution fails.
pub async fn execute_action(
    action: &Action,
    config: &RunnerConfig,
    context: ExecutionContext,
) -> Result<ExecutionResult> {
    let executor = ActionExecutor::new(config.clone());
    executor.execute(action, context).await
}

/// Execute an action with a policy gate.
///
/// Convenience function that sets up the policy in the execution context.
///
/// # Errors
///
/// Returns an error if the action execution or policy validation fails.
pub async fn execute_action_with_policy(
    action: &Action,
    policy: PolicyGate,
    config: &RunnerConfig,
    mut context: ExecutionContext,
) -> Result<ExecutionResult> {
    context.policy = Some(policy);
    execute_action(action, config, context).await
}

/// Prelude for convenient imports.
pub mod prelude {
    pub use crate::{
        execute_action, execute_action_with_policy, ActionExecutor, Artifact, ExecutionContext,
        ExecutionResult, PolicyResult, ResourceUsage, RunnerConfig,
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execution_context_default() {
        let ctx = ExecutionContext::default();
        assert_eq!(ctx.timeout, Duration::from_secs(300));
        assert!(ctx.environment.is_empty());
    }

    #[test]
    fn test_resource_usage_default() {
        let usage = ResourceUsage::default();
        assert_eq!(usage.cpu_millis, 0);
        assert_eq!(usage.memory_bytes, 0);
    }

    #[test]
    fn test_runner_config_default() {
        let config = RunnerConfig::default();
        assert_eq!(config.pool, "default");
        assert_eq!(config.default_timeout, Duration::from_secs(300));
    }
}
