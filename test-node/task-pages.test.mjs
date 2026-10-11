import { test } from "node:test";
import assert from "node:assert/strict";
import { readAllTasks } from "../public/task-pages.js";

const page = (ids, hasMore = false, nextCursor = null) => ({
  protocolVersion: 1, product: "tasks", freshness: "current", instanceId: "test_instance",
  readRevision: 1, tasks: ids.map(id => ({ id })), hasMore, nextCursor,
});

test("loads all pages, preserving references and the complete list", async () => {
  const paths = [];
  const result = await readAllTasks(async path => {
    paths.push(path);
    return paths.length === 1 ? { ...page(["a"], true, "a+b="), spaces: [{ id: "space" }] } : page(["b"]);
  });
  assert.deepEqual(paths, ["/v1/tasks", "/v1/tasks?cursor=a%2Bb%3D"]);
  assert.deepEqual(result.tasks.map(task => task.id), ["a", "b"]);
  assert.deepEqual(result.spaces, [{ id: "space" }]);
  assert.equal(result.hasMore, false);
});

test("discards partial pages and restarts after a concurrent mutation", async () => {
  let requests = 0;
  const result = await readAllTasks(async () => {
    requests++;
    if (requests === 1) return page(["old"], true, "cursor");
    if (requests === 2) throw Object.assign(new Error("Changed"), { code: "stale_snapshot" });
    return page(["new"]);
  });
  assert.deepEqual(result.tasks.map(task => task.id), ["new"]);
  assert.equal(requests, 3);
});

test("rejects incomplete reads, duplicates, repeating cursors, incompatible versions and mixed revisions", async () => {
  for (const next of [page(["a"]), page(["b"], true, "cursor"), { ...page(["b"]), readRevision: 2 },
    { ...page(["b"]), instanceId: "other" }, { ...page(["b"]), protocolVersion: 2 }]) {
    let requests = 0;
    await assert.rejects(readAllTasks(async () => ++requests === 1 ? page(["a"], true, "cursor") : next));
  }
  let requests = 0;
  await assert.rejects(readAllTasks(async () => {
    if (++requests === 1) return page(["a"], true, "cursor");
    throw new Error("offline");
  }), /offline/);
});

test("bounds restart attempts and accepts unpaged older clouds", async () => {
  let requests = 0;
  await assert.rejects(readAllTasks(async () => {
    requests++;
    throw Object.assign(new Error("Changed"), { code: "stale_snapshot" });
  }), /Changed/);
  assert.equal(requests, 3);
  const old = page(["a"]); delete old.readRevision;
  assert.deepEqual((await readAllTasks(async () => old)).tasks, [{ id: "a" }]);
  await assert.rejects(readAllTasks(async () => page(["a", "a"])), /duplicate/);
  await assert.rejects(readAllTasks(async () => ({ ...page([]), tasks: [null] })), /incompatible/);
});
