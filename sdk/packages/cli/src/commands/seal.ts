/**
 * `cb seal <circuit>` — sign a circuit + runner pair and write the seal to .cb/seals/.
 *
 * Seal layout:
 *   .cb/seals/<seal_hash[0:12]>/
 *     manifest.json   — seal metadata + signature
 *     circuit.wf.ts   — locked copy of the circuit definition
 *     runner.ref      — path to the .smolmachine runner (if any)
 *
 * After sealing: commit .cb/seals/ to activate. An uncommitted seal is treated
 * as unverified by `cb check`.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYAML } from "yaml";
import { runnerCacheKey, runnerCachePath } from "@circuit-breaker/core";
import { hashFile, hashConcat } from "../lib/hashing";
import { sealSign, verifySignature } from "../lib/signing";
import { loadConfig, machineKeyPath, isConfigured } from "../lib/config";
import { openOrCreateGraph, type SealPayload } from "../lib/graph";
import { s } from "../lib/symbols";
import { buildSealedRunner, fingerprintNativeRunner, hasSmolvmBinary } from "../lib/smolvm";

const VERSION = "0.1.0";
const ZERO_HASH = "0".repeat(64);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function circuitName(circuitPath: string): string {
  const base = basename(circuitPath);
  // ci.wf.ts → ci,  tests.wf.ts → tests,  build.ts → build
  return base.split(".")[0] ?? base;
}

function isSkippableAction(uses: string): boolean {
  const a = uses.toLowerCase();
  return (
    a.startsWith("actions/checkout") ||
    a.startsWith("actions/cache") ||
    a.startsWith("actions/upload-artifact") ||
    a.startsWith("actions/download-artifact")
  );
}

function resolveRunsOnImage(runsOn: string | string[]): string {
  const label = Array.isArray(runsOn) ? runsOn[0] : runsOn;
  const map: Record<string, string> = {
    "ubuntu-latest": "ubuntu:24.04",
    "ubuntu-24.04": "ubuntu:24.04",
    "ubuntu-22.04": "ubuntu:22.04",
    "ubuntu-20.04": "ubuntu:20.04",
  };
  return map[label] ?? label;
}

/**
 * Ensure a runner artifact exists for this circuit and return its hash.
 *
 * - GHA (.yml/.yaml): parse image + uses, use runnerCacheKey, build if missing.
 * - Native (.wf.ts / other): pack the persistent cb-check VM if it exists.
 */
async function ensureRunner(
  circuitPath: string,
): Promise<{ runnerHash: string; runnerRef: string | null }> {
  const isGHA = circuitPath.endsWith(".yml") || circuitPath.endsWith(".yaml");

  if (isGHA) {
    return ensureGHARunner(circuitPath);
  }
  return ensureNativeRunner();
}

async function ensureGHARunner(
  circuitPath: string,
): Promise<{ runnerHash: string; runnerRef: string | null }> {
  let image = "ubuntu:24.04";
  let uses: { uses: string; with?: Record<string, unknown> }[] = [];

  try {
    const wf = parseYAML(readFileSync(circuitPath, "utf-8")) as {
      jobs?: Record<string, {
        "runs-on"?: string | string[];
        steps?: Array<{ uses?: string; with?: Record<string, unknown> }>;
      }>;
    };
    const firstJob = Object.values(wf.jobs ?? {})[0];
    if (firstJob) {
      image = resolveRunsOnImage(firstJob["runs-on"] ?? "ubuntu-latest");
      uses = (firstJob.steps ?? [])
        .filter((step) => step.uses && !isSkippableAction(step.uses))
        .map((step) => ({ uses: step.uses!, with: step.with }));
    }
  } catch {
    return { runnerHash: ZERO_HASH, runnerRef: null };
  }

  const cacheKey = runnerCacheKey(image, uses);
  const cachePath = runnerCachePath(cacheKey);

  if (!existsSync(cachePath)) {
    console.log(chalk.dim("  Runner not cached — building sealed runner..."));
    const built = await buildSealedRunner(image, uses, cacheKey, cachePath);
    if (!built) {
      console.error(chalk.red(`  ${s.cross} Failed to build runner for sealing`));
      return { runnerHash: ZERO_HASH, runnerRef: null };
    }
  }

  if (existsSync(cachePath)) {
    return { runnerHash: hashFile(cachePath), runnerRef: cachePath };
  }

  return { runnerHash: ZERO_HASH, runnerRef: null };
}

