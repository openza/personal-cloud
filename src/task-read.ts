import { ContractError } from "./protocol.ts";

type TaskCursor = { createdAt: string; id: string; revision: number };

export function parseTaskCursor(value: string | null): TaskCursor | null {
  if (value === null) return null;
  try {
    if (!value || value.length > 512) throw new Error();
    const cursor = JSON.parse(atob(value));
    if (!cursor || Object.keys(cursor).sort().join(",") !== "createdAt,id,revision" ||
        typeof cursor.createdAt !== "string" || cursor.createdAt.length > 40 ||
        !Number.isFinite(Date.parse(cursor.createdAt)) || typeof cursor.id !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(cursor.id) ||
        !Number.isSafeInteger(cursor.revision) || cursor.revision < 0) throw new Error();
    return cursor;
  } catch {
    throw new ContractError("invalid_request", "The task-list cursor is invalid.");
  }
}

export type ReadOnlyTask = {
  id: string;
  title: string;
  spaceId: string;
  completionState: "open" | "completed";
  workflowStatus: "none" | "inbox" | "next" | "waiting" | "someday";
  priority: 1 | 2 | 3 | 4;
  completedAt: string | null;
  plannedOn: string | null;
  plannedAt: string | null;
  notes: string | null;
  deadlineOn: string | null;
  projectId: string | null;
  parentId: string | null;
  labels: { id: string; name: string }[];
  createdAt: string;
  entityVersion: number;
  source: null | {
    integrationKind: string; sourceUrl: string | null; title: string; description: string | null;
    projectName: string | null; priority: number | null; plannedOn: string | null; plannedAt: string | null;
    deadlineOn: string | null; deadlineAt: string | null; recurrenceRule: string | null; refreshedAt: string;
  };
  externalCommand: null | { command: "complete" | "reopen"; state: "pending_desktop" | "confirmed" | "rejected"; errorCode: string | null; deliveryState:"reserved"|"started"|null };
};

export type TaskReadResponse = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  freshness: "current";
  serverReadAt: string;
  spaces: { id: string; name: string }[];
  projects: { id: string; spaceId: string; name: string }[];
  labels: { id: string; name: string }[];
  tasks: ReadOnlyTask[];
  hasMore: boolean;
  nextCursor: string | null;
  readRevision: number;
};

type TaskRow = {
  id: string;
  title: string;
  space_id: string;
  completion_state: string;
  workflow_status: string;
  priority: number;
  completed_at: string | null;
  planned_on: string | null;
  planned_at: string | null;
  notes: string | null;
  deadline_on: string | null;
  project_id: string | null;
  parent_id: string | null;
  labels_json: string;
  source_integration_kind: string | null; source_url: string | null; source_title: string | null;
  source_description: string | null; source_project_name: string | null; source_priority: number | null;
  source_planned_on: string | null; source_planned_at: string | null; source_deadline_on: string | null;
  source_deadline_at: string | null; source_recurrence_rule: string | null; source_refreshed_at: string | null;
  command: string | null; command_state: string | null; command_error_code: string | null; delivery_state:"reserved"|"started"|null;
  created_at: string;
  entity_version: number;
};

type SpaceRow = { id: string; name: string };
type ProjectRow = { id: string; spaceId: string; name: string };
type LabelRow = { id: string; name: string };

