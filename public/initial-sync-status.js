const guidance = "Keep Openza Desktop open and connected. Use Retry sync in Desktop if it needs attention, then refresh this page.";
const labels = {
  uploading: "Uploading", complete: "Initial upload complete", blocked: "Upload needs attention",
  interrupted: "Upload heartbeat stopped", unknown: "Progress not reported",
};
const errors = {
  offline: "Desktop reported a connection problem.", unauthorized: "Desktop reported an access problem.",
  cloud_unavailable: "Desktop could not reach Personal Cloud.", conflict: "Desktop reported a sync conflict.",
  interrupted: "Desktop reported an interrupted upload.", unknown: "Desktop reported a sync problem.",
};

export function initialStatusCopy(payload) {
  if (payload?.protocolVersion !== 1 || !labels[payload.state] || !Array.isArray(payload.devices)) return unavailableStatusCopy();
  const devices = payload.devices.map(device => {
    const count = Number.isSafeInteger(device.acknowledged) && Number.isSafeInteger(device.total) &&
      device.acknowledged >= 0 && device.total >= device.acknowledged
      ? ` · ${device.acknowledged} of ${device.total} initial changes uploaded` : "";
    return `${device.displayName || "Desktop"}: ${labels[device.state] || labels.unknown}${count}${errors[device.errorCode] ? ` · ${errors[device.errorCode]}` : ""}`;
  });
  const titles = {
    uploading: "Desktop is uploading your initial changes",
    blocked: "Initial upload needs attention in Desktop",
    interrupted: "Initial upload may have been interrupted",
    unknown: "Initial upload progress is not available",
    complete: "Desktop initial upload complete",
  };
  const details = {
    uploading: `Tasks may appear before their Spaces, projects, and labels arrive. ${guidance} You can keep using tasks already in the cloud.`,
    blocked: `Some initial changes may still be missing. ${guidance}`,
    interrupted: `No upload heartbeat arrived for at least two minutes. This does not confirm completion. ${guidance}`,
    unknown: "A paired desktop has not reported progress, or no desktop is paired. Older Desktop versions may not report it. Check Desktop sync and refresh to see the latest cloud tasks.",
    complete: "All reporting desktops finished their initial changes. Ongoing sync and cloud freshness are shown separately. Refresh to see the latest tasks.",
  };
  const progress = payload.devices.map(device => ({
    label: `${device.displayName || "Desktop"} initial changes uploaded`,
    uploading: device.state === "uploading",
    value: Number.isSafeInteger(device.acknowledged) && device.acknowledged >= 0 ? device.acknowledged : null,
    total: Number.isSafeInteger(device.total) && device.total > 0 && device.total >= device.acknowledged ? device.total : null,
  }));
  return { state: payload.state, title: titles[payload.state], detail: details[payload.state], devices, progress };
}
export function unavailableStatusCopy() {
  return { state: "unavailable", title: "Initial upload progress could not be checked", detail: "Personal Cloud may be offline or may not support progress reporting yet. Check sync in Desktop and refresh this page. Task controls remain available when cloud data is current.", devices: [] };
}

export function initialEmptyState(state, hasCloudTasks = false) {
  if (state === "uploading") return {
    title: hasCloudTasks ? "No matching tasks yet" : "Your tasks are arriving",
    detail: "Initial sync is in progress. Keep Desktop open while tasks, Spaces, projects, and labels arrive.",
  };
  if (state === "blocked" || state === "interrupted") return {
    title: "Initial upload needs attention",
    detail: "Some tasks may not have arrived yet. Check sync in Desktop, use Retry sync, then refresh this page.",
  };
  if (state === "unavailable" || state === "checking") return {
    title: "No matching cloud tasks yet",
    detail: "Initial upload progress has not been confirmed. Check sync in Desktop and refresh this page.",
  };
  return { title: "Nothing here", detail: "Create a task or adjust this view." };
}

// Independent from task reads: a telemetry outage must not block task interactions.
export function createInitialStatusMonitor({ read, render, schedule = setTimeout, cancel = clearTimeout }) {
  let active = false, generation = 0, timer, pending = null;
  async function refresh({ resuming = false } = {}) {
    if (!active) return;
    if (resuming) {
      generation++;
      pending?.controller.abort();
      cancel(pending?.deadline);
      pending = null;
      render({ state: "checking", title: "Checking latest initial upload progress", detail: "Confirming the latest Desktop report after returning to this page.", devices: [] });
    }
    if (pending?.generation === generation) return pending.promise;
    const current = generation;
    const controller = new AbortController();
    const deadline = schedule(() => controller.abort(), 10_000);
    cancel(timer);
    const promise = (async () => {
      try { const payload = await Promise.resolve().then(() => read(controller.signal)); if (active && current === generation) render(initialStatusCopy(payload)); }
      catch { if (active && current === generation) render(unavailableStatusCopy()); }
      finally {
        cancel(deadline);
        if (active && current === generation) { pending = null; timer = schedule(refresh, 30_000); }
      }
    })();
    pending = { generation: current, promise, controller, deadline };
    return promise;
  }
  return {
    start() { if (active) return; active = true; generation++; void refresh(); },
    stop() { active = false; generation++; cancel(timer); pending?.controller.abort(); cancel(pending?.deadline); pending = null; },
    refresh,
  };
}
