//! Circuit Breaker Runner
//!
//! Task execution daemon that subscribes to NATS for task dispatch events
//! and executes actions using Dagger, HTTP, or script runtimes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
use futures::StreamExt;
use tokio::process::Command;
use tracing::{debug, error, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use uuid::Uuid;

use cb_core::events::{
    ErrorInfo, ResourceUsage, TokenData, TransitionCompletedPayload, TransitionFailedPayload,
    TransitionFiredPayload, TransitionRef,
};
use cb_core::workflow::{Action, DaggerAction, HttpAction, ScriptAction};
use cb_nats::{consumers, streams, subjects, NatsClient, NatsConfig};

/// Circuit Breaker Runner - Task execution daemon
#[derive(Parser, Debug)]
#[command(name = "cb-runner")]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Runner instance ID (auto-generated if not provided)
    #[arg(long, env = "CB_RUNNER_ID")]
    runner_id: Option<String>,

    /// Runner pool name
    #[arg(short, long, default_value = "default", env = "CB_RUNNER_POOL")]
    pool: String,

    /// NATS server URL
    #[arg(long, default_value = "nats://localhost:4222", env = "NATS_URL")]
    nats_url: String,

    /// Dagger engine URL (optional, for remote Dagger)
    #[arg(long, env = "DAGGER_URL")]
    dagger_url: Option<String>,

    /// Default timeout in seconds
    #[arg(long, default_value = "300", env = "CB_DEFAULT_TIMEOUT")]
    timeout: u64,

    /// Working directory for executions
    #[arg(long, default_value = "/tmp/cb-runner", env = "CB_WORK_DIR")]
    work_dir: String,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, default_value = "info", env = "RUST_LOG")]
    log_level: String,

    /// Maximum concurrent task executions
    #[arg(long, default_value = "4", env = "CB_MAX_CONCURRENT")]
    max_concurrent: usize,
}

