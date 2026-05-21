/**
 * GitHub Actions composite action resolver.
 *
 * Downloads action.yml from GitHub repositories, parses the composite
 * run steps, and substitutes input variables to produce executable
 * shell commands.
 *
 * This replaces the hardcoded action-to-shell mappings with a generic
 * resolver that works for any composite action.
 *
 * @module
 */

import { parse as parseYAML } from "yaml";

// ============ Types ============

/** A resolved composite action step — a shell command ready to execute. */
export interface ResolvedStep {
  /** Step ID from the action.yml (or generated). */
  id: string;
  /** The shell command to execute. */
  run: string;
  /** Shell to use (bash, sh, etc.). */
  shell: string;
  /** Environment variables for this step. */
  env?: Record<string, string>;
  /** Original name from action.yml. */
  name?: string;
  /** Condition from action.yml. */
  if?: string;
}

/** Parsed action.yml structure. */
interface ActionYml {
  name?: string;
  description?: string;
  inputs?: Record<
    string,
    {
      description?: string;
      required?: boolean;
      default?: string;
    }
  >;
  runs: {
    using: string;
    steps?: ActionStep[];
    /** For node/docker actions. */
    main?: string;
    /** Post-execution script (cleanup). */
    post?: string;
    image?: string;
  };
}

/** A step inside an action.yml composite action. */
interface ActionStep {
  id?: string;
  name?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  "working-directory"?: string;
}

/** Cache of fetched action.yml files to avoid repeated downloads. */
const actionCache = new Map<string, ActionYml>();

// ============ Public API ============

/**
 * Resolve a `uses:` reference to executable shell commands.
 *
 * For composite actions: fetches action.yml, parses steps, substitutes inputs.
 * For checkout/cache: returns null (no-op — source mounted, overlays handle caching).
 * For docker actions: returns the docker image reference (future: OCI overlay).
 * For node actions: not yet supported.
 *
 * @param uses - The `uses:` value (e.g., "dtolnay/rust-toolchain@stable")
 * @param inputs - The `with:` values from the workflow step
 * @returns Array of resolved shell steps, or null if the action should be skipped
 */
