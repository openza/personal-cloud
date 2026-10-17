// The caller owns validation, CAS and durable replay. One blur save can run at a
// time; a rejected draft stays in the editor until explicitly reviewed.
export function createDetailAutosave({ dirty, busy, save, status, delay = 150 }) {
  let timer, running = false, blocked = false;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const flush = async () => {
    cancel();
    if (blocked || !dirty()) return;
    if (running || busy()) { timer = setTimeout(flush, delay); return; }
    running = true;
    status("Saving…");
    try {
      blocked = !await save();
      status(blocked ? "Not saved · review the message below" : "Saved");
    } catch {
      blocked = true;
      status("Not saved · review the message below");
    } finally { running = false; }
  };
  return {
    schedule() { cancel(); if (!blocked && dirty()) timer = setTimeout(flush, delay); },
    reset() { cancel(); blocked = false; },
    cancel,
    flush,
  };
}
