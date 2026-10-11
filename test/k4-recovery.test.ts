import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { maximumRequestUtf8Bytes } from "../src/protocol.ts";
import checkpointAcknowledgement from "./fixtures/checkpoint-acknowledgement.json?raw";
import goldenRequest from "./fixtures/valid-task-create.json?raw";

type Mutation = Record<string, any> & {
  payload: { task: Record<string, any> };
};

function requestFor(suffix: string, change: (mutation: Mutation) => void = () => {}): string {
  const mutation = JSON.parse(goldenRequest) as Mutation;
  mutation.deviceId = `device_k4_${suffix}`;
  mutation.mutationId = `mutation_k4_${suffix}`;
  mutation.entityId = `local_k4_${suffix}`;
  mutation.payload.task.id = mutation.entityId;
  change(mutation);
  return JSON.stringify(mutation);
}

async function postMutation(body: string): Promise<{ response: Response; body: Record<string, any> }> {
  const response = await exports.default.fetch("https://personal-cloud.local/v1/tasks/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { response, body: await response.json() as Record<string, any> };
}

async function effectCounts(mutationId: string, entityId: string): Promise<Record<string, number>> {
  return await env.DB.prepare(`
    SELECT
      (SELECT count(*) FROM tasks WHERE id = ?1) AS tasks,
      (SELECT count(*) FROM changes WHERE mutation_id = ?2) AS changes,
      (SELECT count(*) FROM mutation_receipts WHERE mutation_id = ?2) AS receipts
  `).bind(entityId, mutationId).first<Record<string, number>>() ?? {};
}

describe.sequential("K4 recovery matrix", () => {
  it("keeps cloud empty before send and applies exactly once after a lost response and a later Worker invocation", async () => {
    const raw = requestFor("lost_response");
    expect(await effectCounts("mutation_k4_lost_response", "local_k4_lost_response"))
      .toEqual({ tasks: 0, changes: 0, receipts: 0 });

    const sentButResponseDiscarded = await postMutation(raw);
    expect(sentButResponseDiscarded.response.status).toBe(201);

    const afterRestartRetry = await postMutation(raw);
    expect(afterRestartRetry.response.status).toBe(200);
    expect(afterRestartRetry.body).toEqual({ ...sentButResponseDiscarded.body, outcome: "duplicate" });
    expect(await effectCounts("mutation_k4_lost_response", "local_k4_lost_response"))
      .toEqual({ tasks: 1, changes: 1, receipts: 1 });
  });

  it("records replica checkpoint acknowledgement only after the client sends it and never moves it backward", async () => {
    const deviceId = "device_k4_replica";
    expect(await env.DB.prepare("SELECT count(*) AS count FROM device_checkpoints WHERE device_id = ?1")
      .bind(deviceId).first()).toEqual({ count: 0 });

    const fixtureResponse = await exports.default.fetch("https://personal-cloud.local/sync/checkpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: checkpointAcknowledgement,
    });
    expect(fixtureResponse.status).toBe(200);
    expect(await fixtureResponse.json()).toEqual({
      protocolVersion: 1,
      product: "tasks",
      deviceId,
      acknowledgedCheckpoint: 1,
    });

    const accepted = await postMutation(requestFor("checkpoint"));
    const checkpoint = accepted.body.changeSeq as number;

    const acknowledge = async (value: number) => {
      const response = await exports.default.fetch("https://personal-cloud.local/sync/checkpoints", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: 1,
          product: "tasks",
          instanceId: env.INSTANCE_ID,
          deviceId,
          checkpoint: value,
        }),
      });
      return { response, body: await response.json() as Record<string, any> };
    };

    const first = await acknowledge(checkpoint);
    expect(first.response.status).toBe(200);
    expect(first.body).toEqual({
      protocolVersion: 1,
      product: "tasks",
      deviceId,
      acknowledgedCheckpoint: checkpoint,
    });
    expect((await acknowledge(checkpoint)).body).toEqual(first.body);
    expect((await acknowledge(0)).body).toEqual(first.body);

    const ahead = await acknowledge(checkpoint + 1);
    expect(ahead.response.status).toBe(409);
    expect(ahead.body).toMatchObject({ error: { code: "sequence_gap", retryable: true } });
    expect(await env.DB.prepare("SELECT last_change_seq FROM device_checkpoints WHERE device_id = ?1")
      .bind(deviceId).first()).toEqual({ last_change_seq: checkpoint });
  });

  it.each([
    ["malformed", "{not-json", "invalid_request"],
    ["oversized", "x".repeat(maximumRequestUtf8Bytes + 1), "invalid_request"],
    ["protocol-incompatible", requestFor("bad_protocol", (value) => { value.protocolVersion = 2; }), "unsupported_protocol"],
  ])("rejects a %s payload without a durable effect", async (_name, raw, code) => {
    const before = await env.DB.prepare("SELECT count(*) AS count FROM mutation_receipts").first<{ count: number }>();
    const result = await postMutation(raw);
    expect(result.response.status).toBe(400);
    expect(result.body).toMatchObject({
      protocolVersion: 1,
      product: "tasks",
      error: { code, retryable: false },
    });
    const after = await env.DB.prepare("SELECT count(*) AS count FROM mutation_receipts").first<{ count: number }>();
    expect(after).toEqual(before);
  });
});
