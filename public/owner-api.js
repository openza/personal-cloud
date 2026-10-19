// HTTP owns serialization, CSRF retry and the session boundary. It never renders.
export function sessionChanged(dispatched = false) {
  return Object.assign(new Error("The owner session changed. Retry from the current session."), {
    code: "session_changed", dispatched,
  });
}

export function createOwnerApi({ fetch, locks, getGeneration, getCsrf, setCsrf }) {
  return async function api(path, options = {}) {
    const generation = getGeneration();
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    let dispatched = false;
    const assertCurrent = () => {
      if (generation !== getGeneration()) throw sessionChanged(dispatched);
    };
    const perform = async () => {
      assertCurrent();
      for (let attempt = 0; attempt < 2; attempt++) {
        assertCurrent();
        const headers = {};
        if (body !== undefined) headers["content-type"] = "application/json";
        if (options.csrf) {
          if (!getCsrf()) throw new Error("Sign in again to continue.");
          headers["x-openza-csrf"] = getCsrf();
        }
        let response, result;
        try {
          dispatched = true;
          response = await fetch(path, { method: options.method || "GET", headers, body,
            credentials: "same-origin", cache: "no-store", signal: options.signal });
          assertCurrent();
          result = await response.json().catch(() => ({}));
          assertCurrent();
        } catch (error) {
          assertCurrent();
          throw error;
        }
        if (response.ok) return result;
        const error = Object.assign(new Error(result?.error?.message || "Personal Cloud rejected the request."), {
          status: response.status, code: result?.error?.code,
        });
        if (options.csrf && attempt === 0 && response.status === 403 && error.code === "csrf_failed") {
          // This attempt was definitively rejected before domain execution.
          dispatched = false;
          try {
            const session = await api("/auth/session");
            assertCurrent();
            if (typeof session.csrfToken !== "string" || !session.csrfToken)
              throw new Error("Owner token refresh was not confirmed.");
            setCsrf(session.csrfToken);
          } catch (refreshError) {
            assertCurrent();
            error.cause = refreshError;
            throw error;
          }
          continue;
        }
        throw error;
      }
    };
    return options.csrf && locks?.request
      ? locks.request("openza-owner-session-write", perform) : perform();
  };
}
