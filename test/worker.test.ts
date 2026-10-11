import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { canonicalize, computeCanonicalHash, parseTaskCreateMutation } from "../src/protocol.ts";
import { applyTaskCreate } from "../src/task-create.ts";
import canonicalFixture from "./fixtures/valid-task-create.canonical.json?raw";
import goldenRequest from "./fixtures/valid-task-create.json?raw";
import goldenHash from "./fixtures/valid-task-create.sha256?raw";

type MutableMutation = {
  protocolVersion: number;
  product: string;
  instanceId: string;
  deviceId: string;
  mutationId: string;
  deviceSequence: number;
  operation: string;
  entityId: string;
  baseEntityVersion: null;
  payload: { task: {
    id: string;
    spaceId: string;
    title: string;
    completionState: string;
    workflowStatus: string;
    createdAt: string;
  } };
  clientCreatedAt: string;
};

function requestFor(suffix: string, change: (value: MutableMutation) => void = () => {}): string {
  const value = JSON.parse(goldenRequest) as MutableMutation;
  value.deviceId = `device_${suffix}`;
  value.mutationId = `mutation_${suffix}`;
  value.entityId = `local_${suffix}`;
  value.payload.task.id = value.entityId;
  change(value);
  return JSON.stringify(value);
}

async function post(rawRequest: string): Promise<{ response: Response; body: Record<string, any> }> {
  const response = await exports.default.fetch("https://personal-cloud.local/v1/tasks/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawRequest,
  });
  return { response, body: await response.json() as Record<string, any> };
}

