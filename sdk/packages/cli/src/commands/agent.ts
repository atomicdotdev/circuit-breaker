/**
 * `cb agent install` — install a Claude Code stop hook that enforces `cb check`.
 *
 * Writes:
 *   .claude/hooks/cb-check.sh   — stop hook script
 *   .claude/settings.json       — registers the hook (merges if file exists)
 *
 * When cb check fails the hook exits 2, which re-prompts the agent with the
 * failure output. The hook output explicitly instructs the agent to run
 * `cb check` itself and see "All checks passed" before finishing.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { s } from "../lib/symbols";

const HOOK_SCRIPT = `#!/usr/bin/env bash
# Claude Code stop hook - runs cb check and blocks turn completion on failure.
# Exit 2 = block and re-prompt the agent. Exit 0 = allow.

cd "$(dirname "$0")/../.."

if [ ! -d ".cb/circuits" ]; then
  exit 0
fi

if cb check; then
  exit 0
else
  echo ""
  echo "================================================================"
  echo "  cb check FAILED -- your turn is NOT complete yet"
  echo "================================================================"
  echo ""
  echo "REQUIRED: fix the errors above, then run 'cb check' as a"
  echo "Bash tool call and confirm it shows 'All checks passed'."
  echo "Do not finish your turn until you have done this."
  exit 2
fi
`;

async function installAgent(options: { force?: boolean; source?: string }): Promise<void> {
  const source = resolve(options.source ?? ".");

  if (!existsSync(join(source, ".cb"))) {
    console.error(chalk.red(`${s.cross} No .cb/ directory found. Run \`cb init\` first.`));
    process.exit(1);
  }

  // ── Stop hook script ───────────────────────────────────────────────────────
  const hooksDir = join(source, ".claude", "hooks");
  const hookScript = join(hooksDir, "cb-check.sh");
  mkdirSync(hooksDir, { recursive: true });

  if (existsSync(hookScript) && !options.force) {
    console.log(chalk.dim(`  ${s.skip} .claude/hooks/cb-check.sh already exists (use --force to overwrite)`));
  } else {
    writeFileSync(hookScript, HOOK_SCRIPT, "utf-8");
    chmodSync(hookScript, 0o755);
    console.log(chalk.green(`  ${s.check} .claude/hooks/cb-check.sh`));
  }

  // ── settings.json ──────────────────────────────────────────────────────────
  const settingsFile = join(source, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    } catch {
      console.error(chalk.red(`  ${s.cross} Could not parse existing .claude/settings.json`));
      process.exit(1);
    }
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!hooks.Stop) hooks.Stop = [];
  const stopHooks = hooks.Stop as Array<{ matcher: string; hooks: unknown[] }>;

  const hookCommand = "bash .claude/hooks/cb-check.sh";
  const alreadyRegistered = stopHooks.some((g) =>
    (g.hooks as Array<{ command?: string }>).some((h) => h.command === hookCommand),
  );

  if (alreadyRegistered && !options.force) {
    console.log(chalk.dim(`  ${s.skip} .claude/settings.json already has cb stop hook`));
  } else {
    if (!alreadyRegistered) stopHooks.push({ matcher: "", hooks: [{ type: "command", command: hookCommand }] });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    console.log(chalk.green(`  ${s.check} .claude/settings.json`));
  }

  console.log();
  console.log(chalk.bold("Agent hook installed."));
  console.log(chalk.dim("  Claude Code will run `cb check` before completing each turn."));
  console.log(chalk.dim("  On failure, Claude is re-prompted and told to fix and re-run."));
  console.log();
  console.log(chalk.dim("  Tip: commit .claude/ to share the hook with your team."));
}

export function registerAgentCommand(program: Command): void {
  const agent = program
    .command("agent")
    .description("Manage Claude Code agent integration");

  agent
    .command("install")
    .description("Install cb check stop hook into .claude/ for the current project")
    .option("-f, --force", "Overwrite existing files")
    .option("-s, --source <path>", "Project root (default: current directory)", ".")
    .action(installAgent);
}
