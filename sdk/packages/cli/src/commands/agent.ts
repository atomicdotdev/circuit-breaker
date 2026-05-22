/**
 * `cb agent install` — inject Claude Code stop hooks into the current project.
 *
 * Writes:
 *   .claude/hooks/cb-check.sh   — stop hook script
 *   .claude/settings.json       — registers the hook (merges if file exists)
 *
 * Exit code 2 from the hook blocks Claude from completing a turn so it must
 * fix failures before handing control back to the user.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { s } from "../lib/symbols";

const HOOK_SCRIPT = `#!/usr/bin/env bash
# Claude Code Stop hook — runs cb check before handing control back to the user.
# Exit 2 blocks completion and shows output to Claude so it can fix failures.
# Exit 0 allows normal completion.
#
# Claude Code reads stdout for the blocking feedback shown to the model.
# We tee to stderr as well so the output is visible in the terminal.

set -uo pipefail

cd "$(dirname "$0")/../.."

# Only run if .cb circuits exist
if [ ! -d ".cb/circuits" ]; then
  exit 0
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Running verification: cb check      ║"
echo "╚══════════════════════════════════════╝"
echo ""

cb check 2>&1 | tee /dev/stderr
exit_code=\${PIPESTATUS[0]}

echo ""
if [ "\$exit_code" -eq 0 ]; then
  echo "✓ cb check passed"
else
  echo "✗ cb check failed — fix the issues above before completing."
  echo "  To resume from the failed step: cb check --from <step-id>"
  exit 2
fi
`;

async function installAgent(options: { force?: boolean; source?: string }): Promise<void> {
  const source = resolve(options.source ?? ".");

  // Require .cb/ directory — this is an inner-loop repo
  if (!existsSync(join(source, ".cb"))) {
    console.error(chalk.red(`${s.cross} No .cb/ directory found. Run \`cb init\` first.`));
    process.exit(1);
  }

  const claudeDir = join(source, ".claude");
  const hooksDir = join(claudeDir, "hooks");
  const hookScript = join(hooksDir, "cb-check.sh");
  const settingsFile = join(claudeDir, "settings.json");

  // ── Create directories ────────────────────────────────────────────────────
  mkdirSync(hooksDir, { recursive: true });

  // ── Write hook script ─────────────────────────────────────────────────────
  if (existsSync(hookScript) && !options.force) {
    console.log(chalk.dim(`  ${s.skip} .claude/hooks/cb-check.sh already exists (use --force to overwrite)`));
  } else {
    writeFileSync(hookScript, HOOK_SCRIPT, "utf-8");
    chmodSync(hookScript, 0o755);
    console.log(chalk.green(`  ${s.check} .claude/hooks/cb-check.sh`));
  }

  // ── Merge settings.json ───────────────────────────────────────────────────
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    } catch {
      console.error(chalk.red(`  ${s.cross} Could not parse existing .claude/settings.json`));
      process.exit(1);
    }
  }

  // Ensure hooks.Stop array exists
  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!hooks.Stop) hooks.Stop = [];
  const stopHooks = hooks.Stop as Array<{ matcher: string; hooks: unknown[] }>;

  const checkEntry = { matcher: "", hooks: [{ type: "command", command: "bash .claude/hooks/cb-check.sh" }] };

  const alreadyHasCheck = stopHooks.some((g) =>
    (g.hooks as Array<{ command?: string }>).some((h) => h.command === "bash .claude/hooks/cb-check.sh"),
  );

  if (alreadyHasCheck && !options.force) {
    console.log(chalk.dim(`  ${s.skip} .claude/settings.json already has cb hooks`));
  } else {
    if (!alreadyHasCheck) stopHooks.push(checkEntry);
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    console.log(chalk.green(`  ${s.check} .claude/settings.json`));
  }

  console.log();
  console.log(chalk.bold("Agent hooks installed."));
  console.log(chalk.dim("  Claude Code will run `cb check` before completing each turn."));
  console.log(chalk.dim("  On failure, Claude sees the output and must fix it before continuing."));
  console.log();
  console.log(chalk.dim("  Tip: commit .claude/ to share hooks with your team."));
}

export function registerAgentCommand(program: Command): void {
  const agent = program
    .command("agent")
    .description("Manage Claude Code agent integration");

  agent
    .command("install")
    .description("Install cb check stop hooks into .claude/ for the current project")
    .option("-f, --force", "Overwrite existing hook files")
    .option("-s, --source <path>", "Project root (default: current directory)", ".")
    .action(installAgent);
}
