export type TaskCreatedChange = {
  protocolVersion: 1;
  product: "tasks";
  changeSeq: number;
  mutationId: string;
  operation: "task.created";
  entityKind: "task";
  entityId: string;
  entityVersion: 1;
  payload: {
    task: {
      id: string;
      spaceId: string;
      title: string;
      completionState: "open";
      workflowStatus: "inbox";
      createdAt: string;
    };
  };
  serverAcceptedAt: string;
};

export type TaskTitleUpdatedChange = {
  protocolVersion: 1;
  product: "tasks";
  changeSeq: number;
  mutationId: string;
  operation: "task.updatedOpenzaFields";
  entityKind: "task";
  entityId: string;
  entityVersion: number;
  payload: {
    task: {
      id: string;
      title: string;
    };
  };
  serverAcceptedAt: string;
};

export type TaskWorkflowStatusUpdatedChange = {
  protocolVersion: 1;
  product: "tasks";
  changeSeq: number;
  mutationId: string;
  operation: "task.updatedOpenzaFields";
  entityKind: "task";
  entityId: string;
  entityVersion: number;
  payload: {
    task: {
      id: string;
      workflowStatus: "none" | "inbox" | "next" | "waiting" | "someday";
    };
  };
  serverAcceptedAt: string;
};

export type TaskPriorityUpdatedChange = {
  protocolVersion: 1;
  product: "tasks";
  changeSeq: number;
  mutationId: string;
  operation: "task.updatedOpenzaFields";
  entityKind: "task";
  entityId: string;
  entityVersion: number;
  payload: {
    task: {
      id: string;
      priority: 1 | 2 | 3 | 4;
    };
  };
  serverAcceptedAt: string;
};

export type TaskPlannedOnUpdatedChange = {
  protocolVersion: 1;
  product: "tasks";
  changeSeq: number;
  mutationId: string;
  operation: "task.updatedOpenzaFields";
  entityKind: "task";
  entityId: string;
  entityVersion: number;
  payload: { task: { id: string; plannedOn: string | null } };
  serverAcceptedAt: string;
};

export type TaskPlannedAtUpdatedChange = {
  protocolVersion: 1;
  product: "tasks";
  changeSeq: number;
  mutationId: string;
  operation: "task.updatedOpenzaFields";
  entityKind: "task";
  entityId: string;
  entityVersion: number;
  payload: { task: { id: string; plannedAt: string | null } };
  serverAcceptedAt: string;
};

export type TaskNotesUpdatedChange = {
  protocolVersion: 1; product: "tasks"; changeSeq: number; mutationId: string;
  operation: "task.updatedOpenzaFields"; entityKind: "task"; entityId: string; entityVersion: number;
  payload: { task: { id: string; notes: string | null } }; serverAcceptedAt: string;
};

export type TaskDeadlineOnUpdatedChange = {
  protocolVersion: 1; product: "tasks"; changeSeq: number; mutationId: string;
  operation: "task.updatedOpenzaFields"; entityKind: "task"; entityId: string; entityVersion: number;
  payload: { task: { id: string; deadlineOn: string | null } }; serverAcceptedAt: string;
};

export type TaskCompletedChange = {
  protocolVersion: 1;
  product: "tasks";
  changeSeq: number;
  mutationId: string;
  operation: "task.completed";
  entityKind: "task";
  entityId: string;
  entityVersion: number;
  payload: {
    task: {
      id: string;
      completionState: "completed";
      completedAt: string;
    };
  };
  serverAcceptedAt: string;
};

export type TaskReopenedChange = {
  protocolVersion: 1;
  product: "tasks";
  changeSeq: number;
  mutationId: string;
  operation: "task.reopened";
  entityKind: "task";
  entityId: string;
  entityVersion: number;
  payload: {
    task: {
      id: string;
      completionState: "open";
      completedAt: null;
    };
  };
  serverAcceptedAt: string;
};

export type TaskDeletedChange = {
  protocolVersion: 1; product: "tasks"; changeSeq: number; mutationId: string;
  operation: "task.deleted"; entityKind: "task"; entityId: string; entityVersion: number;
  payload: { task: { id: string; deletedAt: string } }; serverAcceptedAt: string;
};

