/**
 * .cb/state/cb.db — append-only run graph backed by SQLite.
 *
 * Data model mirrors the architecture spec (redb in the spec; SQLite here
 * as the pragmatic embedded choice for Bun). Every Run appends a Merkle
 * root update so the full history is tamper-evident.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { hashBytes, hashString, merkleUpdate } from "./hashing";

// ─── Node / Edge types ────────────────────────────────────────────────────────

export type NodeKind = "Seal" | "Run" | "Transition" | "LogChunk";
export type EdgeKind = "produces" | "follows" | "has" | "log" | "step-log";
export type RunStatus = "Passed" | "Failed" | "Tripped" | "Partial";
export type TransitionStatus = "Passed" | "Failed" | "Skipped";

export interface SealPayload {
  circuit_hash: string;
  runner_hash: string;
  seal_hash: string;
  cb_version: string;
  sealed_at: string; // ISO
  seal_pubkey: string;
  signature: string;
  alg: string;
  circuit_name: string;
  circuit_path: string;
}

export interface RunPayload {
  seal_id: string;
  input_hash: string;
  change_hashes: string[];
  started_at: string;
  finished_at: string;
  status: RunStatus;
  log_hash: string;
  merkle_at_record: string;
  cb_version: string;
  cb_pubkey: string;
  signature: string;
}

export interface TransitionPayload {
  run_id: string;
  name: string;
  status: TransitionStatus;
  started_at: string;
  duration_ms: number;
  exit_code: number | null;
  log_hash: string;
}

// ─── Graph ────────────────────────────────────────────────────────────────────

const GENESIS_ROOT = "0000000000000000000000000000000000000000000000000000000000000000";

export class Graph {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA foreign_keys=ON");
    this.init();
  }

  private init(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS cb_nodes (
      node_id   TEXT PRIMARY KEY,
      kind      TEXT NOT NULL,
      payload   TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS cb_edges (
      edge_id   TEXT PRIMARY KEY,
      kind      TEXT NOT NULL,
      from_node TEXT NOT NULL,
      to_node   TEXT NOT NULL
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS cb_seal_index (
      seal_hash TEXT PRIMARY KEY,
      node_id   TEXT NOT NULL
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS cb_run_chain (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_node_id TEXT NOT NULL,
      merkle_root TEXT NOT NULL
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS cb_input_index (
      input_hash  TEXT NOT NULL,
      run_node_id TEXT NOT NULL,
      PRIMARY KEY (input_hash, run_node_id)
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS cb_log_chunks (
      chunk_hash TEXT PRIMARY KEY,
      data       BLOB NOT NULL
    )`);

    // Indexes for common queries
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_nodes_kind ON cb_nodes(kind)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_edges_from ON cb_edges(from_node)`);
  }

  // ─── Seal ──────────────────────────────────────────────────────────────────

  addSeal(payload: SealPayload): string {
    const nodeId = randomUUID();
    this.db.run(
      `INSERT OR REPLACE INTO cb_nodes VALUES (?, 'Seal', ?, ?)`,
      [nodeId, JSON.stringify(payload), Date.now()],
    );
    this.db.run(
      `INSERT OR REPLACE INTO cb_seal_index VALUES (?, ?)`,
      [payload.seal_hash, nodeId],
    );
    return nodeId;
  }

  getSealByHash(sealHash: string): { nodeId: string; payload: SealPayload } | null {
    const row = this.db
      .query<{ node_id: string; payload: string }, [string]>(
        `SELECT n.node_id, n.payload FROM cb_seal_index s
         JOIN cb_nodes n ON n.node_id = s.node_id
         WHERE s.seal_hash = ?`,
      )
      .get(sealHash);
    if (!row) return null;
    return { nodeId: row.node_id, payload: JSON.parse(row.payload) as SealPayload };
  }

  getSealByNodeId(nodeId: string): SealPayload | null {
    const row = this.db
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM cb_nodes WHERE node_id = ? AND kind = 'Seal'`,
      )
      .get(nodeId);
    return row ? (JSON.parse(row.payload) as SealPayload) : null;
  }

  // ─── Run ───────────────────────────────────────────────────────────────────

  addRun(
    sealNodeId: string,
    payload: Omit<RunPayload, "merkle_at_record">,
  ): { nodeId: string; merkleRoot: string } {
    const nodeId = randomUUID();
    const payloadHash = hashString(JSON.stringify(payload));
    const prevRoot = this.latestMerkleRoot();
    const merkleRoot = merkleUpdate(prevRoot, nodeId, payloadHash);

    const full: RunPayload = { ...payload, merkle_at_record: merkleRoot };
    this.db.run(
      `INSERT INTO cb_nodes VALUES (?, 'Run', ?, ?)`,
      [nodeId, JSON.stringify(full), Date.now()],
    );
    // produces edge: Seal → Run
    this.db.run(
      `INSERT INTO cb_edges VALUES (?, 'produces', ?, ?)`,
      [randomUUID(), sealNodeId, nodeId],
    );
    // follow edge: prev run → this run (if any)
    const prevRun = this.latestRunNodeId();
    if (prevRun && prevRun !== nodeId) {
      this.db.run(
        `INSERT INTO cb_edges VALUES (?, 'follows', ?, ?)`,
        [randomUUID(), prevRun, nodeId],
      );
    }
    // Append to run chain
    this.db.run(
      `INSERT INTO cb_run_chain (run_node_id, merkle_root) VALUES (?, ?)`,
      [nodeId, merkleRoot],
    );
    // Input index
    this.db.run(
      `INSERT OR IGNORE INTO cb_input_index VALUES (?, ?)`,
      [payload.input_hash, nodeId],
    );
    return { nodeId, merkleRoot };
  }

  getRunByNodeId(nodeId: string): RunPayload | null {
    const row = this.db
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM cb_nodes WHERE node_id = ? AND kind = 'Run'`,
      )
      .get(nodeId);
    return row ? (JSON.parse(row.payload) as RunPayload) : null;
  }

  getLatestRun(sealHash?: string): { nodeId: string; payload: RunPayload } | null {
    let row: { node_id: string; payload: string } | null;
    if (sealHash) {
      row = this.db
        .query<{ node_id: string; payload: string }, [string]>(
          `SELECT n.node_id, n.payload FROM cb_run_chain rc
           JOIN cb_nodes n ON n.node_id = rc.run_node_id
           JOIN cb_edges e ON e.to_node = rc.run_node_id AND e.kind = 'produces'
           JOIN cb_seal_index si ON si.node_id = e.from_node AND si.seal_hash = ?
           ORDER BY rc.seq DESC LIMIT 1`,
        )
        .get(sealHash);
    } else {
      row = this.db
        .query<{ node_id: string; payload: string }, []>(
          `SELECT n.node_id, n.payload FROM cb_run_chain rc
           JOIN cb_nodes n ON n.node_id = rc.run_node_id
           ORDER BY rc.seq DESC LIMIT 1`,
        )
        .get();
    }
    if (!row) return null;
    return { nodeId: row.node_id, payload: JSON.parse(row.payload) as RunPayload };
  }

  getRunsBySeal(sealHash: string, limit = 20): Array<{ nodeId: string; seq: number; payload: RunPayload }> {
    const rows = this.db
      .query<{ node_id: string; seq: number; payload: string }, [string]>(
        `SELECT n.node_id, rc.seq, n.payload FROM cb_run_chain rc
         JOIN cb_nodes n ON n.node_id = rc.run_node_id
         JOIN cb_edges e ON e.to_node = rc.run_node_id AND e.kind = 'produces'
         JOIN cb_seal_index si ON si.node_id = e.from_node AND si.seal_hash = ?
         ORDER BY rc.seq DESC LIMIT ${limit}`,
      )
      .all(sealHash);
    return rows.map((r) => ({
      nodeId: r.node_id,
      seq: r.seq,
      payload: JSON.parse(r.payload) as RunPayload,
    }));
  }

  getRunsByInput(inputHash: string): Array<{ nodeId: string; payload: RunPayload }> {
    const rows = this.db
      .query<{ node_id: string; payload: string }, [string]>(
        `SELECT n.node_id, n.payload FROM cb_input_index ii
         JOIN cb_nodes n ON n.node_id = ii.run_node_id
         WHERE ii.input_hash = ?`,
      )
      .all(inputHash);
    return rows.map((r) => ({ nodeId: r.node_id, payload: JSON.parse(r.payload) as RunPayload }));
  }

  getRunChain(
    limit = 20,
  ): Array<{ seq: number; runNodeId: string; merkleRoot: string }> {
    const rows = this.db
      .query<{ seq: number; run_node_id: string; merkle_root: string }, []>(
        `SELECT seq, run_node_id, merkle_root FROM cb_run_chain ORDER BY seq DESC LIMIT ${limit}`,
      )
      .all();
    return rows.map((r) => ({
      seq: r.seq,
      runNodeId: r.run_node_id,
      merkleRoot: r.merkle_root,
    }));
  }

  // ─── Transition ────────────────────────────────────────────────────────────

  addTransition(runNodeId: string, payload: TransitionPayload): string {
    const nodeId = randomUUID();
    this.db.run(
      `INSERT INTO cb_nodes VALUES (?, 'Transition', ?, ?)`,
      [nodeId, JSON.stringify(payload), Date.now()],
    );
    this.db.run(
      `INSERT INTO cb_edges VALUES (?, 'has', ?, ?)`,
      [randomUUID(), runNodeId, nodeId],
    );
    return nodeId;
  }

  getTransitionsByRun(runNodeId: string): Array<{ nodeId: string; payload: TransitionPayload }> {
    const rows = this.db
      .query<{ node_id: string; payload: string }, [string]>(
        `SELECT n.node_id, n.payload FROM cb_edges e
         JOIN cb_nodes n ON n.node_id = e.to_node
         WHERE e.from_node = ? AND e.kind = 'has' AND n.kind = 'Transition'`,
      )
      .all(runNodeId);
    return rows.map((r) => ({
      nodeId: r.node_id,
      payload: JSON.parse(r.payload) as TransitionPayload,
    }));
  }

  // ─── Log Chunks ────────────────────────────────────────────────────────────

  addLogChunk(data: Buffer): string {
    const chunkHash = hashBytes(data);
    this.db.run(
      `INSERT OR IGNORE INTO cb_log_chunks VALUES (?, ?)`,
      [chunkHash, data],
    );
    return chunkHash;
  }

  getLogChunk(chunkHash: string): Buffer | null {
    const row = this.db
      .query<{ data: Buffer }, [string]>(
        `SELECT data FROM cb_log_chunks WHERE chunk_hash = ?`,
      )
      .get(chunkHash);
    return row?.data ?? null;
  }

  linkLog(fromNodeId: string, chunkHash: string, kind: "log" | "step-log" = "log"): void {
    this.db.run(
      `INSERT OR IGNORE INTO cb_edges VALUES (?, ?, ?, ?)`,
      [randomUUID(), kind, fromNodeId, chunkHash],
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Expose so callers can include merkle_at_record in run signatures. */
  peekNextMerkle(nodeId: string, payloadHash: string): string {
    const prev = this.latestMerkleRoot();
    return merkleUpdate(prev, nodeId, payloadHash);
  }

  private latestMerkleRoot(): string {
    const row = this.db
      .query<{ merkle_root: string }, []>(
        `SELECT merkle_root FROM cb_run_chain ORDER BY seq DESC LIMIT 1`,
      )
      .get();
    return row?.merkle_root ?? GENESIS_ROOT;
  }

  private latestRunNodeId(): string | null {
    const row = this.db
      .query<{ run_node_id: string }, []>(
        `SELECT run_node_id FROM cb_run_chain ORDER BY seq DESC LIMIT 1`,
      )
      .get();
    return row?.run_node_id ?? null;
  }

  close(): void {
    this.db.close();
  }
}

// ─── Repo graph discovery ─────────────────────────────────────────────────────

/** Walk up from cwd to find .cb/ and return the db path. Returns null if no .cb/ found. */
export function findGraphPath(cwd?: string): string | null {
  let current = cwd ?? process.cwd();
  while (true) {
    if (existsSync(join(current, ".cb"))) {
      return join(current, ".cb", "state", "cb.db");
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Open the repo's graph, or null if no .cb/ found. */
export function openGraph(cwd?: string): Graph | null {
  const dbPath = findGraphPath(cwd);
  if (!dbPath) return null;
  return new Graph(dbPath);
}

/** Open the graph, creating .cb/ infrastructure if it doesn't exist yet. */
export function openOrCreateGraph(repoRoot: string): Graph {
  const dbPath = join(repoRoot, ".cb", "state", "cb.db");
  return new Graph(dbPath);
}
