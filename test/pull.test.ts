import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { parseTaskCreateMutation } from "../src/protocol.ts";
import { applyTaskCreate } from "../src/task-create.ts";
import expectedPage from "./fixtures/pulled-change-page.json";
import goldenRequest from "./fixtures/valid-task-create.json?raw";

it("pulls one accepted change from checkpoint zero and advances to its sequence", async () => {
  const mutation = parseTaskCreateMutation(goldenRequest, env.INSTANCE_ID);
  await applyTaskCreate(env.DB, mutation, goldenRequest, {
    now: () => new Date("2026-09-13T06:30:01.000Z"),
  });

  const response = await exports.default.fetch("https://personal-cloud.local/sync/changes?after=0&limit=1");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expectedPage);

  const repeated = await exports.default.fetch("https://personal-cloud.local/sync/changes?after=0&limit=1");
  expect(await repeated.json()).toEqual(expectedPage);

  const caughtUp = await exports.default.fetch("https://personal-cloud.local/sync/changes?after=1&limit=1");
  expect(await caughtUp.json()).toEqual({
    protocolVersion: 1,
    product: "tasks",
    changes: [],
    nextCheckpoint: 1,
  });
});

it("rejects an unbounded or malformed pull", async () => {
  for (const query of [
    "after=-1&limit=1",
    "after=0&limit=0",
    "after=0&limit=51",
    "after=0&limit=all",
    "after=0&limit=1&extra=true",
    "after=0&after=1&limit=1",
  ]) {
    const response = await exports.default.fetch(`https://personal-cloud.local/sync/changes?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      protocolVersion: 1,
      product: "tasks",
      error: { code: "invalid_request", retryable: false },
    });
  }
});