export type TaskRelationshipChange = {
  protocolVersion: 1; product: "tasks"; changeSeq: number; mutationId: string;
  operation: "task.projectSet" | "task.moved" | "task.labelAdded" | "task.labelRemoved" | "task.parentSet";
  entityKind: "task"; entityId: string; entityVersion: number;
  payload: { task: Record<string, unknown> & { id: string } }; serverAcceptedAt: string;
};

export type TaskSourceRefreshedChange = {
  protocolVersion: 1; product: "tasks"; changeSeq: number; mutationId: string;
  operation: "task.updatedOpenzaFields"; entityKind: "task"; entityId: string; entityVersion: number;
  payload: { task: { id: string; source: Record<string, unknown> } }; serverAcceptedAt: string;
};

export type TaskExternalCommandChanged = {
  protocolVersion: 1; product: "tasks"; changeSeq: number; mutationId: string;
  operation: "task.updatedOpenzaFields"; entityKind: "task"; entityId: string; entityVersion: number;
  payload: { task: { id: string; externalCommand: {
    command: "complete" | "reopen"; state: "pending_desktop" | "confirmed" | "rejected"; errorCode: string | null;
    requestedChangeSeq?: number;
  } } }; serverAcceptedAt: string;
};

export type TaskChange =
  TaskCreatedChange | TaskTitleUpdatedChange | TaskWorkflowStatusUpdatedChange | TaskPriorityUpdatedChange |
  TaskPlannedOnUpdatedChange | TaskPlannedAtUpdatedChange | TaskNotesUpdatedChange | TaskDeadlineOnUpdatedChange |
  TaskCompletedChange | TaskReopenedChange | TaskDeletedChange | TaskRelationshipChange |
  TaskSourceRefreshedChange | TaskExternalCommandChanged;

export type ChangePage = {
  protocolVersion: 1;
  product: "tasks";
  changes: TaskChange[];
  nextCheckpoint: number;
};

type ChangeRow = {
  protocol_version: number;
  product: string;
  change_seq: number;
  mutation_id: string;
  operation: string;
  entity_kind: string;
  entity_id: string;
  entity_version: number;
  payload_json: string;
  server_accepted_at: string;
};

export async function pullChanges(db: D1Database, after: number, limit: number): Promise<ChangePage> {
  const result = await db.prepare(`
    SELECT protocol_version, product, change_seq, mutation_id, operation, entity_kind,
           entity_id, entity_version, payload_json, server_accepted_at
    FROM changes
    WHERE product = 'tasks' AND change_seq > ?1
    ORDER BY change_seq ASC
    LIMIT ?2
  `).bind(after, limit).all<ChangeRow>();

  const changes = result.results.map(toChange);
  return {
    protocolVersion: 1,
    product: "tasks",
    changes,
    nextCheckpoint: changes.at(-1)?.changeSeq ?? after,
  };
}

