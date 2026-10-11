import { ContractError, type CheckpointAcknowledgement } from "./protocol.ts";

export type CheckpointReceipt = {
  protocolVersion: 1;
  product: "tasks";
  deviceId: string;
  acknowledgedCheckpoint: number;
};

export async function acknowledgeCheckpoint(
  db: D1Database,
  acknowledgement: CheckpointAcknowledgement,
  now: () => Date = () => new Date(),
): Promise<CheckpointReceipt> {
  const state = await db.prepare("SELECT next_change_seq FROM cloud_state WHERE singleton = 1")
    .first<{ next_change_seq: number }>();
  if (!state || acknowledgement.checkpoint > state.next_change_seq) {
    throw new ContractError("sequence_gap", "The checkpoint is ahead of the cloud change log.");
  }

  await db.prepare(`
    INSERT INTO device_checkpoints (instance_id, product, device_id, last_change_seq, updated_at)
    VALUES (?1, 'tasks', ?2, ?3, ?4)
    ON CONFLICT(instance_id, product, device_id) DO UPDATE SET
      last_change_seq = excluded.last_change_seq,
      updated_at = excluded.updated_at
    WHERE device_checkpoints.last_change_seq < excluded.last_change_seq
  `).bind(
    acknowledgement.instanceId,
    acknowledgement.deviceId,
    acknowledgement.checkpoint,
    now().toISOString(),
  ).run();

  const stored = await db.prepare(`
    SELECT last_change_seq
    FROM device_checkpoints
    WHERE instance_id = ?1 AND product = 'tasks' AND device_id = ?2
  `).bind(acknowledgement.instanceId, acknowledgement.deviceId)
    .first<{ last_change_seq: number }>();
  if (!stored) throw new Error("The checkpoint acknowledgement was not stored.");

  return {
    protocolVersion: 1,
    product: "tasks",
    deviceId: acknowledgement.deviceId,
    acknowledgedCheckpoint: stored.last_change_seq,
  };
}
