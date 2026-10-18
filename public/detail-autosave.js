// The caller owns validation, CAS and durable replay. One blur save can run at a
// time; a rejected draft stays in the editor until explicitly reviewed.
export function createDetailAutosave({ dirty, busy, save, status, delay = 150 }) {
  let timer, running = false, blocked = false, generation = 0;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const flush = async () => {
    cancel();
    if (blocked || !dirty()) return;
    if (running || busy()) { timer = setTimeout(flush, delay); return; }
    running = true;
    const startedGeneration = generation;
    status("Saving…");
    try {
      const result = await save();
      if (startedGeneration !== generation) return;
      if (result === "awaiting-refresh") {
        blocked = true;
        status("Saved · waiting for refresh");
        return;
      }
      blocked = result !== true;
      status(blocked ? "Not saved · review the message below" : "Saved");
    } catch {
      if (startedGeneration !== generation) return;
      blocked = true;
      status("Not saved · review the message below");
    } finally { running = false; }
  };
  return {
    schedule() { cancel(); if (!blocked && dirty()) timer = setTimeout(flush, delay); },
    reset() { cancel(); generation++; blocked = false; },
    cancel,
    flush,
  };
}
