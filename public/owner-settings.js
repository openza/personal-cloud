// Settings requests may outlive signout. Only their originating session renders.
export function createOwnerSettings({ api, getGeneration, isSignedIn, renderPairing,
  renderDevices, pairingError, devicesError, onUnauthorized }) {
  async function run(path, options, render, renderError) {
    const generation = getGeneration();
    const current = () => generation === getGeneration() && isSignedIn();
    try {
      const result = await api(path, options);
      if (current()) render(result);
    } catch (error) {
      if (!current()) return;
      if (error.status === 401) { await onUnauthorized(); return; }
      renderError(error.message);
    }
  }
  return {
    createPairingGrant: () => run("/auth/pairing-grants", { method: "POST", csrf: true, body: {} }, renderPairing, pairingError),
    loadDevices: () => run("/auth/devices", undefined, renderDevices, devicesError),
  };
}