function toChange(row: ChangeRow): TaskChange {
  if (row.protocol_version !== 1 || row.product !== "tasks" || row.entity_kind !== "task" ||
      !Number.isSafeInteger(row.entity_version) || row.entity_version <= 0) {
    throw new Error("The stored change is outside the Tasks change contract.");
  }

  const common = {
    protocolVersion: 1 as const,
    product: "tasks" as const,
    changeSeq: row.change_seq,
    mutationId: row.mutation_id,
    entityKind: "task" as const,
    entityId: row.entity_id,
    entityVersion: row.entity_version,
    serverAcceptedAt: row.server_accepted_at,
  };

  if (row.operation === "task.created" && row.entity_version === 1) {
    return {
      ...common,
      operation: "task.created",
      entityVersion: 1,
      payload: JSON.parse(row.payload_json) as TaskCreatedChange["payload"],
    };
  }
  if (row.operation === "task.updatedOpenzaFields") {
    const payload = parseOpenzaFieldsUpdatePayload(row.payload_json, row.entity_id);
    if ("title" in payload.task) {
      return {
        ...common,
        operation: "task.updatedOpenzaFields",
        payload: payload as TaskTitleUpdatedChange["payload"],
      };
    }
    if ("workflowStatus" in payload.task) {
      return {
        ...common,
        operation: "task.updatedOpenzaFields",
        payload: payload as TaskWorkflowStatusUpdatedChange["payload"],
      };
    }
    if ("plannedOn" in payload.task) {
      return {
        ...common,
        operation: "task.updatedOpenzaFields",
        payload: payload as TaskPlannedOnUpdatedChange["payload"],
      };
    }
    if ("plannedAt" in payload.task) {
      return {
        ...common,
        operation: "task.updatedOpenzaFields",
        payload: payload as TaskPlannedAtUpdatedChange["payload"],
      };
    }
    if ("notes" in payload.task) {
      return { ...common, operation: "task.updatedOpenzaFields", payload: payload as TaskNotesUpdatedChange["payload"] };
    }
    if ("deadlineOn" in payload.task) {
      return { ...common, operation: "task.updatedOpenzaFields", payload: payload as TaskDeadlineOnUpdatedChange["payload"] };
    }
    if ("source" in payload.task) {
      return { ...common, operation: "task.updatedOpenzaFields", payload: payload as TaskSourceRefreshedChange["payload"] };
    }
    if ("externalCommand" in payload.task) {
      return { ...common, operation: "task.updatedOpenzaFields", payload: payload as TaskExternalCommandChanged["payload"] };
    }
    return {
      ...common,
      operation: "task.updatedOpenzaFields",
      payload: payload as TaskPriorityUpdatedChange["payload"],
    };
  }
  if (row.operation === "task.completed" && row.entity_version > 1) {
    return {
      ...common,
      operation: "task.completed",
      payload: parseCompletedPayload(row.payload_json, row.entity_id),
    };
  }
  if (row.operation === "task.reopened" && row.entity_version > 1) {
    return {
      ...common,
      operation: "task.reopened",
      payload: parseReopenedPayload(row.payload_json, row.entity_id),
    };
  }
  if (row.operation === "task.deleted" && row.entity_version > 1) {
    return { ...common, operation: "task.deleted", payload: parseDeletedPayload(row.payload_json, row.entity_id) };
  }
  if (["task.projectSet", "task.moved", "task.labelAdded", "task.labelRemoved", "task.parentSet"].includes(row.operation) && row.entity_version > 1) {
    const payload = JSON.parse(row.payload_json) as unknown;
    if (!isExactObject(payload, ["task"]) || payload.task === null || typeof payload.task !== "object" ||
        Array.isArray(payload.task) || (payload.task as Record<string, unknown>).id !== row.entity_id) {
      throw new Error("The stored task relationship payload is invalid.");
    }
    return { ...common, operation: row.operation as TaskRelationshipChange["operation"], payload: payload as TaskRelationshipChange["payload"] };
  }
  throw new Error("The stored change operation is outside the Tasks change contract.");
}

function parseDeletedPayload(json: string, expectedEntityId: string): TaskDeletedChange["payload"] {
  const value = JSON.parse(json) as unknown;
  if (!isExactObject(value, ["task"]) || !isExactObject(value.task, ["deletedAt", "id"]) ||
      value.task.id !== expectedEntityId || !isTimestamp(value.task.deletedAt))
    throw new Error("The stored task deletion payload is invalid.");
  return value as TaskDeletedChange["payload"];
}

function parseReopenedPayload(json: string, expectedEntityId: string): TaskReopenedChange["payload"] {
  const value = JSON.parse(json) as unknown;
  if (!isExactObject(value, ["task"]) ||
      !isExactObject(value.task, ["completedAt", "completionState", "id"]) ||
      value.task.id !== expectedEntityId || value.task.completionState !== "open" ||
      value.task.completedAt !== null) {
    throw new Error("The stored task reopening payload is invalid.");
  }
  return value as TaskReopenedChange["payload"];
}

function parseCompletedPayload(json: string, expectedEntityId: string): TaskCompletedChange["payload"] {
  const value = JSON.parse(json) as unknown;
  if (!isExactObject(value, ["task"]) ||
      !isExactObject(value.task, ["completedAt", "completionState", "id"]) ||
      value.task.id !== expectedEntityId || value.task.completionState !== "completed" ||
      typeof value.task.completedAt !== "string") {
    throw new Error("The stored task completion payload is invalid.");
  }
  return value as TaskCompletedChange["payload"];
}