describe.sequential("K2 task.create", () => {
  it("matches the copied K0 canonical fixture and SHA-256 hash", async () => {
    expect(canonicalize(goldenRequest)).toBe(canonicalFixture.trim());
    expect(await computeCanonicalHash(goldenRequest)).toBe(goldenHash.trim());
  });

  it("accepts once, atomically stores one task, immutable receipt/hash, and ordered change, then deduplicates", async () => {
    const before = await env.DB.prepare("SELECT next_change_seq FROM cloud_state WHERE singleton = 1")
      .first<{ next_change_seq: number }>();
    const first = await post(goldenRequest);
    expect(first.response.status).toBe(201);
    expect(first.body).toMatchObject({
      protocolVersion: 1,
      product: "tasks",
      mutationId: "mutation_00000000000000000000000000000001",
      outcome: "accepted",
      entityId: "local_00000000000000000000000000000001",
      entityVersion: 1,
      changeSeq: (before?.next_change_seq ?? 0) + 1,
    });

    const duplicate = await post(goldenRequest);
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.body).toEqual({ ...first.body, outcome: "duplicate" });

    const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?1")
      .bind(first.body.entityId).all();
    const receipt = await env.DB.prepare("SELECT * FROM mutation_receipts WHERE mutation_id = ?1")
      .bind(first.body.mutationId).all();
    const change = await env.DB.prepare("SELECT * FROM changes WHERE mutation_id = ?1")
      .bind(first.body.mutationId).all();
    expect(task.results).toHaveLength(1);
    expect(receipt.results).toHaveLength(1);
    expect(change.results).toHaveLength(1);
    expect(task.results[0]).toMatchObject({ product: "tasks", entity_version: 1 });
    expect(receipt.results[0]).toMatchObject({
      product: "tasks",
      canonical_hash: goldenHash.trim(),
      canonical_request: canonicalFixture.trim(),
      change_seq: first.body.changeSeq,
    });
    expect(change.results[0]).toMatchObject({
      product: "tasks",
      change_seq: first.body.changeSeq,
      operation: "task.created",
      entity_kind: "task",
      entity_version: 1,
      server_accepted_at: first.body.serverAcceptedAt,
    });

    await expect(env.DB.prepare(
      "UPDATE mutation_receipts SET canonical_hash = 'changed' WHERE mutation_id = ?1",
    ).bind(first.body.mutationId).run()).rejects.toThrow("mutation receipts are immutable");
  });

  it("collapses concurrent identical delivery to one durable effect", async () => {
    const rawRequest = requestFor("concurrent_retry");
    const [left, right] = await Promise.all([post(rawRequest), post(rawRequest)]);
    expect([left.body.outcome, right.body.outcome].sort()).toEqual(["accepted", "duplicate"]);
    expect(left.body.changeSeq).toBe(right.body.changeSeq);

    const counts = await env.DB.prepare(`
      SELECT
        (SELECT count(*) FROM tasks WHERE id = ?1) AS tasks,
        (SELECT count(*) FROM changes WHERE mutation_id = ?2) AS changes,
        (SELECT count(*) FROM mutation_receipts WHERE mutation_id = ?2) AS receipts
    `).bind("local_concurrent_retry", "mutation_concurrent_retry").first();
    expect(counts).toEqual({ tasks: 1, changes: 1, receipts: 1 });
  });

  it("rejects reuse of a mutation ID with different content", async () => {
    const original = requestFor("reuse");
    expect((await post(original)).body.outcome).toBe("accepted");
    const changed = JSON.stringify({ ...JSON.parse(original), payload: {
      task: { ...JSON.parse(original).payload.task, title: "Changed title" },
    } });
    const result = await post(changed);
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ product: "tasks", error: { code: "mutation_id_reused", retryable: false } });
  });

  it.each([
    ["unsupported product", (value: MutableMutation) => { value.product = "reader"; }, "unsupported_product"],
    ["unsupported protocol", (value: MutableMutation) => { value.protocolVersion = 2; }, "unsupported_protocol"],
    ["sequence gap", (value: MutableMutation) => { value.deviceSequence = 2; }, "sequence_gap"],
    ["missing Space", (value: MutableMutation) => { value.payload.task.spaceId = "space_missing"; }, "parent_not_found"],
  ])("rejects %s", async (_name, change, expectedCode) => {
    const result = await post(requestFor(`reject_${expectedCode}`, change));
    expect(result.body).toMatchObject({
      protocolVersion: 1,
      product: "tasks",
      error: { code: expectedCode },
    });
  });

  it("rejects an entity ID created by another mutation", async () => {
    const first = requestFor("entity_owner");
    expect((await post(first)).body.outcome).toBe("accepted");
    const second = requestFor("entity_other", (value) => {
      value.entityId = "local_entity_owner";
      value.payload.task.id = value.entityId;
    });
    const result = await post(second);
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ product: "tasks", error: { code: "entity_exists", retryable: false } });
  });

  it("rolls back every durable effect when failure is injected after the task insert", async () => {
    const rawRequest = requestFor("atomic_failure");
    const mutation = parseTaskCreateMutation(rawRequest, env.INSTANCE_ID);
    const before = await env.DB.prepare("SELECT next_change_seq FROM cloud_state WHERE singleton = 1")
      .first<{ next_change_seq: number }>();

    await expect(applyTaskCreate(env.DB, mutation, rawRequest, { failAfterTaskInsert: true }))
      .rejects.toThrow();

    const [task, receipt, change, device, claim, after] = await env.DB.batch([
      env.DB.prepare("SELECT count(*) AS count FROM tasks WHERE id = ?1").bind(mutation.entityId),
      env.DB.prepare("SELECT count(*) AS count FROM mutation_receipts WHERE mutation_id = ?1").bind(mutation.mutationId),
      env.DB.prepare("SELECT count(*) AS count FROM changes WHERE mutation_id = ?1").bind(mutation.mutationId),
      env.DB.prepare("SELECT count(*) AS count FROM device_sequences WHERE device_id = ?1").bind(mutation.deviceId),
      env.DB.prepare("SELECT count(*) AS count FROM device_sequence_claims WHERE device_id = ?1").bind(mutation.deviceId),
      env.DB.prepare("SELECT next_change_seq FROM cloud_state WHERE singleton = 1"),
    ]);
    for (const result of [task, receipt, change, device, claim]) {
      expect(result.results[0]).toEqual({ count: 0 });
    }
    expect(after.results[0]).toEqual(before);
  });
});
