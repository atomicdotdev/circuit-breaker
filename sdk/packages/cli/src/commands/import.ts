/**
 * `cb import` — convert existing GitHub Actions workflows into native circuits.
 *
 * For each `uses:` step, fetches the action's action.yml from GitHub and inlines
 * the shell steps if it's a composite action.  JavaScript/Docker actions fall back
 * to a comment.  Infrastructure actions (checkout, cache, artifacts) are silently
 * skipped since the CB runner mounts the workspace.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parse as parseYAML } from "yaml";
import { s } from "../lib/symbols";

// ─── YAML types ───────────────────────────────────────────────────────────────

interface RawStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  if?: unknown;
  id?: string;
  shell?: string;
}

interface RawJob {
  "runs-on"?: string | string[];
  steps?: RawStep[];
  needs?: string | string[];
  name?: string;
  if?: unknown;
  strategy?: {
    matrix?: Record<string, unknown>;
    "fail-fast"?: boolean;
  };
  env?: Record<string, unknown>;
}

interface RawWorkflow {
  name?: string;
  jobs: Record<string, RawJob>;
  env?: Record<string, unknown>;
}

interface ActionYaml {
  inputs?: Record<string, { default?: unknown; required?: boolean }>;
  runs: {
    using: string;           // "composite" | "node20" | "docker" | ...
    steps?: RawStep[];
  };
}

// ─── Action.yml fetching ──────────────────────────────────────────────────────

const actionCache = new Map<string, ActionYaml | null>();

async function fetchAction(uses: string): Promise<ActionYaml | null> {
  if (actionCache.has(uses)) return actionCache.get(uses)!;

  const match = uses.match(/^([^/@]+\/[^/@]+)@(.+)$/);
  if (!match) { actionCache.set(uses, null); return null; }

  const [, repo, ref] = match;
  for (const filename of ["action.yml", "action.yaml"]) {
    const url = `https://raw.githubusercontent.com/${repo}/${ref}/${filename}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const parsed = parseYAML(await res.text()) as ActionYaml;
        actionCache.set(uses, parsed);
        return parsed;
      }
    } catch { /* network/timeout — try next */ }
  }

  actionCache.set(uses, null);
  return null;
}

// ─── Substitution context ─────────────────────────────────────────────────────

interface SubstContext {
  matrix?: Record<string, string>;
  env?: Record<string, string>;
}

// ─── Expression substitution ─────────────────────────────────────────────────

/**
 * Replace ${{...}} GitHub Actions expressions with concrete values or shell vars.
 *
 * - inputs.X          → actual input value
 * - matrix.X          → resolved matrix value for this job
 * - runner.os/arch    → Linux / X64 (we assume Linux)
 * - runner.temp       → /tmp
 * - steps.ID.outputs.KEY → $_step_ID_KEY  (shell var set by output-sourcing)
 * - env.X             → resolved env value or $X shell var
 * - runner.os == 'Windows' && A || B → B  (Windows branch collapsed)
 * - Anything else     → "" (not evaluable at import time; empty is safe)
 */