function parseOpenzaFieldsUpdatePayload(
  json: string,
  expectedEntityId: string,
): TaskTitleUpdatedChange["payload"] |
   TaskWorkflowStatusUpdatedChange["payload"] |
   TaskPriorityUpdatedChange["payload"] |
   TaskPlannedOnUpdatedChange["payload"] |
   TaskPlannedAtUpdatedChange["payload"] |
   TaskNotesUpdatedChange["payload"] |
   TaskDeadlineOnUpdatedChange["payload"] |
   TaskSourceRefreshedChange["payload"] |
   TaskExternalCommandChanged["payload"] {
  const value = JSON.parse(json) as unknown;
  if (!isExactObject(value, ["task"]) || value.task === null || typeof value.task !== "object" ||
      Array.isArray(value.task) || (value.task as Record<string, unknown>).id !== expectedEntityId) {
    throw new Error("The stored Openza fields update payload is invalid.");
  }
  if (isExactObject(value.task, ["id", "title"]) && typeof value.task.title === "string") {
    return value as TaskTitleUpdatedChange["payload"];
  }
  if (isExactObject(value.task, ["id", "workflowStatus"]) &&
      isWorkflowStatus(value.task.workflowStatus)) {
    return value as TaskWorkflowStatusUpdatedChange["payload"];
  }
  if (isExactObject(value.task, ["id", "priority"]) && isPriority(value.task.priority)) {
    return value as TaskPriorityUpdatedChange["payload"];
  }
  if (isExactObject(value.task, ["id", "plannedOn"]) &&
      (value.task.plannedOn === null || isDate(value.task.plannedOn))) {
    return value as TaskPlannedOnUpdatedChange["payload"];
  }
  if (isExactObject(value.task, ["id", "plannedAt"]) &&
      (value.task.plannedAt === null || isTimestamp(value.task.plannedAt))) {
    return value as TaskPlannedAtUpdatedChange["payload"];
  }
  if (isExactObject(value.task, ["id", "notes"]) &&
      (value.task.notes === null || typeof value.task.notes === "string")) {
    return value as TaskNotesUpdatedChange["payload"];
  }
  if (isExactObject(value.task, ["id", "deadlineOn"]) &&
      (value.task.deadlineOn === null || isDate(value.task.deadlineOn))) {
    return value as TaskDeadlineOnUpdatedChange["payload"];
  }
  if (isExactObject(value.task, ["id", "source"]) && value.task.source !== null &&
      typeof value.task.source === "object" && !Array.isArray(value.task.source)) {
    return value as TaskSourceRefreshedChange["payload"];
  }
  if (isExactObject(value.task, ["externalCommand", "id"]) &&
      (isExactObject(value.task.externalCommand, ["command", "errorCode", "state"]) ||
       (isExactObject(value.task.externalCommand, ["command", "errorCode", "requestedChangeSeq", "state"]) &&
        Number.isSafeInteger(value.task.externalCommand.requestedChangeSeq) && (value.task.externalCommand.requestedChangeSeq as number)>0)) &&
      (value.task.externalCommand.command === "complete" || value.task.externalCommand.command === "reopen") &&
      (value.task.externalCommand.state === "confirmed" || value.task.externalCommand.state === "rejected" ||
       (value.task.externalCommand.state === "pending_desktop" && "requestedChangeSeq" in value.task.externalCommand)) &&
      (value.task.externalCommand.errorCode === null || typeof value.task.externalCommand.errorCode === "string")) {
    return value as TaskExternalCommandChanged["payload"];
  }
  throw new Error("The stored Openza fields update payload is invalid.");
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isPriority(value: unknown): value is TaskPriorityUpdatedChange["payload"]["task"]["priority"] {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function isWorkflowStatus(value: unknown): value is TaskWorkflowStatusUpdatedChange["payload"]["task"]["workflowStatus"] {
  return value === "none" || value === "inbox" || value === "next" || value === "waiting" || value === "someday";
}

function isExactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
