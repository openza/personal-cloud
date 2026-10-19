import {dailyQuotaError,DailyQuotaError} from "./daily-quota.ts";
import {workspaceCapability,providerCatalogCapability} from "./workspace-protocol.ts";
import { schemaReady } from "./schema-readiness.ts";
import {readCatalog} from "./workspace-records.ts";
import {
  ContractError,
  maximumRequestUtf8Bytes,
  parseCheckpointAcknowledgement,
  parseStrictJson,
  parseTaskMutation,
} from "./protocol.ts";
import { pullChanges } from "./change-pull.ts";
import { acknowledgeCheckpoint } from "./checkpoint-ack.ts";
import { parseTaskCursor, readTasks } from "./task-read.ts";
import { bootstrap, compact } from "./bootstrap.ts";
import {bootstrapPage,workspacePagingCapability} from './workspace-paging.ts';
import { authStatus, beginOwnerBootstrap, beginSignIn, finishOwnerBootstrap, finishSignIn, refreshOwnerCsrf, requireOwnerSession, rotateOwnerSession, signOut } from "./auth.ts";
import { createPairingGrant, issueDeviceAccessToken, listDevices, pairDevice, requireDeviceAccess, requireDeviceCapabilities, revokeCurrentDevice, revokeDevice } from "./device-auth.ts";
import { beginRecovery, finishRecovery } from "./recovery.ts";
import { claimDelivery, startDelivery, parseDeliveryRequest, listDeliveries, reconcileDelivery,parseRetryRequest,retryDelivery } from "./provider-delivery.ts";

import { readInitialStatus, reportInitialStatus } from "./initial-sync-status.ts";
import { applyMutation, mutationCapability } from "./mutation-apply.ts";
import { applyMutationBatch, mutationBatchCapability, parseMutationBatch } from "./mutation-batch.ts";

export interface Env {
  DB: D1Database;
  INSTANCE_ID: string;
  ARTIFACT_VERSION: string;
  K5_TEST_SESSION?: string;
  OWNER_BOOTSTRAP_GRANT?: string;
  TEST_MODE?: string;
  ASSETS: Fetcher;
}