export async function resolveAction(
  uses: string,
  inputs?: Record<string, unknown>,
): Promise<ResolvedStep[] | null> {
  // Skip actions that are no-ops in our execution model
  if (isSkippableAction(uses)) {
    return null;
  }

  // Parse the uses reference
  const parsed = parseUsesRef(uses);
  if (!parsed) {
    console.warn(`Warning: cannot parse action reference '${uses}', skipping`);
    return null;
  }

  // Fetch and parse the action.yml
  const actionYml = await fetchActionYml(parsed.owner, parsed.repo, parsed.ref);
  if (!actionYml) {
    console.warn(`Warning: failed to fetch action.yml for '${uses}', skipping`);
    return null;
  }

  // Node.js-based actions — download the action and run with node
  if (actionYml.runs.using?.startsWith("node")) {
    const mainFile = actionYml.runs.main;
    if (!mainFile) {
      console.warn(`Warning: Node action '${uses}' has no runs.main, skipping`);
      return null;
    }
    return resolveNodeAction(uses, parsed, actionYml, inputs);
  }

  // Docker-based actions — not yet supported
  if (actionYml.runs.using === "docker") {
    const image = actionYml.runs.image;
    if (image && image.startsWith("docker://")) {
      return [
        {
          id: "docker-action",
          run: `echo "Docker action image: ${image} (not yet supported)"`,
          shell: "sh",
        },
      ];
    }
    console.warn(
      `Warning: Docker action '${uses}' not yet supported, skipping`,
    );
    return null;
  }

  // Unknown action type
  if (actionYml.runs.using !== "composite") {
    console.warn(
      `Warning: action '${uses}' uses '${actionYml.runs.using}' (unsupported), skipping`,
    );
    return null;
  }

  // Resolve inputs: merge provided values with defaults from action.yml
  const resolvedInputs = resolveInputs(actionYml, inputs);

  // GitHub Actions convention: inputs are passed as INPUT_* env vars.
  // The action's shell scripts access them via ${{ inputs.foo }} which
  // the action.yml's env: section maps to INPUT_FOO. We set both the
  // INPUT_* vars AND the lowercase names so action scripts work whether
  // they use the env mapping or the shell var directly.
  const inputExports: string[] = [];
  for (const [name, value] of Object.entries(resolvedInputs)) {
    const envKey = `INPUT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    inputExports.push(`export ${envKey}=${shellQuote(value)}`);
    // Also export as the lowercase name for scripts that use $toolchain etc.
    inputExports.push(`export ${name}=${shellQuote(value)}`);
  }

  // Build substitution context for things we CAN resolve statically
  // (inputs, runner info). Step outputs are NOT resolved here — they're
  // handled at runtime via GITHUB_OUTPUT.
  const context = buildSubstitutionContext(resolvedInputs, parsed);

  // GitHub Actions environment shim.
  // Composite actions use $GITHUB_OUTPUT, $GITHUB_ENV, and $GITHUB_PATH
  // to communicate between steps. We create temp files and a helper
  // function that reads step outputs at runtime.
  const shimSetup = [
    "mkdir -p /tmp/.cb",
    'export GITHUB_OUTPUT="/tmp/.cb/github_output"',
    'export GITHUB_ENV="/tmp/.cb/github_env"',
    'export GITHUB_PATH="/tmp/.cb/github_path"',
    'export GITHUB_STEP_SUMMARY="/dev/null"',
    'export RUNNER_TEMP="/tmp"',
    "touch $GITHUB_OUTPUT $GITHUB_ENV $GITHUB_PATH",
    "",
    "# Helper: read a step output from GITHUB_OUTPUT",
    '_gh_output() { grep "^$1=" "$GITHUB_OUTPUT" 2>/dev/null | head -1 | cut -d= -f2- || true; }',
    "",
    "# Helper: source GITHUB_ENV and GITHUB_PATH between steps",
    "_gh_source_env() {",
    '  if [ -s "$GITHUB_ENV" ]; then while IFS= read -r _line || [ -n "$_line" ]; do [ -n "$_line" ] && export "$_line"; done < "$GITHUB_ENV"; fi',
    '  if [ -s "$GITHUB_PATH" ]; then while IFS= read -r _line || [ -n "$_line" ]; do [ -n "$_line" ] && export PATH="$_line:$PATH"; done < "$GITHUB_PATH"; fi',
    "  return 0",
    "}",
  ].join("\n");

  // Build the script: shim setup, input exports, then each step
  const scriptLines: string[] = [];
  scriptLines.push(shimSetup);
  scriptLines.push("");
  scriptLines.push("# Action inputs as environment variables");
  scriptLines.push(inputExports.join("\n"));
  scriptLines.push("");

  for (let i = 0; i < (actionYml.runs.steps?.length ?? 0); i++) {
    const step = actionYml.runs.steps![i];

    // Skip non-run steps (nested uses: inside composites)
    if (!step.run) {
      continue;
    }

    // Skip Windows-only steps
    if (step.if) {
      const condition = substituteVariables(step.if, context);
      if (
        condition === "false" ||
        condition.includes("runner.os == 'Windows'") ||
        condition.includes("runner.os != 'Linux'")
      ) {
        continue;
      }
    }

    // Source env/path changes from previous steps
    scriptLines.push("_gh_source_env");
    scriptLines.push("");

    // Set step-level env vars
    if (step.env) {
      for (const [key, value] of Object.entries(step.env)) {
        // Substitute what we can statically. For step output references
        // like ${{ steps.parse.outputs.toolchain }}, replace with a
        // shell command that reads from GITHUB_OUTPUT at runtime.
        const resolved = substituteWithRuntimeOutputs(String(value), context);
        scriptLines.push(`export ${key}=${shellQuote(resolved)}`);
      }
    }

    // Substitute the run command — same treatment for step output refs
    const resolvedRun = substituteWithRuntimeOutputs(step.run, context);

    const stepId = step.id ?? `step-${i}`;
    scriptLines.push(`# Step: ${step.name ?? stepId}`);
    scriptLines.push(resolvedRun);
    scriptLines.push("");
  }

  // Final env source so the caller gets everything
  scriptLines.push("_gh_source_env");

  const combinedScript = scriptLines.join("\n");

  return [
    {
      id: "composite",
      run: combinedScript,
      shell: "bash",
      name: actionYml.name ?? uses,
    },
  ];
}

