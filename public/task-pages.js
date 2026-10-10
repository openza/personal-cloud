// Publish and cache only a complete, consistent task read, never a partial page.
export async function readAllTasks(api) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const first = await api("/v1/tasks");
      validatePage(first);
      const tasks = [...first.tasks], seen = new Set(), ids = new Set(tasks.map(task => task.id));
      if (ids.size !== tasks.length) throw new Error("Personal Cloud returned duplicate tasks.");
      let page = first;
      while (page.hasMore) {
        if (typeof page.nextCursor !== "string" || !page.nextCursor || seen.has(page.nextCursor)) {
          throw new Error("Personal Cloud returned an invalid task cursor. Update the cloud app.");
        }
        seen.add(page.nextCursor);
        page = await api(`/v1/tasks?cursor=${encodeURIComponent(page.nextCursor)}`);
        validatePage(page);
        if (page.instanceId !== first.instanceId || page.readRevision !== first.readRevision) {
          throw new Error("Personal Cloud changed during the task read.");
        }
        for (const task of page.tasks) {
          if (ids.has(task.id)) throw new Error("Personal Cloud returned duplicate tasks.");
          ids.add(task.id); tasks.push(task);
        }
      }
      return { ...first, tasks, hasMore: false, nextCursor: null };
    } catch (error) {
      if (error.code !== "stale_snapshot" || attempt === 2) throw error;
    }
  }
}

function validatePage(page) {
  if (page.protocolVersion !== 1 || page.product !== "tasks" || page.freshness !== "current" ||
      !Array.isArray(page.tasks) || typeof page.hasMore !== "boolean" ||
      page.tasks.some(task => !task || typeof task.id !== "string")) {
    throw new Error("Personal Cloud returned an incompatible response.");
  }
}
