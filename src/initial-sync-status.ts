import { ContractError, parseStrictJson } from "./protocol.ts";
import { requireRateLimit } from "./auth.ts";

export const staleAfterSeconds = 120;
const errorCodes = new Set(["offline", "unauthorized", "cloud_unavailable", "conflict", "interrupted", "unknown"]);
type ReportState = "uploading" | "complete" | "blocked";
type StatusState = ReportState | "unknown" | "interrupted";
interface Report { protocolVersion: 1; reportSequence: number; state: ReportState; acknowledged: number | null; total: number | null; errorCode?: string }
interface StatusRow {
  device_id: string; display_name: string; state: ReportState | null;
  acknowledged: number | null; total: number | null; error_code: string | null; updated_at: string | null;
}

export function parseInitialStatus(raw: string): Report {
  if (new TextEncoder().encode(raw).byteLength > 2048) invalid();
  const value = parseStrictJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  const required = ["protocolVersion", "reportSequence", "state", "acknowledged", "total"];
  if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && key !== "errorCode")) invalid();
  if (value.protocolVersion !== 1 || !Number.isSafeInteger(value.reportSequence) || (value.reportSequence as number) < 1) invalid();
  if (!["uploading", "complete", "blocked"].includes(value.state as string)) invalid();
  const unknown = value.acknowledged === null && value.total === null;
  if (!unknown && (!Number.isSafeInteger(value.acknowledged) || !Number.isSafeInteger(value.total) ||
      (value.acknowledged as number) < 0 || (value.total as number) < (value.acknowledged as number))) invalid();
  if (value.state === "complete" && (unknown || value.acknowledged !== value.total)) invalid();
  if (keys.includes("errorCode") && (value.state !== "blocked" || !errorCodes.has(value.errorCode as string))) invalid();
  return value as unknown as Report;
}

export async function reportInitialStatus(db: D1Database, deviceId: string, raw: string) {
  const report = parseInitialStatus(raw);
  await requireRateLimit(db, `initial-status:${deviceId}`);
  const updatedAt = new Date().toISOString();
  // A single conditional write orders late/concurrent requests and makes initial completion terminal.
  const result = await db.prepare(`INSERT INTO initial_sync_status
    (device_id,report_sequence,state,acknowledged,total,error_code,updated_at)
    SELECT device_id,?2,?3,?4,?5,?6,?7 FROM devices WHERE device_id=?1 AND revoked_at IS NULL AND can_sync=1
    ON CONFLICT(device_id) DO UPDATE SET report_sequence=excluded.report_sequence,state=excluded.state,
      acknowledged=excluded.acknowledged,total=excluded.total,error_code=excluded.error_code,updated_at=excluded.updated_at
    WHERE excluded.report_sequence>initial_sync_status.report_sequence AND
      (initial_sync_status.state!='complete' OR (excluded.state='complete' AND
       excluded.acknowledged=initial_sync_status.acknowledged AND excluded.total=initial_sync_status.total))`)
    .bind(deviceId, report.reportSequence, report.state, report.acknowledged, report.total, report.errorCode ?? null, updatedAt).run();
  const current = await db.prepare("SELECT updated_at FROM initial_sync_status WHERE device_id=?1")
    .bind(deviceId).first<{ updated_at: string }>();
  return { protocolVersion: 1, accepted: result.meta.changes > 0, updatedAt: current?.updated_at ?? null };
}

export async function readInitialStatus(db: D1Database, now = new Date()) {
  const rows = await db.prepare(`SELECT d.device_id,d.display_name,s.state,s.acknowledged,s.total,s.error_code,s.updated_at
    FROM devices d LEFT JOIN initial_sync_status s ON s.device_id=d.device_id
    WHERE d.revoked_at IS NULL AND d.can_sync=1 ORDER BY d.created_at,d.device_id`).all<StatusRow>();
  const devices = rows.results.map(row => {
    const state: StatusState = row.state === "uploading" &&
      (!row.updated_at || now.valueOf() - Date.parse(row.updated_at) >= staleAfterSeconds * 1000)
      ? "interrupted" : row.state ?? "unknown";
    return { deviceId: row.device_id, displayName: row.display_name, state,
      acknowledged: row.acknowledged, total: row.total,
      ...(row.error_code ? { errorCode: row.error_code } : {}), updatedAt: row.updated_at };
  });
  const precedence: StatusState[] = ["uploading", "blocked", "interrupted", "unknown", "complete"];
  const state = precedence.find(candidate => devices.some(device => device.state === candidate)) ?? "unknown";
  return { protocolVersion: 1, serverReadAt: now.toISOString(), staleAfterSeconds, state, devices };
}
function invalid(): never { throw new ContractError("invalid_request", "The initial upload status is invalid."); }