async function ensureNativeRunner(): Promise<{ runnerHash: string; runnerRef: string | null }> {
  if (!hasSmolvmBinary()) return { runnerHash: ZERO_HASH, runnerRef: null };

  console.log(chalk.dim("  Fingerprinting native runner VM..."));
  const fingerprint = await fingerprintNativeRunner();
  if (!fingerprint) return { runnerHash: ZERO_HASH, runnerRef: null };

  return { runnerHash: fingerprint, runnerRef: null };
}

function findExistingSeal(
  cbRoot: string,
  circuitHash: string,
  runnerHash: string,
): string | null {
  const sealsDir = join(cbRoot, ".cb", "seals");
  if (!existsSync(sealsDir)) return null;
  const sealHash = hashConcat(circuitHash, runnerHash);
  const prefix = sealHash.slice(0, 12);
  if (existsSync(join(sealsDir, prefix, "manifest.json"))) return prefix;
  return null;
}

function isSealCommitted(sealDir: string): boolean {
  const result = spawnSync("git", ["status", "--porcelain", sealDir], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result.status === 0 && !result.stdout?.trim();
}

// ─── Core seal logic ──────────────────────────────────────────────────────────

export interface SealResult {
  sealId: string;      // cb/<name>:<prefix>
  sealHash: string;    // full hex
  sealDir: string;     // .cb/seals/<prefix>/
  circuitName: string;
  committed: boolean;
}

export async function sealCircuit(
  circuitPath: string,
  options: { rebuild?: boolean; cwd?: string } = {},
): Promise<SealResult> {
  const cwd = options.cwd ?? process.cwd();
  const absoluteCircuit = resolve(cwd, circuitPath);

  if (!existsSync(absoluteCircuit)) {
    throw new Error(`Circuit file not found: ${absoluteCircuit}`);
  }

  const config = loadConfig();
  if (!config) {
    throw new Error(
      "CB not configured. Run `cb init` first.",
    );
  }

  const name = circuitName(absoluteCircuit);
  const circuitHash = hashFile(absoluteCircuit);

  // Ensure runner artifact exists; build/pack if needed
  const { runnerHash, runnerRef } = await ensureRunner(absoluteCircuit);

  const sealHash = hashConcat(circuitHash, runnerHash);
  const prefix = sealHash.slice(0, 12);

  // Find the .cb/ root (walk up from cwd or use cwd itself)
  let cbRoot = cwd;
  while (!existsSync(join(cbRoot, ".cb")) && dirname(cbRoot) !== cbRoot) {
    cbRoot = dirname(cbRoot);
  }
  if (!existsSync(join(cbRoot, ".cb"))) cbRoot = cwd; // fall back to cwd, init will create it

  const sealDir = join(cbRoot, ".cb", "seals", prefix);

  if (!options.rebuild && existsSync(join(sealDir, "manifest.json"))) {
    const existing: SealPayload = JSON.parse(
      readFileSync(join(sealDir, "manifest.json"), "utf-8"),
    );
    const committed = isSealCommitted(sealDir);
    return {
      sealId: `cb/${existing.circuit_name}:${prefix}`,
      sealHash,
      sealDir,
      circuitName: existing.circuit_name,
      committed,
    };
  }

  // Build the payload to sign
  const sealedAt = new Date().toISOString();
  const signPayload = Buffer.from(
    [circuitHash, runnerHash, VERSION, sealedAt].join("|"),
    "utf-8",
  );

  const sig = sealSign(signPayload, config.identity.seal_signer, config.identity.ssh_key, config.identity.atomic_identity);

  const manifest: SealPayload = {
    circuit_hash: circuitHash,
    runner_hash: runnerHash,
    seal_hash: sealHash,
    cb_version: VERSION,
    sealed_at: sealedAt,
    seal_pubkey: sig.pubkey,
    signature: sig.signature,
    alg: sig.alg,
    circuit_name: name,
    circuit_path: absoluteCircuit,
  };

  // Write seal directory
  mkdirSync(sealDir, { recursive: true });
  writeFileSync(join(sealDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  copyFileSync(absoluteCircuit, join(sealDir, basename(absoluteCircuit)));
  if (runnerRef) {
    writeFileSync(join(sealDir, "runner.ref"), runnerRef);
  }

  // Record Seal node in graph
  const graph = openOrCreateGraph(cbRoot);
  try {
    graph.addSeal(manifest);
  } finally {
    graph.close();
  }

  const committed = isSealCommitted(sealDir);
  return {
    sealId: `cb/${name}:${prefix}`,
    sealHash,
    sealDir,
    circuitName: name,
    committed,
  };
}

// ─── Verify an existing seal ──────────────────────────────────────────────────

export function verifySeal(
  sealDir: string,
  circuitPath: string,
): { valid: boolean; reason?: string } {
  const manifestPath = join(sealDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { valid: false, reason: "manifest.json not found" };
  }

  let manifest: SealPayload;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as SealPayload;
  } catch {
    return { valid: false, reason: "manifest.json is not valid JSON" };
  }

  // Verify circuit hash matches current file
  if (!existsSync(circuitPath)) {
    return { valid: false, reason: `Circuit file not found: ${circuitPath}` };
  }
  const currentHash = hashFile(circuitPath);
  if (currentHash !== manifest.circuit_hash) {
    return {
      valid: false,
      reason: `Circuit modified since sealing (expected ${manifest.circuit_hash.slice(0, 12)}, got ${currentHash.slice(0, 12)})`,
    };
  }

  // Verify seal_hash consistency
  const expectedSealHash = hashConcat(manifest.circuit_hash, manifest.runner_hash);
  if (expectedSealHash !== manifest.seal_hash) {
    return { valid: false, reason: "seal_hash mismatch in manifest" };
  }

  // Verify signature
  const signPayload = Buffer.from(
    [manifest.circuit_hash, manifest.runner_hash, manifest.cb_version, manifest.sealed_at].join("|"),
    "utf-8",
  );
  const sigValid = verifySignature(signPayload, {
    alg: manifest.alg as "ed25519" | "ssh-sig",
    signature: manifest.signature,
    pubkey: manifest.seal_pubkey,
  });

  if (!sigValid) {
    return { valid: false, reason: "Seal signature verification failed" };
  }

  return { valid: true };
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerSealCommand(program: Command): void {
  program
    .command("seal [circuit]")
    .description("Sign a circuit definition and create a seal in .cb/seals/")
    .option("--rebuild", "Re-seal even if an identical seal already exists")
    .option("--all", "Seal all circuits in .cb/circuits/")
    .action(async (circuit: string | undefined, options: { rebuild?: boolean; all?: boolean }) => {
      if (!isConfigured()) {
        console.error(chalk.red(`${s.cross} CB not configured. Run \`cb init\` first.`));
        process.exit(1);
      }

      let circuits: string[] = [];

      const resolvedCircuit = circuit ? resolve(process.cwd(), circuit) : undefined;
      const circuitIsDir = resolvedCircuit && existsSync(resolvedCircuit) &&
        statSync(resolvedCircuit).isDirectory();

      if (options.all || !circuit || circuitIsDir) {
        const circuitsDir = circuitIsDir
          ? resolvedCircuit!
          : join(process.cwd(), ".cb", "circuits");
        if (!existsSync(circuitsDir)) {
          console.error(chalk.red(`${s.cross} No .cb/circuits/ directory. Run \`cb init\` first.`));
          process.exit(1);
        }
        circuits = readdirSync(circuitsDir)
          .filter((f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".json"))
          .map((f) => join(circuitsDir, f));
        if (circuits.length === 0) {
          console.log(chalk.dim("No circuits found in " + circuitsDir));
          return;
        }
      } else {
        circuits = [circuit];
      }

      for (const c of circuits) {
        try {
          const result = await sealCircuit(c, { rebuild: options.rebuild });
          console.log(chalk.green(`${s.check} sealed ${result.sealId}`));
          if (!result.committed) {
            console.log(
              chalk.yellow(`  ${s.warn}  Seal not yet committed - commit .cb/seals/ to activate:`),
            );
            console.log(chalk.dim(`     git add .cb/seals/ && git commit -m "seal: ${result.sealId}"`));
          }
        } catch (err) {
          console.error(chalk.red(`${s.cross} ${err instanceof Error ? err.message : err}`));
          process.exit(1);
        }
      }
    });
}

