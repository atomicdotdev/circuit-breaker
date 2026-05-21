import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { identityDir, machineKeyPath, machinePubKeyPath, type SealSigner } from "./config";

export interface SignResult {
  alg: "ed25519" | "ssh-sig" | "atomic-ed25519";
  signature: string; // base64
  pubkey: string;    // base64 SPKI DER (ed25519) | SSH authorized-keys line (ssh-sig) | atomic public key (atomic-ed25519)
}

// ─── Machine Key ──────────────────────────────────────────────────────────────

export function generateMachineKey(): void {
  mkdirSync(identityDir(), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(machineKeyPath(), privateKey, { mode: 0o600 });
  writeFileSync(machinePubKeyPath(), publicKey);
}

export function machineKeyExists(): boolean {
  return existsSync(machineKeyPath()) && existsSync(machinePubKeyPath());
}

export function getMachinePubkeyBase64(): string {
  const pem = readFileSync(machinePubKeyPath(), "utf-8");
  const key = createPublicKey(pem);
  return (key.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}

export function signWithMachineKey(data: Buffer): SignResult {
  const privateKey = createPrivateKey(readFileSync(machineKeyPath(), "utf-8"));
  const signature = cryptoSign(null, data, privateKey);
  return {
    alg: "ed25519",
    signature: signature.toString("base64"),
    pubkey: getMachinePubkeyBase64(),
  };
}

export function verifyMachineSignature(
  data: Buffer,
  signature: string,
  pubkeyBase64: string,
): boolean {
  try {
    const der = Buffer.from(pubkeyBase64, "base64");
    const publicKey = createPublicKey({ key: der, type: "spki", format: "der" });
    return cryptoVerify(null, data, publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

// ─── Seal Signing ─────────────────────────────────────────────────────────────

export function sealSign(
  data: Buffer,
  sealSigner: SealSigner,
  sshKeyPath?: string,
  atomicIdentity?: string,
): SignResult {
  switch (sealSigner) {
    case "machine-key":
      return signWithMachineKey(data);
    case "ssh-key": {
      const keyPath = sshKeyPath ?? join(homedir(), ".ssh", "id_ed25519");
      return signWithSshKeyFile(data, keyPath);
    }
    case "ssh-agent":
      return signWithSshAgent(data);
    case "atomic":
      return signWithAtomicCli(data, atomicIdentity);
  }
}

function signWithAtomicCli(data: Buffer, identityName?: string): SignResult {
  const args = ["identity", "sign"];
  if (identityName) args.push("--identity", identityName);

  const result = spawnSync("atomic", args, {
    input: data,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() ?? "";
    throw new Error(`atomic identity sign failed: ${stderr || "unknown error"}`);
  }

  let parsed: { signature: string; public_key: string; identity?: string; alg?: string };
  try {
    parsed = JSON.parse(result.stdout.toString());
  } catch {
    throw new Error("atomic identity sign returned non-JSON output");
  }

  return {
    alg: "atomic-ed25519",
    signature: parsed.signature,
    pubkey: parsed.public_key,
  };
}

function sshSignFile(keyFile: string, dataFile: string): string {
  const result = spawnSync(
    "ssh-keygen",
    ["-Y", "sign", "-n", "circuit-breaker", "-f", keyFile, dataFile],
    { stdio: ["inherit", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(
      `ssh-keygen sign failed: ${result.stderr?.toString().trim()}`,
    );
  }
  const sigContent = readFileSync(`${dataFile}.sig`, "utf-8");
  try { unlinkSync(`${dataFile}.sig`); } catch { /* ignore */ }
  // Strip PEM armor and newlines
  return sigContent
    .replace(/^-----BEGIN SSH SIGNATURE-----\n/, "")
    .replace(/\n-----END SSH SIGNATURE-----\n?$/, "")
    .replace(/\n/g, "");
}

function signWithSshKeyFile(data: Buffer, keyPath: string): SignResult {
  const tmp = join(tmpdir(), `cb-seal-${Date.now()}`);
  writeFileSync(tmp, data);
  try {
    const sigBase64 = sshSignFile(keyPath, tmp);
    const pubResult = spawnSync("ssh-keygen", ["-y", "-f", keyPath], {
      encoding: "utf-8",
    });
    if (pubResult.status !== 0) {
      throw new Error("Could not read public key from key file");
    }
    return {
      alg: "ssh-sig",
      signature: sigBase64,
      pubkey: pubResult.stdout.trim().split("\n")[0] ?? "",
    };
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function signWithSshAgent(data: Buffer): SignResult {
  const listResult = spawnSync("ssh-add", ["-L"], { encoding: "utf-8" });
  if (listResult.status !== 0 || !listResult.stdout?.trim()) {
    throw new Error("No keys in ssh-agent. Run: ssh-add ~/.ssh/id_ed25519");
  }
  const firstKey = listResult.stdout.trim().split("\n")[0] ?? "";

  // Write the agent's public key to a temp file so ssh-keygen can locate
  // the corresponding private key in the agent via the public key fingerprint.
  const tmpPub = join(tmpdir(), `cb-seal-${Date.now()}.pub`);
  const tmpData = join(tmpdir(), `cb-seal-${Date.now()}`);
  writeFileSync(tmpPub, firstKey + "\n");
  writeFileSync(tmpData, data);

  try {
    const sigBase64 = sshSignFile(tmpPub, tmpData);
    return { alg: "ssh-sig", signature: sigBase64, pubkey: firstKey };
  } finally {
    try { unlinkSync(tmpPub); } catch { /* ignore */ }
    try { unlinkSync(tmpData); } catch { /* ignore */ }
  }
}

// ─── Unified Verify ───────────────────────────────────────────────────────────

export function verifySignature(
  data: Buffer,
  result: SignResult,
): boolean {
  if (result.alg === "ed25519") {
    return verifyMachineSignature(data, result.signature, result.pubkey);
  }
  if (result.alg === "atomic-ed25519") {
    // Delegate back to atomic CLI once `atomic identity verify` exists;
    // for now verify via ssh-sig path using the stored public key.
    return verifyAtomicSignature(data, result.signature, result.pubkey);
  }
  // SSH signatures: reconstruct the PEM and call ssh-keygen -Y verify
  return verifySshSignature(data, result.signature, result.pubkey);
}

function verifyAtomicSignature(data: Buffer, signature: string, pubkey: string): boolean {
  const args = ["identity", "verify", "--signature", signature, "--public-key", pubkey];
  const result = spawnSync("atomic", args, {
    input: data,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result.status === 0;
}

function verifySshSignature(
  data: Buffer,
  sigBase64: string,
  pubkeyLine: string,
): boolean {
  const tmpData = join(tmpdir(), `cb-verify-${Date.now()}`);
  const tmpSig = `${tmpData}.sig`;
  const tmpAllowed = `${tmpData}.allowed`;

  // Reconstruct PEM-armored signature
  const sigPem = [
    "-----BEGIN SSH SIGNATURE-----",
    sigBase64.match(/.{1,76}/g)?.join("\n") ?? sigBase64,
    "-----END SSH SIGNATURE-----",
    "",
  ].join("\n");

  // Allowed signers file: identity namespace key
  const keyParts = pubkeyLine.split(" ");
  const identity = keyParts[2] ?? "cb-seal";
  const allowedLine = `${identity} circuit-breaker ${keyParts[0]} ${keyParts[1]}`;

  writeFileSync(tmpData, data);
  writeFileSync(tmpSig, sigPem);
  writeFileSync(tmpAllowed, allowedLine + "\n");

  try {
    const result = spawnSync(
      "ssh-keygen",
      [
        "-Y", "verify",
        "-n", "circuit-breaker",
        "-f", tmpAllowed,
        "-I", identity,
        "-s", tmpSig,
        tmpData,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    return result.status === 0;
  } finally {
    try { unlinkSync(tmpData); } catch { /* ignore */ }
    try { unlinkSync(tmpSig); } catch { /* ignore */ }
    try { unlinkSync(tmpAllowed); } catch { /* ignore */ }
  }
}
