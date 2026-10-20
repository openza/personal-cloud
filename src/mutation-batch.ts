import { ContractError, maximumRequestUtf8Bytes, parseStrictJson, parseTaskMutation } from "./protocol.ts";
import { applyMutation } from "./mutation-apply.ts";
import type { Receipt } from "./mutation-receipt.ts";

export const mutationBatchCapability = {
  protocolVersion: 1, path: "/v1/tasks/mutations/batch", maxMutations: 2, maxRequestUtf8Bytes: maximumRequestUtf8Bytes,
} as const;

export function parseMutationBatch(raw: string, instanceId: string) {
  const body = parseStrictJson(raw);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 ||
      !Object.hasOwn(body, "protocolVersion") || !Object.hasOwn(body, "mutations") || body.protocolVersion !== 1 ||
      !Array.isArray(body.mutations) || body.mutations.length < 1 || body.mutations.length > mutationBatchCapability.maxMutations ||
      new TextEncoder().encode(raw).byteLength > maximumRequestUtf8Bytes) {
    throw new ContractError("invalid_request", "The mutation batch must contain one or two versioned mutations.");
  }
  const items = body.mutations.map(value => {
    const raw = JSON.stringify(value);
    return { raw, mutation: parseTaskMutation(raw, instanceId) };
  });
  const ids = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const mutation = items[i].mutation;
    if (ids.has(mutation.mutationId) || mutation.deviceId !== items[0].mutation.deviceId ||
        (i > 0 && mutation.deviceSequence !== items[i - 1].mutation.deviceSequence + 1)) {
      throw new ContractError("invalid_request", "A mutation batch requires one device, distinct IDs, and consecutive ordered sequences.");
    }
    ids.add(mutation.mutationId);
  }
  return items;
}

export async function applyMutationBatch(
  db: D1Database,
  instanceId: string,
  items: ReturnType<typeof parseMutationBatch>,
  publicError: (error: unknown) => unknown,
  options:{fanoutBound?:number}={},
) {
  const receipts: Receipt[] = [];
  for (let index = 0; index < items.length; index++) {
    try {
      const item = items[index];
      receipts.push(await applyMutation(db, item.mutation, item.raw,options));
    } catch (error) {
      return { protocolVersion: 1, product: "tasks", instanceId, receipts,
        processedCount: receipts.length, stoppedAt: index, error: publicError(error) };
    }
  }
  return { protocolVersion: 1, product: "tasks", instanceId, receipts,
    processedCount: receipts.length, stoppedAt: null, error: null };
}
