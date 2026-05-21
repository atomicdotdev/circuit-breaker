/**
 * `cb init` — first-time setup + repo initialization.
 *
 * Machine-level: creates ~/.circuit-breaker/ with machine key and config.
 * Repo-level: creates .cb/circuits/, .cb/seals/, .cb/state/ in the current repo.
 * Idempotent — safe to re-run.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  configDir,
  configFilePath,
  isConfigured,
  loadConfig,
  saveConfig,
  detectAvailableSigners,
  listAtomicIdentities,
  type SealSigner,
  type AtomicIdentity,
} from "../lib/config";
import { generateMachineKey, machineKeyExists } from "../lib/signing";
import { s } from "../lib/symbols";

// ─── Repo init ────────────────────────────────────────────────────────────────

function initRepo(repoRoot: string): { created: boolean } {
  const paths = [
    join(repoRoot, ".cb", "circuits"),
    join(repoRoot, ".cb", "seals"),
    join(repoRoot, ".cb", "state"),
  ];

  let created = false;
  for (const p of paths) {
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
      created = true;
    }
  }

  const stateGitignore = join(repoRoot, ".cb", "state", ".gitignore");
  if (!existsSync(stateGitignore)) {
    writeFileSync(stateGitignore, "# Uncomment to commit the run graph alongside your code:\n# !cb.db\ncb.db\n");
  }

  return { created };
}

// ─── Machine init ─────────────────────────────────────────────────────────────

async function initMachine(
  interactive: boolean,
  hints: { signer?: SealSigner; identity?: string; key?: string },
): Promise<void> {
  const { hasAtomic, atomicIdentities, atomicDefault, hasSshAgent, hasSshKey } =
    detectAvailableSigners();

  let sealSigner: SealSigner;
  let atomicIdentity: string | undefined;
  let sshKey: string | undefined;

  if (!interactive || hints.signer) {
    // Non-interactive or explicit --signer: resolve directly from hints + auto-detect
    if (hints.signer) {
      sealSigner = hints.signer;
    } else if (hasAtomic) {
      sealSigner = "atomic";
    } else if (hasSshAgent) {
      sealSigner = "ssh-agent";
    } else if (hasSshKey) {
      sealSigner = "ssh-key";
    } else {
      sealSigner = "machine-key";
    }

    if (sealSigner === "atomic") {
      atomicIdentity = hints.identity ?? atomicDefault ?? undefined;
    } else if (sealSigner === "ssh-key") {
      sshKey = hints.key ?? hasSshKey ?? undefined;
    }
  } else {
    // Interactive: build a menu
    console.log(chalk.bold("\nChoose a seal signer:\n"));

    type Option = {
      label: string;
      signer: SealSigner;
      atomicIdentity?: string;
      key?: string;
    };
    const opts: Option[] = [];

    if (hasAtomic) {
      if (atomicIdentities.length === 1) {
        const id = atomicIdentities[0]!;
        opts.push({
          label: `Atomic identity: ${id.name} <${id.email}>  (default)`,
          signer: "atomic",
          atomicIdentity: id.name,
        });
      } else {
        for (const id of atomicIdentities) {
          const tag = id.isDefault ? "  (default)" : "";
          opts.push({
            label: `Atomic identity: ${id.name} <${id.email}>${tag}`,
            signer: "atomic",
            atomicIdentity: id.name,
          });
        }
      }
    }

    if (hasSshAgent) {
      opts.push({ label: "SSH agent (SSH_AUTH_SOCK)", signer: "ssh-agent" });
    }

    if (hasSshKey) {
      opts.push({ label: `SSH key: ${hasSshKey}`, signer: "ssh-key", key: hasSshKey });
    }

    if (hints.key) {
      // --key was passed without --signer; add it as an ssh-key option
      const alreadyListed = opts.some((o) => o.signer === "ssh-key" && o.key === hints.key);
      if (!alreadyListed) {
        opts.push({ label: `SSH key: ${hints.key}  (--key)`, signer: "ssh-key", key: hints.key });
      }
    }

    opts.push({ label: "Machine key only  (weakest - no human identity)", signer: "machine-key" });

    // Pre-select: if --identity was hinted, find matching atomic option
    let defaultIdx = 0;
    if (hints.identity) {
      const match = opts.findIndex(
        (o) => o.signer === "atomic" &&
               o.atomicIdentity?.toLowerCase() === hints.identity!.toLowerCase()
      );
      if (match >= 0) defaultIdx = match;
    } else if (hasAtomic) {
      const defMatch = opts.findIndex((o) => o.signer === "atomic" &&
        atomicIdentities.find((i) => i.name === o.atomicIdentity)?.isDefault);
      if (defMatch >= 0) defaultIdx = defMatch;
    }

    for (let i = 0; i < opts.length; i++) {
      const marker = i === defaultIdx ? chalk.green(`  [${i + 1}]`) : `  [${i + 1}]`;
      console.log(`${marker} ${opts[i]!.label}`);
    }

    process.stdout.write(chalk.dim(`\nChoose [${defaultIdx + 1}]: `));
    const choice = await readLine();
    const idx = (parseInt(choice.trim()) || defaultIdx + 1) - 1;
    const selected = opts[Math.max(0, Math.min(idx, opts.length - 1))]!;

    sealSigner = selected.signer;
    atomicIdentity = selected.atomicIdentity;
    sshKey = selected.key ?? hints.key;
  }

  // Generate machine key if needed
  if (!machineKeyExists()) {
    generateMachineKey();
    console.log(chalk.green(`${s.check} Machine key generated: ~/.circuit-breaker/identity/cb.key`));
  }

  // Write config with comments
  const allAtomicIdentities = listAtomicIdentities();
  saveConfig(
    { identity: { seal_signer: sealSigner, atomic_identity: atomicIdentity, ssh_key: sshKey } },
    { atomicIdentities: allAtomicIdentities },
  );

  const signerLabel =
    sealSigner === "atomic" && atomicIdentity
      ? `atomic (${atomicIdentity})`
      : sealSigner === "ssh-key" && sshKey
        ? `ssh-key (${sshKey})`
        : sealSigner;

  console.log(chalk.green(`${s.check} Seal signer: ${signerLabel}`));
  console.log(chalk.green(`${s.check} Config written: ~/.circuit-breaker/config.toml`));
}

async function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.once("data", (chunk) => {
      data += chunk;
      process.stdin.pause();
      resolve(data.trim());
    });
  });
}

// ─── Command ──────────────────────────────────────────────────────────────────

export async function init(options: {
  yes?: boolean;
  signer?: string;
  identity?: string;
  key?: string;
}): Promise<void> {
  const interactive = !options.yes && !options.signer;
  const repoRoot = process.cwd();

  const alreadyConfigured = isConfigured() && machineKeyExists();

  if (alreadyConfigured && !options.signer && !options.identity && !options.key) {
    console.log(chalk.green(`${s.check} Machine already configured (~/.circuit-breaker/)`));
    const cfg = loadConfig();
    if (cfg) {
      const signerLabel =
        cfg.identity.seal_signer === "atomic" && cfg.identity.atomic_identity
          ? `atomic (${cfg.identity.atomic_identity})`
          : cfg.identity.seal_signer === "ssh-key" && cfg.identity.ssh_key
            ? `ssh-key (${cfg.identity.ssh_key})`
            : cfg.identity.seal_signer;
      console.log(chalk.dim(`  Seal signer: ${signerLabel}`));
      console.log(chalk.dim(`  Config: ~/.circuit-breaker/config.toml`));
    }
  } else {
    if (!alreadyConfigured) console.log(chalk.bold("\nSetting up Circuit Breaker...\n"));

    const signer = options.signer as SealSigner | undefined;
    await initMachine(interactive, {
      signer,
      identity: options.identity,
      key: options.key,
    });
  }

  // Repo init
  if (existsSync(join(repoRoot, ".cb"))) {
    console.log(chalk.green(`${s.check} .cb/ already initialized in ${repoRoot}`));
  } else {
    const { created } = initRepo(repoRoot);
    if (created) {
      console.log(chalk.bold("\nInitializing .cb/ in " + repoRoot + "..."));
      console.log(chalk.green(`${s.check} Created .cb/circuits/    (add your circuit definitions here)`));
      console.log(chalk.green(`${s.check} Created .cb/seals/       (commit to git - seal manifests live here)`));
      console.log(chalk.green(`${s.check} Created .cb/state/       (run graph - commit or gitignore as preferred)`));
    }
  }

  console.log(`
${chalk.bold("Next steps:")}

  ${chalk.bold("Option A")} - import your existing GitHub Actions workflows:

    ${chalk.cyan("cb import --github-actions")}
    ${chalk.dim("Converts .github/workflows/*.yml to native circuits in .cb/circuits/.")}

  ${chalk.bold("Option B")} - write a native circuit:

${chalk.dim(`    // .cb/circuits/ci.wf.ts
    import { workflow } from "@circuit-breaker/core";

    export default workflow("ci")
      .place("start", { initialTokens: 1 })
      .place("done")
      .transition("build")
        .from("start").to("done")
        .script("bun run build")
        .done()
      .build();`)}

    ${chalk.cyan("cb seal .cb/circuits/ci.wf.ts")}   ${chalk.dim("# sign it")}
    ${chalk.cyan("cb check")}                         ${chalk.dim("# run it")}
`);
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize Circuit Breaker for this machine and/or repo")
    .option("-y, --yes", "Non-interactive: auto-detect best signer, skip prompts")
    .option("--signer <type>", "Seal signer to use: atomic | ssh-agent | ssh-key | machine-key")
    .option("--identity <name>", "Atomic identity name to use (run `atomic identity list` to see options)")
    .option("--key <path>", "SSH key file path (for --signer ssh-key)")
    .action(async (options: { yes?: boolean; signer?: string; identity?: string; key?: string }) => {
      try {
        await init(options);
      } catch (err) {
        console.error(chalk.red(`${s.cross} ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
