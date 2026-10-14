import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ENV } from "./config.js";

export const db = new DatabaseSync(join(ENV.dataDir, "bridge.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY,
    src_chain INTEGER NOT NULL,
    dst_chain INTEGER NOT NULL,
    nonce INTEGER NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    origin_chain INTEGER NOT NULL,
    amount TEXT NOT NULL,
    fee TEXT NOT NULL,
    src_tx TEXT NOT NULL,
    src_block INTEGER NOT NULL,
    status TEXT NOT NULL,
    dst_tx TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transfers_sender ON transfers (sender, created_at);
  CREATE INDEX IF NOT EXISTS transfers_recipient ON transfers (recipient, created_at);
  CREATE INDEX IF NOT EXISTS transfers_status ON transfers (status, next_try_at);
`);

const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
const putMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

export function readCursor(chainId, fallback) {
  const row = getMeta.get(`cursor:${chainId}`);
  return row ? Number(row.value) : fallback;
}

export function writeCursor(chainId, block) {
  putMeta.run(`cursor:${chainId}`, String(block));
}

const insert = db.prepare(`
  INSERT OR IGNORE INTO transfers
    (id, src_chain, dst_chain, nonce, sender, recipient, origin_chain, amount, fee, src_tx, src_block, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function addTransfer(row, status) {
  const now = Date.now();
  insert.run(
    row.id,
    row.srcChain,
    row.dstChain,
    row.nonce,
    row.sender,
    row.recipient,
    row.originChain,
    row.amount,
    row.fee,
    row.srcTx,
    row.srcBlock,
    status,
    now,
    now
  );
}

const due = db.prepare("SELECT * FROM transfers WHERE status = 'pending' AND next_try_at <= ? ORDER BY created_at LIMIT 50");
export const dueTransfers = () => due.all(Date.now());

const done = db.prepare("UPDATE transfers SET status = 'released', dst_tx = ?, error = NULL, updated_at = ? WHERE id = ?");
export const markReleased = (id, tx) => done.run(tx || null, Date.now(), id);

const retry = db.prepare(
  "UPDATE transfers SET attempts = attempts + 1, error = ?, next_try_at = ?, updated_at = ? WHERE id = ?"
);
export function markRetry(id, attempts, error) {
  const delay = Math.min(10 * 60_000, 15_000 * 2 ** Math.min(attempts, 6));
  retry.run(String(error).slice(0, 300), Date.now() + delay, Date.now(), id);
}

const byAddress = db.prepare(
  "SELECT * FROM transfers WHERE sender = ? OR recipient = ? ORDER BY created_at DESC LIMIT ?"
);
const recent = db.prepare("SELECT * FROM transfers ORDER BY created_at DESC LIMIT ?");
const one = db.prepare("SELECT * FROM transfers WHERE id = ? OR src_tx = ? LIMIT 1");
const counts = db.prepare("SELECT status, COUNT(*) AS n FROM transfers GROUP BY status");

function present(row) {
  return {
    id: row.id,
    srcChainId: row.src_chain,
    dstChainId: row.dst_chain,
    nonce: row.nonce,
    sender: row.sender,
    recipient: row.recipient,
    originChainId: row.origin_chain,
    amount: row.amount,
    fee: row.fee,
    srcTx: row.src_tx,
    status: row.status,
    dstTx: row.dst_tx,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listTransfers(address, limit = 50) {
  const rows = address ? byAddress.all(address, address, limit) : recent.all(limit);
  return rows.map(present);
}

export function getTransfer(key) {
  const row = one.get(key, key);
  return row ? present(row) : null;
}

export function transferCounts() {
  return Object.fromEntries(counts.all().map((row) => [row.status, Number(row.n)]));
}