const retryableCodes = new Set(["sequence_gap", "parent_not_found", "internal_error", "daily_quota_exceeded"]);
const statusByCode: Record<string, number> = {
  invalid_request: 400,
  unsupported_protocol: 400,
  unsupported_product: 400,
  unsupported: 400,
  instance_mismatch: 400,
  sequence_gap: 409,
  mutation_id_reused: 409,
  entity_exists: 409,
  entity_not_found: 404,
  version_conflict: 409,
  invalid_transition: 409,
  parent_not_found: 409,
  source_not_found: 404,
  command_not_found: 404,
  source_identity_conflict: 409,
  command_superseded: 409,
  delivery_busy: 409,
  stale_snapshot: 409,
  upgrade_required:409,
  schema_not_ready:503,
  daily_quota_exceeded:503,
  bootstrap_changed:409,
  response_too_large:409,
  unauthorized: 401,
  already_initialized: 409,
  not_initialized: 409,
  bootstrap_unavailable: 503,
  invalid_origin: 403,
  csrf_failed: 403,
  rate_limited: 429,
  internal_error: 500,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        if (url.search !== "") throw new ContractError("invalid_request", "Health does not accept query parameters.");
        if (!await schemaReady(env.DB)) throw new ContractError("schema_not_ready", "Personal Cloud is not ready. Retry after setup or update completes.");
        return noStoreJson({ status: "ok", protocolVersion: 1, product: "tasks", artifactVersion: env.ARTIFACT_VERSION,
          schemaVersion: 25, capabilities: { mutationBatch: mutationBatchCapability, workspace:workspaceCapability,providerCatalog:providerCatalogCapability,workspacePaging:workspacePagingCapability } });
      }
      if (request.method === "GET" && url.pathname === "/auth/status") {
        return noStoreJson(await authStatus(env.DB));
      }
      if (request.method === "POST" && url.pathname === "/auth/bootstrap/begin") {
        return await beginOwnerBootstrap(request, env, await readBoundedBody(request));
      }
      if (request.method === "POST" && url.pathname === "/auth/bootstrap/finish") {
        return await finishOwnerBootstrap(request, env, await readBoundedBody(request));
      }
      if (request.method === "POST" && url.pathname === "/auth/signin/begin") {
        return await beginSignIn(request, env, await readBoundedBody(request));
      }
      if (request.method === "POST" && url.pathname === "/auth/signin/finish") {
        return await finishSignIn(request, env, await readBoundedBody(request));
      }
      if (request.method === "POST" && url.pathname === "/auth/recovery/begin") {
        return await beginRecovery(request, env.DB);
      }
      if (request.method === "POST" && url.pathname === "/auth/recovery/finish") {
        return await finishRecovery(request, env.DB);
      }
      if (request.method === "GET" && url.pathname === "/auth/session") {
        return await refreshOwnerCsrf(request, env.DB);
      }
      if (request.method === "POST" && url.pathname === "/auth/signout") {
        return await signOut(request, env.DB);
      }
      if (request.method === "POST" && url.pathname === "/auth/session/rotate") {
        return await rotateOwnerSession(request, env.DB);
      }
      if (request.method === "POST" && url.pathname === "/auth/pairing-grants") {
        return await createPairingGrant(request, env.DB, env.INSTANCE_ID);
      }
      if (request.method === "POST" && url.pathname === "/auth/pair") {
        return await pairDevice(request, env.DB, env.INSTANCE_ID);
      }
      if (request.method === "POST" && url.pathname === "/auth/device/token") {
        return await issueDeviceAccessToken(request, env.DB);
      }
      if (request.method === "POST" && url.pathname === "/auth/device/revoke") {
        return await revokeCurrentDevice(request, env.DB);
      }
      if (request.method === "GET" && url.pathname === "/auth/devices") {
        return await listDevices(request, env.DB);
      }
      const revokeMatch = request.method === "POST" ? url.pathname.match(/^\/auth\/devices\/([A-Za-z0-9_.:-]+)\/revoke$/) : null;
      if (revokeMatch) return await revokeDevice(request, env.DB, revokeMatch[1]);
      if (url.pathname === "/sync/initial-status" && ["GET", "POST"].includes(request.method)) {
        if (url.search !== "") throw new ContractError("invalid_request", "Initial status does not accept query parameters.");
        if (request.method === "GET") {
          await requireOwnerSession(request, env.DB);
          return noStoreJson(await readInitialStatus(env.DB));
        }
        const deviceId = await requireDeviceAccess(request, env.DB, "desktop_sync");
        return noStoreJson(await reportInitialStatus(env.DB, deviceId, await readBoundedBody(request)));
      }
      if (request.method === "GET" && url.pathname === "/sync/bootstrap") {
        const paged=url.searchParams.get('paged')==='1',keys=[...url.searchParams.keys()];
        if(keys.some(k=>!['workspace','paged','cursor'].includes(k)||url.searchParams.getAll(k).length!==1)||keys.includes('workspace')&&url.searchParams.get('workspace')!=='1'||(keys.includes('paged')||keys.includes('cursor'))&&(!paged||url.searchParams.get('workspace')!=='1')||!paged&&keys.includes('cursor'))throw new ContractError('invalid_request','Invalid workspace bootstrap parameters.');
        const actor=await authorizeSync(request, env, false, "desktop_sync");
        if(paged)return noStoreJson(await bootstrapPage(env.DB,env.INSTANCE_ID,actor??'owner',url.searchParams.get('cursor')));
        return noStoreJson(await bootstrap(env.DB,url.searchParams.get("workspace")==="1"));
      }
      if (request.method === "POST" && url.pathname === "/sync/compact") {
        if (env.TEST_MODE === "true") {
          if (request.headers.get("x-openza-test-session") !== env.K5_TEST_SESSION) throw new ContractError("unauthorized", "A local test session is required.");
        } else await requireOwnerSession(request, env.DB, true);
        const body=parseStrictJson(await readBoundedBody(request)) as {now?:unknown};
        if(body===null || typeof body!=="object" || Object.keys(body).length!==1 || typeof body.now!=="string") throw new ContractError("invalid_request","Compaction requires only a now timestamp.");
        return noStoreJson(await compact(env.DB,body.now));
      }
      if(request.method==="GET"&&["/v1/provider/catalog","/v1/provider/intents"].includes(url.pathname)){
        if(url.search!=="")throw new ContractError("invalid_request","Catalog reads do not accept query parameters.");
        let device:string|undefined;
        if(url.pathname.endsWith("/intents")){device=env.TEST_MODE==="true"?request.headers.get("x-openza-test-device")??undefined:await requireDeviceAccess(request,env.DB,"provider_bridge");if(!device)throw new ContractError("unauthorized","Provider bridge required.");}
        else if(env.TEST_MODE!=="true")await requireOwnerSession(request,env.DB);
        return noStoreJson(await readCatalog(env.DB,env.INSTANCE_ID,device));
      }
      if (request.method === "GET" && url.pathname === "/v1/tasks") {
        if (env.TEST_MODE === "true") {
          if (request.headers.get("x-openza-test-session") !== env.K5_TEST_SESSION) throw new ContractError("unauthorized", "A local test session is required.");
        } else await requireOwnerSession(request, env.DB);
        const keys = [...url.searchParams.keys()];
        if (keys.length > 1 || (keys.length === 1 && keys[0] !== "cursor")) {
          throw new ContractError("invalid_request", "Task lists accept only one cursor parameter.");
        }
        return noStoreJson(await readTasks(env.DB, env.INSTANCE_ID, undefined, parseTaskCursor(url.searchParams.get("cursor"))));
      }
      if(request.method==="POST"&&["/v1/provider/commands/claim","/v1/provider/commands/start","/v1/provider/commands/retry"].includes(url.pathname)){
        const raw=await readBoundedBody(request);
        const actor=env.TEST_MODE==="true"?request.headers.get("x-openza-test-device"):await requireDeviceAccess(request,env.DB,"provider_bridge");
        if(!actor)throw new ContractError("unauthorized","Provider-device access is required.");
        if(url.pathname.endsWith("/retry"))return noStoreJson({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,
          ...await retryDelivery(env.DB,parseRetryRequest(raw,env.INSTANCE_ID,actor))});
        const body=parseDeliveryRequest(raw,env.INSTANCE_ID,actor,url.pathname.endsWith("/claim"));
        const claim=url.pathname.endsWith("/claim")?await claimDelivery(env.DB,body):await startDelivery(env.DB,body.claimId,actor);
        return noStoreJson({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,claim});
      }
      if(request.method==="GET"&&url.pathname==="/auth/provider-deliveries"){
        await requireOwnerSession(request,env.DB);
        if([...url.searchParams.keys()].some(key=>key!=="cursor")||url.searchParams.getAll("cursor").length>1)throw new ContractError("invalid_request","Deliveries accept one cursor only.");
        return noStoreJson({protocolVersion:1,...await listDeliveries(env.DB,url.searchParams.get("cursor"))});
      }
      if(request.method==="POST"&&url.pathname==="/auth/provider-deliveries/reconcile"){
        await requireOwnerSession(request,env.DB,true);return noStoreJson(await reconcileDelivery(env.DB,await readBoundedBody(request)));
      }
      if (request.method === "GET" && url.pathname === "/sync/changes") {
        await authorizeSync(request, env, false, "desktop_sync");
        const keys = [...url.searchParams.keys()];
        const paged=url.searchParams.get('paged')==='1';
        if (keys.some(k=>!["after","limit","workspace","paged"].includes(k)||url.searchParams.getAll(k).length!==1) || keys.includes('workspace')&&url.searchParams.get('workspace')!=='1'||keys.includes('paged')&&(!paged||url.searchParams.get('workspace')!=='1') || !keys.includes("after") || !keys.includes("limit") ||
            url.searchParams.getAll("after").length !== 1 || url.searchParams.getAll("limit").length !== 1) {
          throw new ContractError("invalid_request", "K3 requires exactly one after and one limit parameter.");
        }
        const after = parseNonNegativeInteger(url.searchParams.get("after"), "after");
        const limit = parseBoundedLimit(url.searchParams.get("limit"));
        return noStoreJson(await pullChanges(env.DB, after, limit,url.searchParams.get("workspace")==="1",paged));
      }
      if (request.method === "POST" && url.pathname === "/sync/checkpoints") {
        const actor = await authorizeSync(request, env, true, "desktop_sync");
        const rawRequest = await readBoundedBody(request);
        const acknowledgement = parseCheckpointAcknowledgement(rawRequest, env.INSTANCE_ID);
        requireActorDevice(actor, acknowledgement.deviceId);
        return Response.json(await acknowledgeCheckpoint(env.DB, acknowledgement));
      }
      if (request.method === "POST" && url.pathname === mutationBatchCapability.path) {
        if (url.search !== "") throw new ContractError("invalid_request", "Mutation batches do not accept query parameters.");
        const items = parseMutationBatch(await readBoundedBody(request), env.INSTANCE_ID);
        const actor = await requireDeviceCapabilities(request, env.DB,
          [...new Set(items.map(item => mutationCapability(item.mutation)))]);
        requireActorDevice(actor, items[0].mutation.deviceId);
        return noStoreJson(await applyMutationBatch(env.DB, env.INSTANCE_ID, items, publicMutationError));
      }
      if (request.method !== "POST" || url.pathname !== "/v1/tasks/mutations") {
        if (request.method === "GET" && !url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/sync/")) {
          return secureResponse(await env.ASSETS.fetch(request));
        }
        throw new ContractError(
          "invalid_request",
          "Use POST /v1/tasks/mutations, GET /sync/changes, or POST /sync/checkpoints.",
        );
      }

      const rawRequest = await readBoundedBody(request);
      const mutation = parseTaskMutation(rawRequest, env.INSTANCE_ID);
      const actor = await authorizeSync(request, env, true, mutationCapability(mutation));
      requireActorDevice(actor, mutation.deviceId);
      const receipt = await applyMutation(env.DB, mutation, rawRequest);
      return Response.json(receipt, { status: receipt.outcome === "accepted" ? 201 : 200 });
    } catch (error) {
      const quota=dailyQuotaError(error);if(quota)return errorResponse(quota);
      if (error instanceof ContractError) return errorResponse(error);
      return errorResponse(new ContractError("internal_error", "The mutation could not be applied."));
    }
  },
};

