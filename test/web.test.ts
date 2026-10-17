import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.ts";
import { parseTaskCreateMutation } from "../src/protocol.ts";
import { applyTaskCreate } from "../src/task-create.ts";
import goldenRequest from "./fixtures/valid-task-create.json?raw";

const sessionHeaders = { "x-openza-test-session": "k5-local-read-only" };

describe.sequential("Web current-data and semantic-mutation proof", () => {
  it("exposes only coarse versioned health for provisioning verification", async () => {
    const response = await exports.default.fetch("https://personal-cloud.local/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      protocolVersion: 1,
      product: "tasks",
      artifactVersion: "0.0.0-test",
      schemaVersion: 25,
      capabilities:{mutationBatch:{protocolVersion:1,path:"/v1/tasks/mutations/batch",maxMutations:2,maxRequestUtf8Bytes:16384},workspace:{protocolVersion:1,path:"/v1/tasks/mutations",schemaVersion:25},providerCatalog:{protocolVersion:2,path:"/v1/provider/catalog",intentsPath:"/v1/provider/intents"},workspacePaging:{protocolVersion:1,bootstrapPath:"/sync/bootstrap",changesPath:"/sync/changes",maxResponseUtf8Bytes:2097152,maxPageRecords:100}},
    });
  });

  it("requires the explicit local test session and disables response caching", async () => {
    const response = await exports.default.fetch("https://personal-cloud.local/v1/tasks");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      protocolVersion: 1,
      product: "tasks",
      error: { code: "unauthorized", retryable: false },
    });
  });

  it("reads one task and its Space identity directly from D1", async () => {
    const mutation = parseTaskCreateMutation(goldenRequest, env.INSTANCE_ID);
    await applyTaskCreate(env.DB, mutation, goldenRequest, {
      now: () => new Date("2026-09-13T06:30:01.000Z"),
    });

    const response = await exports.default.fetch("https://personal-cloud.local/v1/tasks", {
      headers: sessionHeaders,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      protocolVersion: 1,
      product: "tasks",
      freshness: "current",
      spaces: [{ id: "space_default", name: "Inbox" }],
      projects: [],
      labels: [],
      hasMore: false,
      tasks: [{
        id: "local_00000000000000000000000000000001",
        title: "Validate one task",
        spaceId: "space_default",
        completionState: "open",
        workflowStatus: "inbox",
        createdAt: "2026-09-13T06:30:00.000Z",
      }],
    });
  });

  it("serves a passkey-protected shell with current/stale states and semantic Openza edits", async () => {
    const [page, script, styles] = await Promise.all([
      exports.default.fetch("https://personal-cloud.local/"),
      exports.default.fetch("https://personal-cloud.local/app.js"),
      exports.default.fetch("https://personal-cloud.local/styles.css"),
    ]);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Your Openza tasks, available from the cloud.");
    expect(pageHtml).toContain('href="/">Tasks</a>');
    expect(pageHtml).toContain('href="/settings">Settings</a>');
    expect(pageHtml).toContain("Create owner passkey");
    expect(pageHtml).toContain("Sign in with passkey");
    expect(pageHtml).toContain("Use recovery code");
    expect(pageHtml).toContain("Next Actions");
    expect(pageHtml).toContain('id="task-dialog"');
    expect(pageHtml).toContain('id="details-dialog"');
    expect(pageHtml).not.toContain('id="delivery-list"');
    expect(pageHtml).toContain("Manage third-party accounts, task intake and routing in Openza Desktop.");
    expect(pageHtml).not.toContain('id="workspace-connected"');
    expect(pageHtml).not.toContain('id="workspace-routing"');
    expect(pageHtml).not.toContain(">Parent<");
    expect(pageHtml).not.toContain("Test-only local session");

    expect(script.status).toBe(200);
    const browserCode = await script.text();
    expect(browserCode).toContain("Online · Current");
    expect(browserCode).toContain("Unavailable · Last known");
    expect(browserCode).toContain("Cached tasks may be outdated and remain read only");
    expect(browserCode).toContain("Reconnecting to Personal Cloud");
    expect(browserCode).toContain("45_000");
    expect(browserCode).toContain("60_000");
    expect(browserCode).toContain("retryRefreshMs=15_000");
    expect(browserCode).toContain("loadTasks({background:true})");
    expect(browserCode).toContain("readAllTasks(api)");
    expect(browserCode).toContain("sessionStorage.getItem(workspaceStateKey)");
    expect(browserCode).toContain("localStorage.setItem(workspaceStateKey");
    expect(browserCode).toContain('api("/auth/session/rotate"');
    expect(browserCode).toContain("sessionRotationMs=10*60_000");
    expect(browserCode).toContain("navigator.credentials.create");
    expect(browserCode).toContain("navigator.credentials.get");
    expect(browserCode).toContain('parameters.get("setup")');
    expect(browserCode).toContain("history.replaceState");
    expect(browserCode).toContain('credentials:"same-origin"');
    expect(browserCode).toContain('headers["x-openza-csrf"]');
    expect(browserCode).toContain('location.pathname==="/settings"');
    expect(browserCode).toContain("tasksPanel.hidden=false");
    expect(browserCode).toContain("moveTaskTree");
    expect(browserCode).toContain("providerDeliveryLabel(task.externalCommand)");
    expect(browserCode).not.toContain("/auth/provider-deliveries");
    expect(browserCode).not.toContain("reconcileDelivery");
    expect(browserCode).not.toContain("prompt(");
    expect(browserCode).not.toContain("k5-local-read-only");
    expect(browserCode).not.toContain("x-openza-test-session");
    for (const operation of ["task.createRich","task.patch","task.moveTree","task.complete","task.reopen","task.delete","task.addLabel","task.removeLabel"])
      expect(browserCode).toContain(operation);

    expect(styles.status).toBe(200);
    expect(styles.headers.get("content-type")).toContain("text/css");
    const stylesheet = await styles.text();
    expect(stylesheet).toContain(".view-nav { display: flex; overflow-x: auto;");
    expect(stylesheet).toContain(".space-list { display: flex; overflow-x: auto;");
    expect(stylesheet).toContain(".sidebar-settings { display: inline-flex;");
    expect(stylesheet).not.toContain(".workspace-brand, .view-nav, .sidebar-section, .sidebar-settings { display: none; }");
  });

  it("returns a non-cacheable generic error when D1 is unavailable", async () => {
    const unavailableDb = {
      prepare: () => { throw new Error("simulated D1 outage with private detail"); },
    } as unknown as D1Database;
    const response = await worker.fetch(new Request("https://personal-cloud.local/v1/tasks", {
      headers: sessionHeaders,
    }), { ...env, DB: unavailableDb, ARTIFACT_VERSION: "0.0.0-test" } as Env);

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await response.json());
    expect(body).toContain('"code":"internal_error"');
    expect(body).not.toContain("private detail");
    expect(body).not.toContain("Validate one task");
  });
});
