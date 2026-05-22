/**
 * `cb agent install` — write CLAUDE.md instructions so agents run `cb check`
 * before completing a turn.
 *
 * Writes (or merges into) CLAUDE.md at the project root. The agent reads this
 * file and is required to run `cb check` as a Bash tool call and see
 * "All checks passed" before handing control back to the user.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { s } from "../lib/symbols";

const CLAUDE_MD_SECTION = `
## Before finishing any turn

You MUST run \`cb check\` as a Bash tool call and it MUST show "All checks passed" before you complete your turn.

If \`cb check\` fails:
1. Fix the reported errors
2. Run \`cb check\` again (full run, no \`--from\`)
3. Only complete the turn once it passes

If you fixed a specific step and want to skip earlier passing steps, use:

\`\`\`bash
cb check --from <step-id>
\`\`\`

But when using \`--from\`, you must still verify the full run passes before finishing.
`;

const SENTINEL = "You MUST run `cb check`";

async function installAgent(options: { force?: boolean; source?: string }): Promise<void> {
  const source = resolve(options.source ?? ".");

  // Require .cb/ directory — this is an inner-loop repo
  if (!existsSync(join(source, ".cb"))) {
    console.error(chalk.red(`${s.cross} No .cb/ directory found. Run \`cb init\` first.`));
    process.exit(1);
  }

  const claudeMd = join(source, "CLAUDE.md");

  if (existsSync(claudeMd)) {
    const existing = readFileSync(claudeMd, "utf-8");
    if (existing.includes(SENTINEL) && !options.force) {
      console.log(chalk.dim(`  ${s.skip} CLAUDE.md already has cb check instructions (use --force to overwrite)`));
    } else {
      const updated = existing.includes(SENTINEL)
        ? existing.replace(/\n## Before finishing any turn[\s\S]*?(?=\n## |\n*$)/, CLAUDE_MD_SECTION)
        : existing.trimEnd() + "\n" + CLAUDE_MD_SECTION;
      writeFileSync(claudeMd, updated, "utf-8");
      console.log(chalk.green(`  ${s.check} CLAUDE.md (merged)`));
    }
  } else {
    writeFileSync(claudeMd, `# CLAUDE.md\n${CLAUDE_MD_SECTION}`, "utf-8");
    console.log(chalk.green(`  ${s.check} CLAUDE.md`));
  }

  console.log();
  console.log(chalk.bold("Agent instructions installed."));
  console.log(chalk.dim("  Claude Code will run `cb check` before completing each turn."));
  console.log(chalk.dim("  On failure, Claude must fix errors and re-run before finishing."));
  console.log();
  console.log(chalk.dim("  Tip: commit CLAUDE.md to share instructions with your team."));
}

export function registerAgentCommand(program: Command): void {
  const agent = program
    .command("agent")
    .description("Manage Claude Code agent integration");

  agent
    .command("install")
    .description("Write CLAUDE.md instructions so agents run cb check before completing a turn")
    .option("-f, --force", "Overwrite existing cb check section")
    .option("-s, --source <path>", "Project root (default: current directory)", ".")
    .action(installAgent);
}
