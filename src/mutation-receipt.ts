import { ContractError } from "./protocol.ts";

export type Receipt = {
  protocolVersion: 1;
  product: "tasks";
  mutationId: string;
  outcome: "accepted" | "duplicate";
  entityId: string;
  entityVersion: number;
  changeSeq: number;
  serverAcceptedAt: string;
};

export type ReceiptRow = {
  canonical_hash: string;
  mutation_id: string;
  entity_id: string;
  entity_version: number;
  change_seq: number;
  server_accepted_at: string;
};

export async function findReceipt(db: D1Database, mutationId: string): Promise<ReceiptRow | null> {
  return db.prepare(`
    SELECT canonical_hash, mutation_id, entity_id, entity_version, change_seq, server_accepted_at
    FROM mutation_receipts WHERE mutation_id = ?1
  `).bind(mutationId).first<ReceiptRow>();
}

export function duplicateOrReuse(row: ReceiptRow, canonicalHash: string): Receipt {
  if (row.canonical_hash !== canonicalHash) {
    throw new ContractError("mutation_id_reused", "The mutation ID was already used for different content.");
  }
  return toReceipt(row, "duplicate");
}

export function toReceipt(row: ReceiptRow, outcome: Receipt["outcome"]): Receipt {
  if (!Number.isSafeInteger(row.entity_version) || row.entity_version <= 0) {
    throw new Error("Unsupported stored entity version.");
  }
  return {
    protocolVersion: 1,
    product: "tasks",
    mutationId: row.mutation_id,
    outcome,
    entityId: row.entity_id,
    entityVersion: row.entity_version,
    changeSeq: row.change_seq,
    serverAcceptedAt: row.server_accepted_at,
  };
}