function subst(text: string, inputs: Record<string, string>, ctx: SubstContext = {}): string {
  return text.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, raw: string) => {
    const e = raw.trim();

    // OR-chain fallback: A || B || '' — return first non-empty resolved value.
    // Must come before single-token checks so "inputs.X || inputs.Y" is handled correctly.
    if (e.includes("||")) {
      const parts = e.split("||").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
      for (const part of parts) {
        if (!part) continue;
        const val = subst(`\${{ ${part} }}`, inputs, ctx);
        if (val !== "") return val;
      }
      return "";
    }

    if (e.startsWith("inputs.")) return inputs[e.slice(7)] ?? "";
    if (e.startsWith("matrix.") && ctx.matrix) return ctx.matrix[e.slice(7)] ?? "";
    if (e === "runner.os") return "Linux";
    if (e === "runner.arch") return "X64";
    if (e === "runner.temp") return "/tmp";
    if (e === "runner.tool_cache") return "/opt/hostedtoolcache";
    if (e.startsWith("env.")) {
      const key = e.slice(4);
      return ctx.env?.[key] ?? `$${key}`;
    }

    const stepOut = e.match(/^steps\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_]+)$/);
    if (stepOut) return `$_step_${stepOut[1].replace(/[^a-zA-Z0-9]/g, "_")}_${stepOut[2]}`;

    // Ternary: runner.os == 'Windows' && X || Y  →  Y
    const winTrue = e.match(/runner\.os\s*==\s*['"]Windows['"]\s*&&\s*(.+?)\s*\|\|\s*(.*)/i);
    if (winTrue) return (winTrue[2] ?? "").replace(/^['"]|['"]$/g, "");

    // Ternary: runner.os != 'Windows' && X || Y  →  X
    const winFalse = e.match(/runner\.os\s*!=\s*['"]Windows['"]\s*&&\s*(.+?)\s*\|\|\s*(.*)/i);
    if (winFalse) return (winFalse[1] ?? "").replace(/^['"]|['"]$/g, "");

    return ""; // expression not evaluable at import time — empty string is safe
  });
}

// ─── Step condition evaluation ────────────────────────────────────────────────

/**
 * Evaluate a GHA `if:` condition given substitution context.
 * Returns false only when the condition definitely evaluates to false/falsy.
 * Defaults to true (include the step) when uncertain.
 */
function evalCondition(condition: string, ctx: SubstContext): boolean {
  const c = condition.trim();

  // Unwrap ${{ }} if present
  const inner = c.replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();

  // Logical NOT: !expr
  if (inner.startsWith("!")) {
    return !evalCondition(inner.slice(1).trim(), ctx);
  }

  // Windows-only checks
  if (/runner\.os\s*==\s*['"]Windows['"]/i.test(inner)) return false;

  // matrix.X (truthiness)
  const matrixVar = inner.match(/^matrix\.([a-zA-Z0-9_]+)$/);
  if (matrixVar) {
    if (!ctx.matrix) return false;
    const val = ctx.matrix[matrixVar[1]];
    return !!val && val !== "" && val !== "false" && val !== "0";
  }

  // matrix.X == 'value'
  const matrixEq = inner.match(/^matrix\.([a-zA-Z0-9_]+)\s*==\s*['"]([^'"]*)['"]\s*$/);
  if (matrixEq) {
    return (ctx.matrix?.[matrixEq[1]] ?? "") === matrixEq[2];
  }

  // matrix.X != 'value'
  const matrixNe = inner.match(/^matrix\.([a-zA-Z0-9_]+)\s*!=\s*['"]([^'"]*)['"]\s*$/);
  if (matrixNe) {
    return (ctx.matrix?.[matrixNe[1]] ?? "") !== matrixNe[2];
  }

  // runner.os == 'X' type checks that we can resolve
  const resolvedCond = subst(`\${{ ${inner} }}`, {}, ctx);
  if (resolvedCond === "" || resolvedCond === "false" || resolvedCond === "0") return false;

  return true; // default: include
}

// ─── Composite action inlining ────────────────────────────────────────────────

/**
 * Inline a composite action's steps as a single shell script block.
 *
 * Strategy:
 *  - Assume Linux (skip `if: runner.os == 'Windows'` steps)
 *  - Set GITHUB_OUTPUT / GITHUB_ENV / GITHUB_PATH to real temp files so the
 *    action's own echo "key=value" >> $GITHUB_OUTPUT lines work unchanged
 *  - After each step that has an `id`, source $GITHUB_OUTPUT into shell vars
 *    named _step_<safeId>_<key> (hyphens in id replaced with underscores)
 *  - Values are properly quoted in eval to handle spaces
 *  - Substitute ${{inputs.*}}, ${{steps.*.outputs.*}}, ${{matrix.*}} expressions
 */
function inlineComposite(action: ActionYaml, withInputs: Record<string, unknown>, ctx: SubstContext = {}): string {
  const steps = action.runs.steps ?? [];

  // Build resolved inputs (defaults overridden by with: values).
  // with: values may contain ${{ matrix.X }} / ${{ env.X }} expressions from the
  // outer job context — resolve them now so composite steps see concrete values.
  const inputs: Record<string, string> = {};
  for (const [k, def] of Object.entries(action.inputs ?? {})) {
    if (def.default !== undefined) inputs[k] = String(def.default);
  }
  for (const [k, v] of Object.entries(withInputs)) {
    inputs[k] = subst(String(v), {}, ctx);
  }

  const lines: string[] = [
    "# --- composite action inlined by cb import ---",
    "_CB_GHO=$(mktemp); _CB_GHE=$(mktemp); _CB_GHP=$(mktemp)",
    "GITHUB_OUTPUT=$_CB_GHO GITHUB_ENV=$_CB_GHE GITHUB_PATH=$_CB_GHP",
    "",
  ];

  for (const step of steps) {
    if (!step.run) continue;

    // Skip steps whose condition evaluates to false
    if (step.if != null && !evalCondition(String(step.if), ctx)) continue;

    // Step-level env vars
    for (const [k, v] of Object.entries(step.env ?? {})) {
      lines.push(`export ${k}=${subst(String(v), inputs, ctx)}`);
    }

    // The run script itself
    lines.push(subst(step.run.trimEnd(), inputs, ctx));

    // After each step with an id: source GITHUB_OUTPUT → _step_<safeId>_<key> vars.
    // Sanitize id (replace non-alphanumeric with _) for valid shell variable names.
    // Quote the value with \" to handle values that contain spaces.
    if (step.id) {
      const safeId = step.id.replace(/[^a-zA-Z0-9]/g, "_");
      lines.push(
        `while IFS='=' read -r _k _v; do eval "_step_${safeId}_\${_k}=\\"\${_v}\\""; done < "$_CB_GHO" && > "$_CB_GHO"`,
      );
    }

    // Source GITHUB_ENV and GITHUB_PATH for subsequent steps
    lines.push(
      `while IFS='=' read -r _k _v; do export "$_k=$_v"; done < "$_CB_GHE" && > "$_CB_GHE"`,
      `while read -r _p; do export PATH="$_p:$PATH"; done < "$_CB_GHP" && > "$_CB_GHP"`,
      "",
    );
  }

  lines.push("rm -f \"$_CB_GHO\" \"$_CB_GHE\" \"$_CB_GHP\"");
  lines.push("# --- end composite action ---");
  return lines.join("\n");
}

// ─── Step resolution ──────────────────────────────────────────────────────────

async function resolveStep(step: RawStep, ctx: SubstContext): Promise<string | null> {
  if (!step.uses) return null;

  const action = await fetchAction(step.uses);
  if (!action) return null;                       // network failure → comment
  if (action.runs.using !== "composite") return null; // JS/Docker → comment

  return inlineComposite(action, step.with ?? {}, ctx);
}

// ─── Job script assembly ──────────────────────────────────────────────────────

async function jobScript(job: RawJob, ctx: SubstContext): Promise<string> {
  const parts: string[] = [];

  for (const step of job.steps ?? []) {
    // Evaluate step-level if: condition — skip steps that won't run
    if (step.if != null && !evalCondition(String(step.if), ctx)) continue;

    if (step.run) {
      parts.push(subst(step.run.trim(), {}, ctx));
      continue;
    }
    if (!step.uses) continue;
    if (isSkippable(step.uses)) {
      // For artifact download steps, create an empty target directory so subsequent
      // steps that reference it don't fail immediately.
      if (step.uses.toLowerCase().startsWith("actions/download-artifact")) {
        const artifactPath = step.with?.path ? String(step.with.path) : "artifacts";
        parts.push(`mkdir -p ${JSON.stringify(artifactPath)} 2>/dev/null || true`);
      }
      continue;
    }

    const inlined = await resolveStep(step, ctx);
    if (inlined !== null) {
      parts.push(inlined);
    } else {
      // Couldn't fetch or not a composite action — leave a comment
      const label = step.name ? ` (${step.name})` : "";
      const withLines = step.with && Object.keys(step.with).length > 0
        ? Object.entries(step.with).map(([k, v]) => `#   ${k}: ${v}`)
        : [];
      parts.push([`# TODO: uses: ${step.uses}${label}`, ...withLines].join("\n"));
    }
  }

  const script = parts.join("\n");

  // If the script publishes a GitHub release, skip gracefully when running
  // locally without auth rather than failing the whole check run.
  if (/\bgh\s+release\s+(create|edit)\b/.test(script)) {
    return (
      '[ -z "${GITHUB_TOKEN:-}" ] && echo "Skipping release: GITHUB_TOKEN not set" && exit 0\n' +
      script
    );
  }

  return script;
}

function isSkippable(uses: string): boolean {
  const u = uses.toLowerCase();
  return (
    u.startsWith("actions/checkout") ||
    u.startsWith("actions/cache") ||
    u.startsWith("actions/upload-artifact") ||
    u.startsWith("actions/download-artifact")
  );
}

// ─── Matrix resolution ────────────────────────────────────────────────────────

/**
 * Pick the best matrix combination for inner-loop execution.
 * Prefers ubuntu non-cross entries; falls back to first non-windows entry.
 */
function resolveMatrix(strategy: RawJob["strategy"]): Record<string, string> | null {
  if (!strategy?.matrix) return null;
  const matrix = strategy.matrix;

  // Detect host architecture so we prefer a natively-runnable matrix entry.
  // process.arch: "arm64" on Apple Silicon / aarch64 Linux; "x64" on x86_64.
  const hostIsArm = process.arch === "arm64" || process.arch === "aarch64";
  const nativeArch = hostIsArm ? "aarch64" : "x86_64";

  // Handle include-based matrix (list of full matrix objects)
  if (Array.isArray(matrix.include)) {
    const includes = matrix.include as Record<string, unknown>[];
    const isUbuntu = (e: Record<string, unknown>) => typeof e.os === "string" && e.os.includes("ubuntu");
    const hasNativeTarget = (e: Record<string, unknown>) =>
      typeof e.target === "string" && e.target.includes(nativeArch);

    const best =
      // 1. Ubuntu + native arch target (no cross flag needed — it's native on this VM)
      includes.find((e) => isUbuntu(e) && hasNativeTarget(e)) ??
      // 2. Ubuntu + no explicit cross flag
      includes.find((e) => isUbuntu(e) && !e.cross) ??
      // 3. Any non-windows
      includes.find((e) => typeof e.os === "string" && !e.os.includes("windows")) ??
      includes[0];
    if (!best) return null;
    // Clear the cross flag for the resolved entry — on the native VM it's a native build
    const resolved = Object.fromEntries(
      Object.entries(best).map(([k, v]) => [k, v == null ? "" : String(v)]),
    );
    if (hasNativeTarget(best)) resolved["cross"] = "";
    return resolved;
  }

  // Handle simple array matrix: { os: [ubuntu, macos, windows], ... }
  const result: Record<string, string> = {};
  for (const [key, values] of Object.entries(matrix)) {
    if (!Array.isArray(values)) {
      result[key] = String(values ?? "");
      continue;
    }
    const preferred =
      values.find((v) => typeof v === "string" && v.includes("ubuntu") && v.includes(nativeArch)) ??
      values.find((v) => typeof v === "string" && v.includes("ubuntu"));
    result[key] = String(preferred ?? values[0] ?? "");
  }
  return Object.keys(result).length > 0 ? result : null;
}

// ─── Circuit code generation ──────────────────────────────────────────────────

function slug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizeNeeds(needs: string | string[] | undefined): string[] {
  if (!needs) return [];
  return typeof needs === "string" ? [needs] : needs;
}

function computeLevels(jobs: Record<string, RawJob>): string[][] {
  const levels: string[][] = [];
  const placed = new Set<string>();
  while (placed.size < Object.keys(jobs).length) {
    const level: string[] = [];
    for (const [id, job] of Object.entries(jobs)) {
      if (placed.has(id)) continue;
      if (normalizeNeeds(job.needs).every((n) => placed.has(n))) level.push(id);
    }
    if (level.length === 0) break;
    level.forEach((id) => placed.add(id));
    levels.push(level);
  }
  return levels;
}

function formatScript(script: string): string {
  if (!script.includes("\n")) return JSON.stringify(script);
  const escaped = script
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return "`" + escaped + "`";
}

async function generateCircuit(name: string, wf: RawWorkflow): Promise<string | null> {
  const levels = computeLevels(wf.jobs);
  if (levels.length === 0) return null;

  // Build workflow-level env context
  const workflowEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(wf.env ?? {})) {
    workflowEnv[k] = String(v);
  }

  const lines: string[] = [
    `import { workflow } from "@circuit-breaker/core";`,
    ``,
    `export default workflow(${JSON.stringify(slug(name))})`,
    `  .place("start", { initialTokens: 1 })`,
  ];

  // Declare places for sequential levels upfront
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]!;
    if (level.length === 1) {
      lines.push(`  .place(${JSON.stringify(i === levels.length - 1 ? "done" : `after-${slug(level[0]!)}`)})`);
    }
  }

  let from = "start";
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]!;
    const isLast = i === levels.length - 1;

    if (level.length === 1) {
      const jobId = level[0]!;
      const job = wf.jobs[jobId]!;
      const matrix = resolveMatrix(job.strategy);
      const ctx: SubstContext = { matrix: matrix ?? undefined, env: workflowEnv };
      const script = await jobScript(job, ctx);
      const to = isLast ? "done" : `after-${slug(jobId)}`;
      lines.push(
        `  .transition(${JSON.stringify(slug(jobId))})`,
        `    .from(${JSON.stringify(from)}).to(${JSON.stringify(to)})`,
        script ? `    .script(${formatScript(script)})` : `    .noop()`,
        `    .done()`,
      );
      from = to;
    } else {
      const to = isLast ? "done" : `after-${level.map(slug).join("-")}`;
      lines.push(`  .fanout(${JSON.stringify(from)}, [`);
      for (const jobId of level) {
        const job = wf.jobs[jobId]!;
        const matrix = resolveMatrix(job.strategy);
        const ctx: SubstContext = { matrix: matrix ?? undefined, env: workflowEnv };
        const script = await jobScript(job, ctx);
        lines.push(`    w => w.transition(${JSON.stringify(slug(jobId))})${script ? `.script(${formatScript(script)})` : `.noop()`},`);
      }
      lines.push(`  ])`, `  .join(${JSON.stringify(to)})`);
      from = to;
    }
  }

  lines.push(`  .build();`);
  return lines.join("\n") + "\n";
}

// ─── Command ──────────────────────────────────────────────────────────────────

export async function importWorkflows(options: { githubActions?: boolean; file?: string }): Promise<void> {
  const cwd = process.cwd();

  let sources: string[] = [];
  if (options.file) {
    const abs = resolve(cwd, options.file);
    if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
    sources = [abs];
  } else {
    const workflowDir = resolve(cwd, ".github", "workflows");
    if (!existsSync(workflowDir)) {
      console.error(chalk.red(`${s.cross} No .github/workflows/ directory found in ${cwd}`));
      process.exit(1);
    }
    sources = readdirSync(workflowDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => resolve(workflowDir, f))
      .sort();
    if (sources.length === 0) {
      console.log(chalk.dim("No workflow files found in .github/workflows/"));
      return;
    }
  }

  const circuitsDir = resolve(cwd, ".cb", "circuits");
  if (!existsSync(circuitsDir)) mkdirSync(circuitsDir, { recursive: true });

  const created: string[] = [];

  for (const src of sources) {
    let wf: RawWorkflow;
    try {
      wf = parseYAML(readFileSync(src, "utf-8")) as RawWorkflow;
    } catch {
      console.error(chalk.yellow(`${s.warn}  Skipping ${basename(src)}: YAML parse error`));
      continue;
    }

    if (!wf?.jobs || Object.keys(wf.jobs).length === 0) {
      console.log(chalk.dim(`  skip ${basename(src)}: no jobs`));
      continue;
    }

    const name = (wf.name ?? basename(src).replace(/\.(yml|yaml)$/, "")).trim();
    const outPath = resolve(circuitsDir, `${slug(name)}.wf.ts`);

    if (existsSync(outPath)) {
      console.log(chalk.dim(`  skip ${slug(name)}.wf.ts (already exists)`));
      continue;
    }

    console.log(chalk.dim(`  importing ${basename(src)}...`));
    const code = await generateCircuit(name, wf);
    if (!code) {
      console.log(chalk.dim(`  skip ${basename(src)}: could not determine job order`));
      continue;
    }

    writeFileSync(outPath, code, "utf-8");
    created.push(outPath);
    console.log(chalk.green(`${s.check} Created ${chalk.bold(`.cb/circuits/${slug(name)}.wf.ts`)}`));

    const todoCount = (code.match(/# TODO: uses:/g) ?? []).length;
    if (todoCount > 0) {
      console.log(chalk.dim(`    ${todoCount} uses: action(s) are JavaScript/Docker and left as TODO`));
    }
  }

  if (created.length > 0) {
    console.log(`\n${chalk.bold("Next:")}\n\n  ${chalk.cyan("cb seal .cb/circuits/")}  ${chalk.dim("# sign")}\n  ${chalk.cyan("cb check")}               ${chalk.dim("# run")}\n`);
  }
}

export function registerImportCommand(program: Command): void {
  program
    .command("import")
    .description("Import existing workflows as native circuits")
    .option("--github-actions", "Import from .github/workflows/*.yml (default)")
    .option("-f, --file <path>", "Import a specific workflow file")
    .action(async (options: { githubActions?: boolean; file?: string }) => {
      try {
        await importWorkflows(options);
      } catch (err) {
        console.error(chalk.red(`${s.cross} ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
