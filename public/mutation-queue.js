// One durable pending envelope per browser replica. Web Locks serialize tabs.
export function createMutationSender({ storage, locks, send, sequenceKey, makeId, now }) {
  return async function sendMutation(instanceId, deviceId, entityId, baseEntityVersion, operation, payload) {
    if (!locks?.request) throw new Error("This browser cannot safely coordinate task writes. Use a current browser with Web Locks support.");
    const key = `${sequenceKey}:${instanceId}:${deviceId}`;
    return locks.request(`${key}:write`, async () => {
      const pendingKey = `${key}:pending`;
      const saved = storage.getItem(pendingKey);
      let body;
      if (saved) {
        body = JSON.parse(saved);
        if (body.instanceId !== instanceId || body.deviceId !== deviceId || !Number.isSafeInteger(body.deviceSequence)) {
          throw new Error("The pending task change is invalid. Do not clear browser data before contacting support.");
        }
      } else {
        const sequence = Number(storage.getItem(key) || "1");
        if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("The browser task sequence is invalid.");
        body = { protocolVersion: 1, product: "tasks", instanceId, deviceId, mutationId: makeId(),
          deviceSequence: sequence, operation, entityId, baseEntityVersion, payload, clientCreatedAt: now() };
        // If durable storage fails, never submit an envelope we cannot retry.
        storage.setItem(pendingKey, JSON.stringify(body));
      }
      let receipt;
      try {
        receipt = await send(body);
      } catch (error) {
        // Definitive contract rejections did not consume the sequence. Keep
        // uncertain network/server/auth failures for exact replay after retry.
        if (error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403 && error.status !== 429) {
          storage.removeItem(pendingKey);
        }
        throw error;
      }
      if (receipt.mutationId !== body.mutationId || receipt.entityId !== body.entityId ||
          !["accepted", "duplicate"].includes(receipt.outcome)) throw new Error("The task receipt could not be confirmed. Retry to reconcile the pending change.");
      storage.setItem(key, String(body.deviceSequence + 1));
      storage.removeItem(pendingKey);
      if (saved && (body.entityId !== entityId || body.baseEntityVersion !== baseEntityVersion ||
          body.operation !== operation || JSON.stringify(body.payload) !== JSON.stringify(payload))) {
        const error = new Error("The previous task change was saved. Tasks have been refreshed; retry your next change.");
        error.code = "pending_reconciled";
        throw error;
      }
      return receipt;
    });
  };
}