/**
 * Clear the action.yml cache.
 */
export function clearActionCache(): void {
  actionCache.clear();
}

// ============ Internals ============

/** Parsed `uses:` reference. */
interface UsesRef {
  owner: string;
  repo: string;
  ref: string;
  /** Subdirectory path within the repo (for monorepo actions). */
  path?: string;
}

/**
 * Parse a `uses:` reference into its components.
 *
 * Supports:
 *   owner/repo@ref
 *   owner/repo/path@ref
 */
function parseUsesRef(uses: string): UsesRef | null {
  // Skip local actions (./path)
  if (uses.startsWith(".")) {
    return null;
  }

  const atIndex = uses.indexOf("@");
  if (atIndex === -1) {
    return null;
  }

  const pathPart = uses.substring(0, atIndex);
  const ref = uses.substring(atIndex + 1);

  const segments = pathPart.split("/");
  if (segments.length < 2) {
    return null;
  }

  return {
    owner: segments[0],
    repo: segments[1],
    ref,
    path: segments.length > 2 ? segments.slice(2).join("/") : undefined,
  };
}

/**
 * Fetch and parse an action.yml from a GitHub repository.
 * Results are cached.
 */
async function fetchActionYml(
  owner: string,
  repo: string,
  ref: string,
  path?: string,
): Promise<ActionYml | null> {
  const cacheKey = `${owner}/${repo}@${ref}${path ? `/${path}` : ""}`;

  if (actionCache.has(cacheKey)) {
    return actionCache.get(cacheKey)!;
  }

  const basePath = path ? `${path}/` : "";

  // Try action.yml first, then action.yaml
  for (const filename of ["action.yml", "action.yaml"]) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${basePath}${filename}`;

    try {
      const response = await fetch(url);
      if (response.ok) {
        const text = await response.text();
        const parsed: ActionYml = parseYAML(text);
        actionCache.set(cacheKey, parsed);
        return parsed;
      }
    } catch {
      // Try next filename
    }
  }

  return null;
}

/**
 * Resolve action inputs by merging provided `with:` values with
 * defaults from the action.yml `inputs:` section.
 */
function resolveInputs(
  actionYml: ActionYml,
  provided?: Record<string, unknown>,
): Record<string, string> {
  const resolved: Record<string, string> = {};

  // Start with defaults from action.yml
  if (actionYml.inputs) {
    for (const [name, spec] of Object.entries(actionYml.inputs)) {
      if (spec.default !== undefined) {
        resolved[name] = String(spec.default);
      }
    }
  }

  // Override with provided values
  if (provided) {
    for (const [name, value] of Object.entries(provided)) {
      if (value !== undefined && value !== null) {
        resolved[name] = String(value);
      }
    }
  }

  return resolved;
}

/**
 * Build the substitution context for ${{ ... }} variable replacement.
 */
function buildSubstitutionContext(
  inputs: Record<string, string>,
  ref: UsesRef,
): Record<string, string> {
  const ctx: Record<string, string> = {};

  // inputs.* — the resolved input values
  for (const [name, value] of Object.entries(inputs)) {
    ctx[`inputs.${name}`] = value;
  }

  // runner.* — hardcoded for our Linux VM environment
  ctx["runner.os"] = "Linux";
  ctx["runner.arch"] = "ARM64";
  ctx["runner.temp"] = "/tmp";

  // github.* — minimal set for actions that reference these
  ctx["github.action_path"] = `/tmp/actions/${ref.owner}/${ref.repo}`;

  // steps.*.outputs.* — we track these as steps execute
  // For now, provide empty defaults so substitution doesn't break
  return ctx;
}

/**
 * Substitute ${{ expression }} placeholders in a string.
 *
 * Handles:
 *   ${{ inputs.toolchain }}         → resolved input value
 *   ${{ runner.os }}                → "Linux"
 *   ${{ steps.parse.outputs.foo }} → value from prior step output
 *   ${{...}}                       → whitespace-insensitive
 *
 * Unresolved expressions are left as empty strings to avoid
 * breaking shell commands.
 */
function substituteVariables(
  template: string | number | boolean | undefined | null,
  context: Record<string, string>,
): string {
  if (template === undefined || template === null) return "";
  const str = String(template);
  return str.replace(
    /\$\{\{\s*([^}]+?)\s*\}\}/g,
    (_match, expression: string) => {
      const expr = expression.trim();

      // Direct context lookup
      if (context[expr] !== undefined) {
        return context[expr];
      }

      // Handle ternary-like expressions: condition && 'value' || ''
      const ternaryMatch = expr.match(
        /^(.+?)\s*&&\s*'([^']*?)'\s*\|\|\s*'([^']*?)'$/,
      );
      if (ternaryMatch) {
        const [, condition, trueVal, falseVal] = ternaryMatch;
        const resolved = evaluateSimpleCondition(condition.trim(), context);
        return resolved ? trueVal : falseVal;
      }

      // Handle simple && expressions: condition && ' --flag value'
      const andMatch = expr.match(/^(.+?)\s*&&\s*'([^']*?)'$/);
      if (andMatch) {
        const [, condition, value] = andMatch;
        const resolved = evaluateSimpleCondition(condition.trim(), context);
        return resolved ? value : "";
      }

      // Unresolved — return empty string
      return "";
    },
  );
}

/**
 * Like substituteVariables, but for step output references
 * (${{ steps.X.outputs.Y }}), generates a shell command that reads
 * from $GITHUB_OUTPUT at runtime instead of returning empty string.
 */
function substituteWithRuntimeOutputs(
  template: string,
  context: Record<string, string>,
): string {
  if (template === undefined || template === null) return "";
  const str = String(template);
  return str.replace(
    /\$\{\{\s*([^}]+?)\s*\}\}/g,
    (_match, expression: string) => {
      const expr = expression.trim();

      // Direct context lookup (inputs, runner, etc.)
      if (context[expr] !== undefined) {
        return context[expr];
      }

      // steps.X.outputs.Y → read from GITHUB_OUTPUT at runtime
      const stepsMatch = expr.match(/^steps\.([^.]+)\.outputs\.([^.]+)$/);
      if (stepsMatch) {
        const [, , outputName] = stepsMatch;
        return `$(_gh_output ${outputName})`;
      }

      // Handle ternary-like expressions
      const ternaryMatch = expr.match(
        /^(.+?)\s*&&\s*'([^']*?)'\s*\|\|\s*'([^']*?)'$/,
      );
      if (ternaryMatch) {
        const [, condition, trueVal, falseVal] = ternaryMatch;
        const resolved = evaluateSimpleCondition(condition.trim(), context);
        return resolved ? trueVal : falseVal;
      }

      // Handle simple && expressions
      const andMatch = expr.match(/^(.+?)\s*&&\s*'([^']*?)'$/);
      if (andMatch) {
        const [, condition, value] = andMatch;
        const resolved = evaluateSimpleCondition(condition.trim(), context);
        return resolved ? value : "";
      }

      // Unresolved — return empty string
      return "";
    },
  );
}

/**
 * Evaluate simple boolean conditions found in action.yml expressions.
 *
 * Handles:
 *   runner.os == 'Linux'              → true/false
 *   runner.os != 'Windows'            → true/false
 *   inputs.components                 → truthy check
 *   steps.parse.outputs.toolchain == 'nightly' && inputs.components
 */
function evaluateSimpleCondition(
  condition: string,
  context: Record<string, string>,
): boolean {
  // Equality: foo == 'bar'
  const eqMatch = condition.match(/^(.+?)\s*==\s*'([^']*?)'$/);
  if (eqMatch) {
    const [, key, expected] = eqMatch;
    return context[key.trim()] === expected;
  }

  // Inequality: foo != 'bar'
  const neqMatch = condition.match(/^(.+?)\s*!=\s*'([^']*?)'$/);
  if (neqMatch) {
    const [, key, expected] = neqMatch;
    return context[key.trim()] !== expected;
  }

  // Compound &&
  if (condition.includes("&&")) {
    return condition
      .split("&&")
      .every((part) => evaluateSimpleCondition(part.trim(), context));
  }

  // Simple truthy check: inputs.components → is the value non-empty?
  const value = context[condition];
  return value !== undefined && value !== "" && value !== "false";
}

// ============ Node.js Action Execution ============

/**
 * Resolve a Node.js-based GitHub Action by downloading its tarball and
 * generating a script that runs `node <main>` with the proper INPUT_*
 * environment variables.
 *
 * This supports ANY Node.js action — not just known ones. The action's
 * bundled dist/index.js runs against the same GITHUB_OUTPUT / GITHUB_ENV /
 * GITHUB_PATH shim that composite actions use.
 */
function resolveNodeAction(
  uses: string,
  parsed: UsesRef,
  actionYml: ActionYml,
  inputs?: Record<string, unknown>,
): ResolvedStep[] {
  const mainFile = actionYml.runs.main!;
  const postFile = actionYml.runs.post as string | undefined;

  // Resolve inputs: merge provided values with defaults
  const resolvedInputs = resolveInputs(actionYml, inputs);

  // Build INPUT_* exports
  const inputExports: string[] = [];
  for (const [name, value] of Object.entries(resolvedInputs)) {
    const envKey = `INPUT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    inputExports.push(`export ${envKey}=${shellQuote(value)}`);
  }

  // The action is downloaded to /tmp/.cb/actions/<owner>/<repo>/<ref>/
  // and executed with `node <main>`
  const actionDir = `/tmp/.cb/actions/${parsed.owner}/${parsed.repo}/${parsed.ref}`;
  const tarballUrl = `https://github.com/${parsed.owner}/${parsed.repo}/archive/${parsed.ref}.tar.gz`;

  // Detect architecture for Node binary download
  // Node distributes as node-v{ver}-linux-{x64,arm64}.tar.xz
  const nodeVersion = "20.18.3";

  const script = [
    `# Node.js action: ${uses}`,
    `ACTION_DIR="${actionDir}"`,
    "",
    "# Install Node.js binary if not already present (standalone, no apt)",
    `if ! command -v node >/dev/null 2>&1; then`,
    `  ARCH=$(uname -m)`,
    `  case "$ARCH" in`,
    `    x86_64)  NODE_ARCH="x64" ;;`,
    `    aarch64) NODE_ARCH="arm64" ;;`,
    `    *)       echo "Unsupported arch: $ARCH"; exit 1 ;;`,
    `  esac`,
    `  NODE_URL="https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-\${NODE_ARCH}.tar.xz"`,
    `  echo "Installing Node.js v${nodeVersion} (\${NODE_ARCH})..."`,
    `  curl -sL "$NODE_URL" | tar xJ --strip-components=1 -C /usr/local`,
    `  echo "Node $(node --version) installed"`,
    `fi`,
    "",
    "# Download action if not already present",
    `if [ ! -f "$ACTION_DIR/${mainFile}" ]; then`,
    `  mkdir -p "$ACTION_DIR"`,
    `  echo "Downloading ${uses}..."`,
    `  curl -sL "${tarballUrl}" | tar xz --strip-components=1 -C "$ACTION_DIR"`,
    `fi`,
    "",
    "# Set INPUT_* environment variables",
    ...inputExports,
    "",
    "# Run the action",
    `cd "$ACTION_DIR"`,
    `node "${mainFile}"`,
    "",
    // Some actions have a post step (cleanup). Run it if it exists.
    ...(postFile
      ? [
          `# Post step`,
          `if [ -f "$ACTION_DIR/${postFile}" ]; then`,
          `  export STATE_isPost=true`,
          `  node "${postFile}"`,
          `fi`,
        ]
      : []),
  ].join("\n");

  return [
    {
      id: "node-action",
      run: script,
      shell: "bash",
      name: actionYml.name ?? uses,
    },
  ];
}

/**
 * Actions that are skipped in our execution model.
 */
function isSkippableAction(uses: string): boolean {
  const action = uses.toLowerCase();

  // checkout — source is already mounted at /workspace via --volume
  if (action.startsWith("actions/checkout")) return true;

  // cache — overlay snapshots handle caching automatically
  if (action.startsWith("actions/cache")) return true;

  // artifact upload/download — handled by overlay seal/restore
  if (action.startsWith("actions/upload-artifact")) return true;
  if (action.startsWith("actions/download-artifact")) return true;

  return false;
}

/**
 * Shell-quote a value for safe use in `export KEY=VALUE`.
 */
function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(s)) {
    return s;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}