export async function readTasks(
  db: D1Database,
  instanceId: string,
  now: () => Date = () => new Date(),
  cursor: TaskCursor | null = null,
): Promise<TaskReadResponse> {
  const [result, spaces, projects, labels, state] = await db.batch([
    db.prepare(`
    SELECT tasks.id, tasks.title, tasks.space_id, tasks.completion_state,
           tasks.workflow_status, tasks.priority, tasks.created_at, tasks.completed_at,
           tasks.planned_on, tasks.planned_at, tasks.notes, tasks.deadline_on,
           tasks.project_id, tasks.parent_id, tasks.entity_version,
           COALESCE((SELECT json_group_array(json_object('id', labels.id, 'name', labels.name))
             FROM task_labels INNER JOIN labels ON labels.id=task_labels.label_id
             WHERE task_labels.task_id=tasks.id AND labels.deleted_at IS NULL), '[]') AS labels_json,
           source_descriptors.integration_kind AS source_integration_kind,
           source_descriptors.source_url, source_descriptors.source_title, source_descriptors.source_description,
           source_descriptors.source_project_name, source_descriptors.source_priority,
           source_descriptors.source_planned_on, source_descriptors.source_planned_at,
           source_descriptors.source_deadline_on, source_descriptors.source_deadline_at,
           source_descriptors.recurrence_rule AS source_recurrence_rule,
           source_descriptors.refreshed_at AS source_refreshed_at,
           external_commands.command, external_commands.state AS command_state, external_commands.error_code AS command_error_code,
           (SELECT state FROM provider_delivery_claims p WHERE p.task_id=tasks.id AND p.state IN ('reserved','started')) AS delivery_state
    FROM tasks
    INNER JOIN spaces ON spaces.id = tasks.space_id AND spaces.deleted_at IS NULL
    LEFT JOIN source_descriptors ON source_descriptors.task_id=tasks.id
    LEFT JOIN external_commands ON external_commands.task_id=tasks.id
    WHERE tasks.product = 'tasks' AND tasks.deleted_at IS NULL
      AND (?1 IS NULL OR tasks.created_at > ?1 OR (tasks.created_at = ?1 AND tasks.id > ?2))
    ORDER BY tasks.created_at ASC, tasks.id ASC
    LIMIT 1001
  `).bind(cursor?.createdAt ?? null, cursor?.id ?? null),
    db.prepare("SELECT id,name FROM spaces WHERE deleted_at IS NULL ORDER BY name,id"),
    db.prepare("SELECT id,space_id AS spaceId,name FROM projects WHERE deleted_at IS NULL ORDER BY name,id"),
    db.prepare("SELECT id,name FROM labels WHERE deleted_at IS NULL ORDER BY name,id"),
    db.prepare("SELECT next_change_seq AS revision FROM cloud_state WHERE singleton=1"),
  ]) as [D1Result<TaskRow>, D1Result<SpaceRow>, D1Result<ProjectRow>, D1Result<LabelRow>, D1Result<{ revision: number }>];
  const revision = state.results[0].revision;
  if (cursor && cursor.revision !== revision) {
    throw new ContractError("stale_snapshot", "Tasks changed during paging. Restart the task list.");
  }
  const taskRows = result.results.slice(0, 1000);
  const hasMore = result.results.length > taskRows.length;
  const last = taskRows.at(-1);

  return {
    protocolVersion: 1,
    product: "tasks",
    instanceId,
    freshness: "current",
    serverReadAt: now().toISOString(),
    spaces: spaces.results,
    projects: projects.results,
    labels: labels.results,
    hasMore,
    readRevision: revision,
    nextCursor: hasMore && last ? btoa(JSON.stringify({ createdAt: last.created_at, id: last.id, revision })) : null,
    tasks: taskRows.map((row) => ({
      id: row.id,
      title: row.title,
      spaceId: row.space_id,
      completionState: requireCompletionState(row.completion_state),
      workflowStatus: requireWorkflowStatus(row.workflow_status),
      priority: requirePriority(row.priority),
      createdAt: row.created_at,
      completedAt: requireCompletedAt(row.completion_state, row.completed_at),
      plannedOn: row.planned_on,
      plannedAt: row.planned_at,
      notes: row.notes,
      deadlineOn: row.deadline_on,
      projectId: row.project_id,
      parentId: row.parent_id,
      labels: JSON.parse(row.labels_json) as { id: string; name: string }[],
      entityVersion: row.entity_version,
      source: row.source_integration_kind === null ? null : {
        integrationKind: row.source_integration_kind, sourceUrl: row.source_url, title: row.source_title!,
        description: row.source_description, projectName: row.source_project_name, priority: row.source_priority,
        plannedOn: row.source_planned_on, plannedAt: row.source_planned_at, deadlineOn: row.source_deadline_on,
        deadlineAt: row.source_deadline_at, recurrenceRule: row.source_recurrence_rule, refreshedAt: row.source_refreshed_at!,
      },
      externalCommand: row.command === null ? null : {
        command: row.command as "complete" | "reopen", state: row.command_state as "pending_desktop" | "confirmed" | "rejected",
        errorCode: row.command_error_code,
        deliveryState:row.delivery_state,
      },
    })),
  };
}

function requireCompletionState(value: string): ReadOnlyTask["completionState"] {
  if (value === "open" || value === "completed") return value;
  throw new Error("The stored task has an unsupported completion state.");
}

function requireCompletedAt(completionState: string, value: string | null): string | null {
  if (completionState === "open" && value === null) return null;
  if (completionState === "completed" && typeof value === "string") return value;
  throw new Error("The stored task has inconsistent completion data.");
}

function requirePriority(value: number): ReadOnlyTask["priority"] {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  throw new Error("The stored task has an unsupported priority.");
}

function requireWorkflowStatus(value: string): ReadOnlyTask["workflowStatus"] {
  if (value === "none" || value === "inbox" || value === "next" || value === "waiting" || value === "someday") {
    return value;
  }
  throw new Error("The stored task has an unsupported workflow status.");
}