async function authorizeSync(
  request: Request,
  env: Env,
  stateChanging: boolean,
  capability: "desktop_sync" | "provider_bridge",
): Promise<string | null> {
  if (env.TEST_MODE === "true") return null;
  if(capability==="provider_bridge")return await requireDeviceAccess(request,env.DB,capability);
  if ((request.headers.get("cookie") ?? "").includes("__Host-openza_session=")) {
    await requireOwnerSession(request, env.DB, stateChanging);
    return null; // Owner browser sessions use their own Web replica identity.
  }
  return await requireDeviceAccess(request, env.DB, capability);
}

function requireActorDevice(actor: string | null, submittedDeviceId: string): void {
  if (actor !== null && actor !== submittedDeviceId) {
    throw new ContractError("unauthorized", "The request device does not match its authenticated access.");
  }
}

async function readBoundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumRequestUtf8Bytes)) {
    throw new ContractError("invalid_request", "The request body exceeds the K4 size limit.");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumRequestUtf8Bytes) {
    throw new ContractError("invalid_request", "The request body exceeds the K4 size limit.");
  }
  return body;
}

function parseNonNegativeInteger(value: string | null, field: string): number {
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new ContractError("invalid_request", `${field} must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ContractError("invalid_request", `${field} exceeds the supported range.`);
  }
  return parsed;
}

function parseBoundedLimit(value: string | null): number {
  const parsed = parseNonNegativeInteger(value, "limit");
  if (parsed < 1 || parsed > 50) {
    throw new ContractError("invalid_request", "Change pages contain between 1 and 50 changes.");
  }
  return parsed;
}

function errorResponse(error: ContractError): Response {
  const detail = publicMutationError(error);
  return noStoreJson({ protocolVersion: 1, product: "tasks", error: detail }, { status: statusByCode[detail.code] ?? 500, ...(error instanceof DailyQuotaError?{headers:{"retry-after":String(Math.max(1,Math.ceil((Date.parse(error.quota.resetAt)-Date.now())/1000)))}}:{}) });
}

function publicMutationError(error: unknown) {
  error=dailyQuotaError(error)??error;
  if (!(error instanceof ContractError)) error = new ContractError("internal_error", "The mutation could not be applied.");
  const contract = error as ContractError;
  const code = contract.code in statusByCode ? contract.code : "internal_error";
  return {
      code,
      message: code === "internal_error" ? "The mutation could not be applied." : contract.message,
      retryable: retryableCodes.has(code),
      requestId: `request_${crypto.randomUUID()}`,
      ...(contract instanceof DailyQuotaError?{quota:contract.quota}:{}),
  };
}

function noStoreJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return Response.json(value, { ...init, headers });
}

function secureResponse(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  secured.headers.set("x-frame-options", "DENY");
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("referrer-policy", "no-referrer");
  secured.headers.set("cache-control", "no-cache");
  return secured;
}
