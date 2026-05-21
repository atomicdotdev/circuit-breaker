import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// SHA-256 is used for all content addressing.
// The architecture specifies Blake3; this provides identical semantics with a
// built-in primitive. Upgrade path: swap createHash('sha256') for blake3 when a
// stable Bun-compatible binding is available.

export function hashBytes(data: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashString(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

export function hashFile(path: string): string {
  return hashBytes(readFileSync(path));
}

/** Hash several hex strings together in order (for compound IDs like seal_hash). */
export function hashConcat(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(Buffer.from(p, "hex"));
  return h.digest("hex");
}

/** Hash several arbitrary string values in order. */
export function hashStrings(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p, "utf-8");
  return h.digest("hex");
}

/**
 * Hash a directory's contents recursively.
 * Produces a stable fingerprint of the working tree that can identify
 * the source snapshot a run was executed against.
 */
export function hashDirectory(dirPath: string, ignore?: string[]): string {
  const files: Array<{ path: string; hash: string }> = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = full.slice(dirPath.length + 1);
      if (ignore?.some((pat) => rel === pat || rel.startsWith(pat + "/"))) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else {
        files.push({ path: rel, hash: hashFile(full) });
      }
    }
  }

  walk(dirPath);

  const h = createHash("sha256");
  for (const f of files) h.update(f.path + ":" + f.hash + "\n");
  return h.digest("hex");
}

/**
 * Deterministic JSON serialization with alphabetically sorted keys at every level.
 * Used to produce stable signing bytes regardless of insertion order.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
}

/**
 * Compute the Merkle root update for appending a new run node.
 * new_root = sha256(prev_root || run_node_id || run_node_hash)
 */
export function merkleUpdate(
  prevRoot: string,
  runNodeId: string,
  runNodeHash: string,
): string {
  const h = createHash("sha256");
  h.update(prevRoot, "utf-8");
  h.update(runNodeId, "utf-8");
  h.update(runNodeHash, "utf-8");
  return h.digest("hex");
}
