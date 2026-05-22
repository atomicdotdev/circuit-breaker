import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

export type SealSigner = "ssh-agent" | "atomic" | "ssh-key" | "machine-key";

export interface AtomicIdentity {
  name: string;
  id: string;
  email: string;
  isDefault: boolean;
}

export interface CBConfig {
  identity: {
    seal_signer: SealSigner;
    ssh_key?: string;
    atomic_identity?: string; // name of the atomic identity to use when seal_signer = "atomic"
  };
}

export function configDir(): string {
  return join(homedir(), ".circuit-breaker");
}

export function identityDir(): string {
  return join(configDir(), "identity");
}

export function machineKeyPath(): string {
  return join(identityDir(), "cb.key");
}

export function machinePubKeyPath(): string {
  return join(identityDir(), "cb.pub");
}

export function configFilePath(): string {
  return join(configDir(), "config.toml");
}

export function runnersDir(): string {
  return join(configDir(), "runners");
}

export function isConfigured(): boolean {
  return existsSync(configFilePath());
}

export function loadConfig(): CBConfig | null {
  const path = configFilePath();
  if (!existsSync(path)) return null;
  return parseToml(readFileSync(path, "utf-8"));
}

export function saveConfig(config: CBConfig, context?: { atomicIdentities?: AtomicIdentity[] }): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFilePath(), tomlStringify(config, context), "utf-8");
}

export function listAtomicIdentities(): AtomicIdentity[] {
  const identitiesDir = join(homedir(), ".atomic", "identities");
  if (!existsSync(identitiesDir)) return [];

  // Read the default identity ID from ~/.atomic/identities/config.toml
  let defaultId: string | null = null;
  const atomicConfigPath = join(identitiesDir, "config.toml");
  if (existsSync(atomicConfigPath)) {
    const raw = readFileSync(atomicConfigPath, "utf-8");
    const m = raw.match(/^default_identity\s*=\s*"([^"]+)"/m);
    if (m) defaultId = m[1];
  }

  const identities: AtomicIdentity[] = [];
  for (const entry of readdirSync(identitiesDir)) {
    const tomlPath = join(identitiesDir, entry, "identity.toml");
    if (!existsSync(tomlPath)) continue;
    const raw = readFileSync(tomlPath, "utf-8");
    const nameMatch = raw.match(/^name\s*=\s*"([^"]+)"/m);
    const idMatch   = raw.match(/^id\s*=\s*"([^"]+)"/m);
    const emailMatch = raw.match(/^email\s*=\s*"([^"]+)"/m);
    const hasKey = raw.includes("has_secret_key = true");
    if (!nameMatch || !idMatch || !hasKey) continue;
    const id = idMatch[1]!;
    identities.push({
      name: nameMatch[1]!,
      id,
      email: emailMatch?.[1] ?? "",
      isDefault: defaultId ? id.startsWith(defaultId) || defaultId.startsWith(id.slice(0, 8)) : false,
    });
  }

  // Stable order: default first, then alphabetical by name
  return identities.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });
}

export function detectAvailableSigners(): {
  hasAtomic: boolean;
  atomicIdentities: AtomicIdentity[];
  atomicDefault: string | null;
  hasSshAgent: boolean;
  hasSshKey: string | null;
} {
  const atomicIdentities = listAtomicIdentities();
  const atomicDefault = atomicIdentities.find((i) => i.isDefault)?.name
    ?? atomicIdentities[0]?.name
    ?? null;

  const sshKey = join(homedir(), ".ssh", "id_ed25519");
  return {
    hasAtomic: atomicIdentities.length > 0,
    atomicIdentities,
    atomicDefault,
    hasSshAgent: !!process.env.SSH_AUTH_SOCK,
    hasSshKey: existsSync(sshKey) ? sshKey : null,
  };
}

export function autoDetectSigner(): { signer: SealSigner; atomicIdentity?: string; sshKey?: string } {
  const { hasAtomic, atomicDefault, hasSshAgent, hasSshKey } = detectAvailableSigners();
  if (hasAtomic) return { signer: "atomic", atomicIdentity: atomicDefault ?? undefined };
  if (hasSshAgent) return { signer: "ssh-agent" };
  if (hasSshKey) return { signer: "ssh-key", sshKey: hasSshKey };
  return { signer: "machine-key" };
}

// Minimal TOML parser for the subset we need — no external dep.
function parseToml(content: string): CBConfig {
  const config: CBConfig = { identity: { seal_signer: "machine-key" } };
  let currentSection = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    const kvMatch = line.match(/^(\w+)\s*=\s*"(.+)"$/);
    if (kvMatch && currentSection === "identity") {
      const [, key, value] = kvMatch;
      if (key === "seal_signer") config.identity.seal_signer = value as SealSigner;
      if (key === "ssh_key") config.identity.ssh_key = value;
      if (key === "atomic_identity") config.identity.atomic_identity = value;
    }
  }

  return config;
}

function tomlStringify(config: CBConfig, context?: { atomicIdentities?: AtomicIdentity[] }): string {
  const active = config.identity.seal_signer;
  const lines: string[] = [];

  lines.push("[identity]");
  lines.push("# Seal signer - who signs circuit seals (human approval proof).");
  lines.push("# Options: atomic | ssh-agent | ssh-key | machine-key");
  lines.push(`seal_signer = "${active}"`);

  if (active === "atomic" && config.identity.atomic_identity) {
    lines.push("");
    lines.push("# Atomic identity to sign with (run `atomic identity list` to see all options)");
    lines.push(`atomic_identity = "${config.identity.atomic_identity}"`);
  }

  if (active === "ssh-key" && config.identity.ssh_key) {
    lines.push("");
    lines.push("# SSH key file to sign with");
    lines.push(`ssh_key = "${config.identity.ssh_key}"`);
  }

  // -- Commented alternatives ---------------------------------------------------
  lines.push("");
  lines.push("# -- Other available signers (uncomment one block to switch) -----------------");

  if (active !== "atomic") {
    lines.push("# seal_signer = \"atomic\"");
    const ids = context?.atomicIdentities ?? [];
    if (ids.length > 0) {
      for (const id of ids) {
        const tag = id.isDefault ? "  # (default)" : "";
        lines.push(`# atomic_identity = "${id.name}"${tag}`);
      }
    } else {
      lines.push("# atomic_identity = \"<name>\"   # run: atomic identity list");
    }
    lines.push("#");
  } else {
    // Already using atomic — show alternative identities to switch between
    const ids = (context?.atomicIdentities ?? []).filter(
      (id) => id.name !== config.identity.atomic_identity,
    );
    if (ids.length > 0) {
      lines.push("# Switch atomic identity:");
      for (const id of ids) {
        lines.push(`# atomic_identity = "${id.name}"`);
      }
      lines.push("#");
    }
  }

  if (active !== "ssh-agent") {
    lines.push("# seal_signer = \"ssh-agent\"    # uses SSH_AUTH_SOCK");
    lines.push("#");
  }

  if (active !== "ssh-key") {
    lines.push("# seal_signer = \"ssh-key\"");
    lines.push("# ssh_key = \"~/.ssh/id_ed25519\"");
    lines.push("#");
  }

  if (active !== "machine-key") {
    lines.push("# seal_signer = \"machine-key\"  # CB machine key only (weakest signal)");
  }

  return lines.join("\n") + "\n";
}