/// Task dispatch message received from NATS
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskDispatchMessage {
    task_id: Uuid,
    transition_ref: TransitionRef,
    action: serde_json::Value,
    #[serde(default)]
    resources: Option<TaskResources>,
    #[serde(default)]
    timeout: Option<String>,
    #[serde(default)]
    runner_pool: String,
    #[serde(default)]
    environment: HashMap<String, String>,
    #[serde(default)]
    input_tokens: Vec<TokenData>,
    #[serde(default)]
    policy: Option<cb_core::workflow::PolicyGate>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct TaskResources {
    #[serde(default)]
    cpu: Option<String>,
    #[serde(default)]
    memory: Option<String>,
}

/// Runner state
struct Runner {
    runner_id: String,
    pool: String,
    nats: Arc<NatsClient>,
    work_dir: String,
    default_timeout: Duration,
    dagger_url: Option<String>,
}

impl Runner {
    fn new(
        runner_id: String,
        pool: String,
        nats: NatsClient,
        work_dir: String,
        default_timeout: Duration,
        dagger_url: Option<String>,
    ) -> Self {
        Self {
            runner_id,
            pool,
            nats: Arc::new(nats),
            work_dir,
            default_timeout,
            dagger_url,
        }
    }

    /// Process a task dispatch message
    async fn process_task(
        &self,
        msg: TaskDispatchMessage,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let task_id = msg.task_id;
        let transition_ref = msg.transition_ref.clone();

        info!(
            task_id = %task_id,
            transition_id = %transition_ref.transition_id,
            run_id = %transition_ref.run_id,
            "Processing task"
        );

        // Publish TransitionFired event
        self.publish_transition_fired(&transition_ref, task_id, &msg.input_tokens)
            .await?;

        // Parse and execute the action
        let start = std::time::Instant::now();
        let result = self.execute_action(&msg, &transition_ref).await;
        let duration = start.elapsed();

        match result {
            Ok(output) => {
                info!(
                    task_id = %task_id,
                    duration_ms = duration.as_millis(),
                    "Task completed successfully"
                );

                // Publish TransitionCompleted
                self.publish_transition_completed(&transition_ref, output, duration)
                    .await?;
            }
            Err(e) => {
                error!(
                    task_id = %task_id,
                    error = %e,
                    duration_ms = duration.as_millis(),
                    "Task failed"
                );

                // Publish TransitionFailed
                self.publish_transition_failed(&transition_ref, &e.to_string())
                    .await?;
            }
        }

        Ok(())
    }

    /// Execute an action based on its type
    async fn execute_action(
        &self,
        msg: &TaskDispatchMessage,
        transition_ref: &TransitionRef,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        // Parse the action from JSON
        let action: Action = serde_json::from_value(msg.action.clone())?;

        match action {
            Action::Dagger(dagger_action) => {
                self.execute_dagger(&dagger_action, &msg.environment, &msg.input_tokens)
                    .await
            }
            Action::Http(http_action) => self.execute_http(&http_action).await,
            Action::Script(script_action) => {
                self.execute_script(
                    &script_action,
                    &msg.environment,
                    transition_ref,
                    &msg.input_tokens,
                )
                .await
            }
            Action::Circuit(circuit_action) => {
                self.execute_circuit(&circuit_action, &msg.environment, transition_ref)
                    .await
            }
            Action::Noop => {
                debug!("Executing noop action");
                Ok(
                    serde_json::json!({"status": "done", "message": "Workflow completed successfully"}),
                )
            }
        }
    }

    /// Execute a circuit action — runs a shell command inside a SmolVM.
    ///
    /// Uses the `circuit` CLI via subprocess. The VM is managed per workflow
    /// run: created on the first circuit action, reused for subsequent actions.
    async fn execute_circuit(
        &self,
        action: &cb_core::workflow::CircuitAction,
        env: &HashMap<String, String>,
        transition_ref: &TransitionRef,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        let image = action.image.as_deref().unwrap_or("ubuntu:24.04");
        let vm_name = format!("cb-run-{}", &transition_ref.run_id.to_string()[..8]);

        info!(
            vm_name = %vm_name,
            image = %image,
            command = %action.command,
            "Executing circuit action"
        );

        // Check if the VM already exists (reuse across transitions in the same run)
        let ls_output = Command::new("circuit")
            .args(["machine", "ls", "--json"])
            .output()
            .await?;

        let ls_text = String::from_utf8_lossy(&ls_output.stdout);
        let is_running = ls_text.contains(&vm_name) && ls_text.contains("running");

        if !is_running {
            info!(vm_name = %vm_name, image = %image, "Creating circuit VM");

            let source_dir = std::env::current_dir()?.display().to_string();

            let create_output = Command::new("circuit")
                .args([
                    "machine",
                    "create",
                    "--image",
                    image,
                    "--net",
                    "--volume",
                    &format!("{}:/projects", source_dir),
                    &vm_name,
                ])
                .output()
                .await?;

            if !create_output.status.success() {
                let stderr = String::from_utf8_lossy(&create_output.stderr);
                return Err(format!("Failed to create circuit VM: {}", stderr).into());
            }

            let start_output = Command::new("circuit")
                .args(["machine", "start", "--name", &vm_name])
                .output()
                .await?;

            if !start_output.status.success() {
                let stderr = String::from_utf8_lossy(&start_output.stderr);
                return Err(format!("Failed to start circuit VM: {}", stderr).into());
            }

            info!(vm_name = %vm_name, "Circuit VM ready");
        } else {
            debug!(vm_name = %vm_name, "Reusing existing circuit VM");
        }

        // Each `circuit machine exec` is a fresh shell session — env vars
        // don't carry over, but files on the persistent overlay do.
        // The action resolver writes env/path changes to well-known files
        // at /tmp/.cb/github_env and /tmp/.cb/github_path. Source them
        // before every command so changes from prior transitions persist.
        let full_command = format!(
            r#"if [ -f /tmp/.cb/github_env ]; then while IFS= read -r _l || [ -n "$_l" ]; do [ -n "$_l" ] && export "$_l"; done < /tmp/.cb/github_env; fi; \
               if [ -f /tmp/.cb/github_path ]; then while IFS= read -r _l || [ -n "$_l" ]; do [ -n "$_l" ] && export PATH="$_l:$PATH"; done < /tmp/.cb/github_path; fi; \
               cd {} && {}"#,
            action.workdir, action.command
        );

        let start = std::time::Instant::now();
        let output = Command::new("circuit")
            .args([
                "machine",
                "exec",
                "--name",
                &vm_name,
                "--",
                "bash",
                "-c",
                &full_command,
            ])
            .output()
            .await?;
        let duration = start.elapsed();

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        // Publish logs to NATS
        let log_payload = serde_json::json!({
            "transitionRef": transition_ref,
            "command": action.command,
            "image": image,
            "stdout": &stdout[..stdout.len().min(10000)],
            "stderr": &stderr[..stderr.len().min(10000)],
            "exitCode": output.status.code(),
            "durationMs": duration.as_millis(),
        });

        let subject = format!(
            "cb.runs.{}.logs.{}",
            transition_ref.run_id, transition_ref.transition_id
        );

        if let Err(e) = self.nats.publish_jetstream(&subject, &log_payload).await {
            warn!(error = %e, "Failed to publish circuit log to NATS");
        }

        if output.status.success() {
            Ok(serde_json::json!({
                "status": "success",
                "output": stdout,
                "exitCode": 0,
                "durationMs": duration.as_millis() as u64,
            }))
        } else {
            Err(format!(
                "Circuit command failed (exit {}): {}",
                output.status.code().unwrap_or(-1),
                if stderr.is_empty() { &stdout } else { &stderr }
            )
            .into())
        }
    }

    /// Execute a Dagger action
    async fn execute_dagger(
        &self,
        action: &DaggerAction,
        env: &HashMap<String, String>,
        input_tokens: &[TokenData],
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        info!(
            module = %action.module,
            function = ?action.function,
            image = ?action.image,
            input_tokens_count = %input_tokens.len(),
            "Executing Dagger action"
        );

        // Debug: log token data
        for (i, token) in input_tokens.iter().enumerate() {
            debug!(
                token_index = %i,
                token_id = ?token.token_id,
                token_data = ?token.data,
                "Input token"
            );
        }

        // Check if this is an OpenCode task (has image and args with command)
        if let Some(ref image) = action.image {
            return self.execute_container(image, action, env).await;
        }

        // Otherwise, run dagger module
        let mut cmd = Command::new("dagger");
        cmd.arg("call");

        // Add module path
        cmd.arg("-m").arg(&action.module);

        // Add function if specified
        if let Some(ref func) = action.function {
            cmd.arg(func);
        }

        // Add arguments with token interpolation
        if let Some(ref args) = action.args {
            // Build token data map from input tokens
            let token_data: HashMap<String, serde_json::Value> = input_tokens
                .iter()
                .filter_map(|t| t.data.clone())
                .flat_map(|data| {
                    if let serde_json::Value::Object(map) = data {
                        map.into_iter().collect::<Vec<_>>()
                    } else {
                        vec![]
                    }
                })
                .collect();

            info!(
                token_data_keys = ?token_data.keys().collect::<Vec<_>>(),
                "Token data map built"
            );

            for (key, value) in args {
                let resolved_value: Option<String> = match value {
                    serde_json::Value::String(s) => {
                        // Resolve ctx.token.* references
                        if s.starts_with("ctx.token.") {
                            let token_key = s.strip_prefix("ctx.token.").unwrap();
                            if let Some(v) = token_data.get(token_key) {
                                match v {
                                    serde_json::Value::String(sv) => Some(sv.clone()),
                                    serde_json::Value::Null => None,
                                    other => Some(other.to_string()),
                                }
                            } else {
                                debug!(key = %token_key, "Token key not found, skipping arg");
                                None
                            }
                        } else {
                            Some(s.clone())
                        }
                    }
                    serde_json::Value::Null => None,
                    other => Some(other.to_string()),
                };

                // Only add arg if we have a resolved value
                if let Some(ref val) = resolved_value {
                    info!(key = %key, value = %val, "Adding resolved arg");
                    cmd.arg(format!("--{}={}", key, val));
                } else {
                    debug!(key = %key, "Skipping arg with no resolved value");
                }
            }
        }

        // Set environment variables
        for (key, value) in env {
            cmd.env(key, value);
        }

        // Also pass through common API keys from host environment
        for key in [
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GOOGLE_API_KEY",
            "OLLAMA_HOST",
        ] {
            if let Ok(value) = std::env::var(key) {
                cmd.env(key, value);
            }
        }

        // Set Dagger URL if configured
        if let Some(ref url) = self.dagger_url {
            cmd.env("DAGGER_SESSION_URL", url);
        }

        debug!(?cmd, "Running dagger command");

        let output = cmd.output().await?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

            // Try to parse the output as JSON - if it is, use it directly as token data
            // This allows dagger modules to return structured data that flows to the next transition
            match serde_json::from_str::<serde_json::Value>(&stdout) {
                Ok(json_output) => {
                    debug!("Dagger output parsed as JSON");
                    Ok(json_output)
                }
                Err(_) => {
                    // Not JSON, wrap in a standard format
                    debug!("Dagger output is not JSON, wrapping as string");
                    Ok(serde_json::json!({
                        "status": "success",
                        "output": stdout,
                    }))
                }
            }
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Dagger execution failed: {}", stderr).into())
        }
    }

    /// Execute a container directly (for OpenCode and similar tasks)
    async fn execute_container(
        &self,
        image: &str,
        action: &DaggerAction,
        env: &HashMap<String, String>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        info!(image = %image, "Executing container");

        // For OpenCode, we need to create a config file with provider credentials
        let config_file = self.create_opencode_config().await?;

        let mut cmd = Command::new("docker");
        cmd.arg("run");
        cmd.arg("--rm");

        // Set working directory
        let workdir = action
            .args
            .as_ref()
            .and_then(|a| a.get("workdir"))
            .and_then(|v| v.as_str())
            .unwrap_or("/workspace");

        // Mount current directory to workspace
        cmd.arg("-v").arg(format!(
            "{}:{}",
            std::env::current_dir()?.display(),
            workdir
        ));
        cmd.arg("-w").arg(workdir);

        // Mount OpenCode config file and set OPENCODE_CONFIG env var
        if let Some(ref config_path) = config_file {
            cmd.arg("-v")
                .arg(format!("{}:/tmp/opencode-config.json:ro", config_path));
            cmd.arg("-e")
                .arg("OPENCODE_CONFIG=/tmp/opencode-config.json");
        }

        // Set environment variables from action args
        if let Some(ref args) = action.args {
            if let Some(env_val) = args.get("env") {
                if let Some(env_map) = env_val.as_object() {
                    for (key, value) in env_map {
                        if let Some(v) = value.as_str() {
                            cmd.arg("-e").arg(format!("{}={}", key, v));
                        }
                    }
                }
            }
        }

        // Set environment variables from task
        for (key, value) in env {
            cmd.arg("-e").arg(format!("{}={}", key, value));
        }

        // Pass through API keys from host environment
        for key in [
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GOOGLE_API_KEY",
            "OLLAMA_HOST",
        ] {
            if let Ok(value) = std::env::var(key) {
                cmd.arg("-e").arg(format!("{}={}", key, value));
            }
        }

        // Set CI mode for non-interactive execution
        cmd.arg("-e").arg("CI=true");
        cmd.arg("-e").arg("OPENCODE_NON_INTERACTIVE=true");

        // Image
        cmd.arg(image);

        // Command from args
        if let Some(ref args) = action.args {
            info!(args = ?args, "Action args");
            if let Some(command) = args.get("command") {
                info!(command = ?command, "Command from args");
                if let Some(cmd_array) = command.as_array() {
                    for arg in cmd_array {
                        if let Some(s) = arg.as_str() {
                            cmd.arg(s);
                        }
                    }
                }
            } else {
                warn!("No command found in action args");
            }
        } else {
            warn!("No args in action");
        }

        info!(?cmd, "Running docker command");

        let output = cmd.output().await?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        info!(
            stdout_len = stdout.len(),
            stderr_len = stderr.len(),
            exit_code = ?output.status.code(),
            "Container execution finished"
        );

        // Log first 500 chars of output for debugging
        if !stdout.is_empty() {
            let preview: String = stdout.chars().take(500).collect();
            info!(stdout_preview = %preview, "Container stdout");
        }
        if !stderr.is_empty() {
            let preview: String = stderr.chars().take(500).collect();
            info!(stderr_preview = %preview, "Container stderr");
        }

        if output.status.success() {
            Ok(serde_json::json!({
                "status": "success",
                "output": stdout.to_string(),
                "stderr": stderr.to_string(),
            }))
        } else {
            Err(format!(
                "Container execution failed (exit code {:?}):\nstdout: {}\nstderr: {}",
                output.status.code(),
                stdout,
                stderr
            )
            .into())
        }
    }

    /// Create OpenCode config file with provider credentials from environment
    async fn create_opencode_config(
        &self,
    ) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
        let mut providers = serde_json::Map::new();

        // Check for Anthropic API key
        if let Ok(api_key) = std::env::var("ANTHROPIC_API_KEY") {
            if !api_key.is_empty() {
                let mut options = serde_json::Map::new();
                options.insert("apiKey".to_string(), serde_json::Value::String(api_key));
                let mut anthropic = serde_json::Map::new();
                anthropic.insert("options".to_string(), serde_json::Value::Object(options));
                providers.insert(
                    "anthropic".to_string(),
                    serde_json::Value::Object(anthropic),
                );
            }
        }

        // Check for OpenAI API key
        if let Ok(api_key) = std::env::var("OPENAI_API_KEY") {
            if !api_key.is_empty() {
                let mut options = serde_json::Map::new();
                options.insert("apiKey".to_string(), serde_json::Value::String(api_key));
                let mut openai = serde_json::Map::new();
                openai.insert("options".to_string(), serde_json::Value::Object(options));
                providers.insert("openai".to_string(), serde_json::Value::Object(openai));
            }
        }

        // Check for Google API key
        if let Ok(api_key) = std::env::var("GOOGLE_API_KEY") {
            if !api_key.is_empty() {
                let mut options = serde_json::Map::new();
                options.insert("apiKey".to_string(), serde_json::Value::String(api_key));
                let mut google = serde_json::Map::new();
                google.insert("options".to_string(), serde_json::Value::Object(options));
                providers.insert("google".to_string(), serde_json::Value::Object(google));
            }
        }

        if providers.is_empty() {
            warn!("No AI provider API keys found in environment");
            return Ok(None);
        }

        let config = serde_json::json!({
            "$schema": "https://opencode.ai/config.json",
            "provider": providers
        });

        // Write config to target directory (gitignored and accessible by Docker on macOS)
        // /tmp is not shared with Docker on macOS, but the project directory is
        let current_dir = std::env::current_dir()?;
        let config_dir = current_dir.join("target").join("opencode-config");
        std::fs::create_dir_all(&config_dir)?;
        let config_path = format!("{}/{}.json", config_dir.display(), uuid::Uuid::new_v4());
        std::fs::write(&config_path, serde_json::to_string_pretty(&config)?)?;

        info!(config_path = %config_path, providers = ?providers.keys().collect::<Vec<_>>(), "Created OpenCode config");

        Ok(Some(config_path))
    }

    /// Execute an HTTP action
    async fn execute_http(
        &self,
        action: &HttpAction,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        info!(url = %action.url, method = ?action.method, "Executing HTTP action");

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

        let response = request.send().await?;
        let status = response.status().as_u16();
        let body = response.text().await?;

        if action.expected_status.contains(&status) {
            Ok(serde_json::json!({
                "status": status,
                "body": body,
            }))
        } else {
            Err(format!("HTTP request failed with status {}: {}", status, body).into())
        }
    }

    /// Execute a script action
    async fn execute_script(
        &self,
        action: &ScriptAction,
        env: &HashMap<String, String>,
        transition_ref: &TransitionRef,
        input_tokens: &[TokenData],
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        info!(runtime = ?action.runtime, "Executing script action");

        let runtime_cmd = match action.runtime {
            cb_core::workflow::ScriptRuntime::Bun => "bun",
            cb_core::workflow::ScriptRuntime::Deno => "deno",
            cb_core::workflow::ScriptRuntime::Node => "node",
        };

        let mut cmd = Command::new(runtime_cmd);

        // Set environment
        for (key, value) in env {
            cmd.env(key, value);
        }

        // Build ctx object from input tokens
        // Merge all token data into a single ctx object
        let mut ctx = serde_json::Map::new();
        for token in input_tokens {
            if let Some(data) = &token.data {
                if let Some(obj) = data.as_object() {
                    for (k, v) in obj {
                        ctx.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        let ctx_json = serde_json::to_string(&ctx).unwrap_or_else(|_| "{}".to_string());

        // Preamble that injects the publish() function and ctx
        let preamble = format!(
            r#"
globalThis.publish = (message, level = 'info') => {{
    console.log(JSON.stringify({{ __cb_publish: true, level, message, timestamp: new Date().toISOString() }}));
}};
globalThis.log = globalThis.publish;
globalThis.ctx = {};
"#,
            ctx_json
        );

        if let Some(ref code) = action.code {
            // Wrap user code in an async IIFE so return statements work
            let wrapped_code = format!(
                "{}\n(async () => {{\n{}\n}})().then(r => r !== undefined && console.log(JSON.stringify({{ __cb_result: true, value: r }})));",
                preamble,
                code
            );

            // Run inline code
            match action.runtime {
                cb_core::workflow::ScriptRuntime::Bun => {
                    // Bun uses -e for inline evaluation
                    cmd.arg("-e").arg(&wrapped_code);
                }
                cb_core::workflow::ScriptRuntime::Deno => {
                    cmd.arg("eval").arg(&wrapped_code);
                }
                cb_core::workflow::ScriptRuntime::Node => {
                    cmd.arg("-e").arg(&wrapped_code);
                }
            }
        } else if let Some(ref file) = action.file {
            cmd.arg("run").arg(file);
        } else {
            return Err("Script action must have either code or file".into());
        }

        let output = cmd.output().await?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);

            // Parse stdout for publish() calls and forward to NATS
            let mut regular_output = Vec::new();
            let mut published_messages: Vec<serde_json::Value> = Vec::new();
            let mut script_result: Option<serde_json::Value> = None;

            for line in stdout.lines() {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                    if parsed.get("__cb_publish").is_some() {
                        // This is a publish() call - forward to NATS and collect for output
                        let message = parsed.get("message").and_then(|m| m.as_str()).unwrap_or("");
                        let level = parsed
                            .get("level")
                            .and_then(|l| l.as_str())
                            .unwrap_or("info");
                        let timestamp = parsed
                            .get("timestamp")
                            .and_then(|t| t.as_str())
                            .unwrap_or("");

                        // Collect for output
                        published_messages.push(serde_json::json!({
                            "level": level,
                            "message": message,
                            "timestamp": timestamp,
                        }));

                        // Publish to NATS log stream
                        let log_payload = serde_json::json!({
                            "transitionRef": transition_ref,
                            "level": level,
                            "message": message,
                            "timestamp": timestamp,
                        });

                        let subject = format!(
                            "cb.runs.{}.logs.{}",
                            transition_ref.run_id, transition_ref.transition_id
                        );

                        if let Err(e) = self.nats.publish_jetstream(&subject, &log_payload).await {
                            warn!(error = %e, "Failed to publish script log to NATS");
                        }
                    } else if parsed.get("__cb_result").is_some() {
                        // This is the script's return value
                        script_result = parsed.get("value").cloned();
                    } else {
                        regular_output.push(line.to_string());
                    }
                } else {
                    regular_output.push(line.to_string());
                }
            }

            // Build output with published messages included
            let mut result = serde_json::json!({
                "status": "success",
            });

            // Include published messages if any
            if !published_messages.is_empty() {
                result["logs"] = serde_json::json!(published_messages);
            }

            // Include regular stdout if any
            let stdout_str = regular_output.join("\n");
            if !stdout_str.is_empty() {
                result["output"] = serde_json::json!(stdout_str);
            }

            // Include script return value if any
            if let Some(value) = script_result {
                result["result"] = value;
            }

            Ok(result)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("Script execution failed: {}", stderr).into())
        }
    }

    /// Publish TransitionFired event
    async fn publish_transition_fired(
        &self,
        transition_ref: &TransitionRef,
        task_id: Uuid,
        consumed_tokens: &[TokenData],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let payload = TransitionFiredPayload {
            transition_ref: transition_ref.clone(),
            consumed_tokens: consumed_tokens.to_vec(),
            task_id: Some(task_id),
            runner_id: Some(self.runner_id.clone()),
        };

        let subject =
            subjects::transition_fired(&transition_ref.run_id, &transition_ref.transition_id);
        self.nats.publish_jetstream(&subject, &payload).await?;

        debug!(subject = %subject, "Published TransitionFired event");
        Ok(())
    }

    /// Publish TransitionCompleted event
    async fn publish_transition_completed(
        &self,
        transition_ref: &TransitionRef,
        outputs: serde_json::Value,
        duration: Duration,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let payload = TransitionCompletedPayload {
            transition_ref: transition_ref.clone(),
            produced_tokens: vec![], // Controller will handle token production
            outputs: Some(outputs),
            resource_usage: Some(ResourceUsage {
                cpu_millis: Some(0),
                memory_bytes: Some(0),
                duration_ms: Some(duration.as_millis() as u64),
            }),
        };

        let subject =
            subjects::transition_completed(&transition_ref.run_id, &transition_ref.transition_id);
        self.nats.publish_jetstream(&subject, &payload).await?;

        debug!(subject = %subject, "Published TransitionCompleted event");
        Ok(())
    }

    /// Publish TransitionFailed event
    async fn publish_transition_failed(
        &self,
        transition_ref: &TransitionRef,
        error_message: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let payload = TransitionFailedPayload {
            transition_ref: transition_ref.clone(),
            error: ErrorInfo::new("EXECUTION_FAILED", error_message),
            attempt: Some(1),
            max_retries: None,
            will_retry: false,
        };

        let subject =
            subjects::transition_failed(&transition_ref.run_id, &transition_ref.transition_id);
        self.nats.publish_jetstream(&subject, &payload).await?;

        debug!(subject = %subject, "Published TransitionFailed event");
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| args.log_level.clone().into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let runner_id = args
        .runner_id
        .unwrap_or_else(|| format!("runner-{}", Uuid::new_v4().to_string()[..8].to_string()));

    info!(
        runner_id = %runner_id,
        pool = %args.pool,
        nats_url = %args.nats_url,
        max_concurrent = args.max_concurrent,
        "Starting Circuit Breaker Runner"
    );

    // Create work directory
    std::fs::create_dir_all(&args.work_dir)?;

    // Connect to NATS
    let nats_config = NatsConfig {
        urls: vec![args.nats_url.clone()],
        name: Some(format!("cb-runner-{}", runner_id)),
        ..Default::default()
    };

    let nats = NatsClient::connect(&nats_config).await?;
    info!("Connected to NATS");

    // Create runner instance
    let runner = Arc::new(Runner::new(
        runner_id.clone(),
        args.pool.clone(),
        nats,
        args.work_dir.clone(),
        Duration::from_secs(args.timeout),
        args.dagger_url.clone(),
    ));

    // Ensure stream exists
    let js = runner.nats.jetstream();

    // Create or get the RUNS stream
    let stream_config = async_nats::jetstream::stream::Config {
        name: streams::RUNS.to_string(),
        subjects: vec!["cb.runs.>".to_string()],
        retention: async_nats::jetstream::stream::RetentionPolicy::Limits,
        max_age: Duration::from_secs(7 * 24 * 60 * 60), // 7 days
        storage: async_nats::jetstream::stream::StorageType::File,
        ..Default::default()
    };

    match js.get_or_create_stream(stream_config).await {
        Ok(stream) => {
            info!(stream = %stream.cached_info().config.name, "Using stream");
        }
        Err(e) => {
            warn!(error = %e, "Failed to create stream, it may already exist");
        }
    }

    // Create durable consumer for task dispatch
    let consumer_config = async_nats::jetstream::consumer::pull::Config {
        durable_name: Some(format!("{}-{}", consumers::RUNNER_GROUP, args.pool)),
        filter_subject: format!("cb.runs.*.transitions.*.enabled"),
        ack_policy: async_nats::jetstream::consumer::AckPolicy::Explicit,
        ack_wait: Duration::from_secs(60),
        max_deliver: 3,
        ..Default::default()
    };

    let stream = js.get_stream(streams::RUNS).await?;
    let consumer = stream
        .get_or_create_consumer(
            &format!("{}-{}", consumers::RUNNER_GROUP, args.pool),
            consumer_config,
        )
        .await?;

    info!(
        consumer = %consumer.cached_info().name,
        "Subscribed to task dispatch events"
    );

    // Process messages
    let mut messages = consumer.messages().await?;

    info!("Runner ready - waiting for tasks...");

    // Semaphore for concurrency control
    let semaphore = Arc::new(tokio::sync::Semaphore::new(args.max_concurrent));

    loop {
        tokio::select! {
            Some(msg) = messages.next() => {
                match msg {
                    Ok(msg) => {
                        let runner = Arc::clone(&runner);
                        let permit = semaphore.clone().acquire_owned().await;

                        tokio::spawn(async move {
                            let _permit = permit;

                            // Parse the message
                            match serde_json::from_slice::<TaskDispatchMessage>(&msg.payload) {
                                Ok(task) => {
                                    // Check if this task is for our pool
                                    if !task.runner_pool.is_empty() && task.runner_pool != runner.pool {
                                        debug!(
                                            task_pool = %task.runner_pool,
                                            our_pool = %runner.pool,
                                            "Skipping task for different pool"
                                        );
                                        // Don't ack - let another runner handle it
                                        return;
                                    }

                                    match runner.process_task(task).await {
                                        Ok(()) => {
                                            if let Err(e) = msg.ack().await {
                                                error!(error = %e, "Failed to ack message");
                                            }
                                        }
                                        Err(e) => {
                                            error!(error = %e, "Failed to process task");
                                            // Negative ack to retry
                                            if let Err(e) = msg.ack_with(async_nats::jetstream::AckKind::Nak(None)).await {
                                                error!(error = %e, "Failed to nack message");
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    error!(error = %e, "Failed to parse task dispatch message");
                                    // Ack to avoid reprocessing malformed message
                                    let _ = msg.ack().await;
                                }
                            }
                        });
                    }
                    Err(e) => {
                        error!(error = %e, "Error receiving message");
                    }
                }
            }
            _ = tokio::signal::ctrl_c() => {
                info!("Received shutdown signal");
                break;
            }
        }
    }

    info!("Shutting down runner");
    Ok(())
}
