import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseTaskCursor, readTasks } from "../src/task-read.ts";

async function seedTasks() {
  await env.DB.prepare("DELETE FROM tasks WHERE id LIKE 'task_%'").run();
  await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2005)
    INSERT INTO tasks (id,product,space_id,title,completion_state,workflow_status,created_at,entity_version,created_by_mutation_id)
    SELECT printf('task_%032d',i),'tasks','space_default',printf('Synthetic task %d',i),'open','inbox',
      '2026-10-10T00:00:00.000Z',1,printf('mutation_%032d',i) FROM n`).run();
}

describe.sequential("complete Web task paging", () => {
  it("reads 2005 tasks across tied timestamps without missing or duplicating rows", async () => {
    await seedTasks();
    const first = await readTasks(env.DB, env.INSTANCE_ID);
    expect(first.tasks).toHaveLength(1000);
    expect(first.hasMore).toBe(true);
    const second = await readTasks(env.DB, env.INSTANCE_ID, undefined, parseTaskCursor(first.nextCursor));
    const third = await readTasks(env.DB, env.INSTANCE_ID, undefined, parseTaskCursor(second.nextCursor));
    expect(second.tasks).toHaveLength(1000);
    expect(third.tasks).toHaveLength(5);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
    const ids = [...first.tasks, ...second.tasks, ...third.tasks].map(task => task.id);
    expect(new Set(ids).size).toBe(2005);
    expect(ids.at(-1)).toBe("task_00000000000000000000000000002005");
  });

  it("rejects a continuation after a concurrent mutation, even if its last row was removed", async () => {
    await seedTasks();
    const first = await readTasks(env.DB, env.INSTANCE_ID);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM tasks WHERE id=?").bind(first.tasks.at(-1)!.id),
      env.DB.prepare("UPDATE cloud_state SET next_change_seq=next_change_seq+1"),
    ]);
    await expect(readTasks(env.DB, env.INSTANCE_ID, undefined, parseTaskCursor(first.nextCursor)))
      .rejects.toMatchObject({ code: "stale_snapshot" });
  });

  it("requires owner authorization on continuations and rejects malformed/duplicate query parameters", async () => {
    const cursor = btoa(JSON.stringify({ createdAt: "2026-10-10T00:00:00.000Z", id: "task_a", revision: 0 }));
    const unauthorized = await exports.default.fetch(`https://personal-cloud.local/v1/tasks?cursor=${encodeURIComponent(cursor)}`);
    expect(unauthorized.status).toBe(401);
    for (const query of ["cursor=invalid", "cursor=", "cursor=a&cursor=b", "offset=1000"]) {
      const result = await exports.default.fetch(`https://personal-cloud.local/v1/tasks?${query}`, {
        headers: { "x-openza-test-session": env.K5_TEST_SESSION! },
      });
      expect(result.status).toBe(400);
      expect(result.headers.get("cache-control")).toBe("no-store");
    }
  });
});
