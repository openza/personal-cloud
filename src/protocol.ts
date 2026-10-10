export const protocolVersion = 1;
export const tasksProduct = "tasks";
const maximumIdentifierLength = 128;
const maximumTitleUtf8Bytes = 512;
export const maximumRequestUtf8Bytes = 16 * 1024;
const identifierPattern = /^[A-Za-z0-9_.:-]+$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TaskCreateMutation = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  deviceId: string;
  mutationId: string;
  deviceSequence: number;
  operation: "task.create";
  entityId: string;
  baseEntityVersion: null;
  payload: {
    task: {
      id: string;
      spaceId: string;
      title: string;
      completionState: "open";
      workflowStatus: "inbox";
      createdAt: string;
    };
    source?: SafeSourceDescriptor;
  };
  clientCreatedAt: string;
};

export type SafeSourceDescriptor = {
  integrationKind: string;
  externalIdHash: string;
  sourceUrl: string | null;
  title: string;
  description: string | null;
  projectName: string | null;
  priority: number | null;
  plannedOn: string | null;
  plannedAt: string | null;
  deadlineOn: string | null;
  deadlineAt: string | null;
  recurrenceRule: string | null;
  refreshedAt: string;
};

export type TaskUpdateTitleMutation = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  deviceId: string;
  mutationId: string;
  deviceSequence: number;
  operation: "task.updateOpenzaFields";
  entityId: string;
  baseEntityVersion: number;
  payload: {
    title: string;
  };
  clientCreatedAt: string;
};

export type TaskUpdateWorkflowStatusMutation = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  deviceId: string;
  mutationId: string;
  deviceSequence: number;
  operation: "task.updateOpenzaFields";
  entityId: string;
  baseEntityVersion: number;
  payload: {
    workflowStatus: "none" | "inbox" | "next" | "waiting" | "someday";
  };
  clientCreatedAt: string;
};

export type TaskUpdatePriorityMutation = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  deviceId: string;
  mutationId: string;
  deviceSequence: number;
  operation: "task.updateOpenzaFields";
  entityId: string;
  baseEntityVersion: number;
  payload: {
    priority: 1 | 2 | 3 | 4;
  };
  clientCreatedAt: string;
};

export type TaskUpdatePlannedOnMutation = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  deviceId: string;
  mutationId: string;
  deviceSequence: number;
  operation: "task.updateOpenzaFields";
  entityId: string;
  baseEntityVersion: number;
  payload: { plannedOn: string | null };
  clientCreatedAt: string;
};

export type TaskUpdatePlannedAtMutation = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  deviceId: string;
  mutationId: string;
  deviceSequence: number;
  operation: "task.updateOpenzaFields";
  entityId: string;
  baseEntityVersion: number;
  payload: { plannedAt: string | null };
  clientCreatedAt: string;
};

export type TaskUpdateNotesMutation = {
  protocolVersion: 1; product: "tasks"; instanceId: string; deviceId: string;
  mutationId: string; deviceSequence: number; operation: "task.updateOpenzaFields";
  entityId: string; baseEntityVersion: number; payload: { notes: string | null }; clientCreatedAt: string;
};

export type TaskUpdateDeadlineOnMutation = {
  protocolVersion: 1; product: "tasks"; instanceId: string; deviceId: string;
  mutationId: string; deviceSequence: number; operation: "task.updateOpenzaFields";
  entityId: string; baseEntityVersion: number; payload: { deadlineOn: string | null }; clientCreatedAt: string;
};

export type TaskOpenzaFieldsMutation =
  TaskUpdateTitleMutation | TaskUpdateWorkflowStatusMutation | TaskUpdatePriorityMutation |
  TaskUpdatePlannedOnMutation | TaskUpdatePlannedAtMutation | TaskUpdateNotesMutation | TaskUpdateDeadlineOnMutation;

export type TaskCompleteMutation = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  deviceId: string;
  mutationId: string;
  deviceSequence: number;
  operation: "task.complete";
  entityId: string;
  baseEntityVersion: number;
  payload: {
    completedAt: string;
  };
  clientCreatedAt: string;
};

export type TaskReopenMutation = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  deviceId: string;
  mutationId: string;
  deviceSequence: number;
  operation: "task.reopen";
  entityId: string;
  baseEntityVersion: number;
  payload: {
    reopenedAt: string;
  };
  clientCreatedAt: string;
};

export type TaskDeleteMutation = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  deviceId: string;
  mutationId: string;
  deviceSequence: number;
  operation: "task.delete";
  entityId: string;
  baseEntityVersion: number;
  payload: { deletedAt: string };
  clientCreatedAt: string;
};

export type SourceRefreshMutation = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  deviceId: string;
  mutationId: string;
  deviceSequence: number;
  operation: "source.refreshSnapshot";
  entityId: string;
  baseEntityVersion: null;
  payload: { source: SafeSourceDescriptor };
  clientCreatedAt: string;
};

export type ExternalCommandResultMutation = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  deviceId: string;
  mutationId: string;
  deviceSequence: number;
  operation: "externalCommand.confirm" | "externalCommand.reject";
  entityId: string;
  baseEntityVersion: null;
  payload: {
    requestedChangeSeq: number;
    resolvedAt: string;
    errorCode: null | "provider_rejected" | "authentication_required" | "retry_exhausted" | "unsupported";
  };
  clientCreatedAt: string;
};

type NamedEntity = { id: string; name: string };
export type TaskRelationshipMutation = {
  protocolVersion: 1; product: "tasks"; instanceId: string; deviceId: string;
  mutationId: string; deviceSequence: number; entityId: string; baseEntityVersion: number;
  clientCreatedAt: string;
} & (
  { operation: "task.setProject"; payload: { project: NamedEntity | null } } |
  { operation: "task.move"; payload: { space: NamedEntity } } |
  { operation: "task.addLabel"; payload: { label: NamedEntity } } |
  { operation: "task.removeLabel"; payload: { labelId: string } } |
  { operation: "task.setParent"; payload: { parentId: string | null } }
);

export type TaskMutation =
  TaskCreateMutation | TaskOpenzaFieldsMutation | TaskCompleteMutation | TaskReopenMutation | TaskDeleteMutation |
  TaskRelationshipMutation | SourceRefreshMutation | ExternalCommandResultMutation;

export type CheckpointAcknowledgement = {
  protocolVersion: 1;
  product: "tasks";
  instanceId: string;
  deviceId: string;
  checkpoint: number;
};

export class ContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseTaskMutation(json: string, expectedInstanceId: string): TaskMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  if (mutation.operation === "task.create") return parseTaskCreateMutation(json, expectedInstanceId);
  if (mutation.operation === "task.updateOpenzaFields") {
    const payload = requireObject(mutation.payload, "payload");
    const keys = Object.keys(payload);
    if (keys.length === 1 && keys[0] === "title") return parseTaskUpdateTitleMutation(json, expectedInstanceId);
    if (keys.length === 1 && keys[0] === "workflowStatus") {
      return parseTaskUpdateWorkflowStatusMutation(json, expectedInstanceId);
    }
    if (keys.length === 1 && keys[0] === "priority") {
      return parseTaskUpdatePriorityMutation(json, expectedInstanceId);
    }
    if (keys.length === 1 && keys[0] === "plannedOn") {
      return parseTaskUpdatePlannedOnMutation(json, expectedInstanceId);
    }
    if (keys.length === 1 && keys[0] === "plannedAt") {
      return parseTaskUpdatePlannedAtMutation(json, expectedInstanceId);
    }
    if (keys.length === 1 && keys[0] === "notes") {
      return parseTaskUpdateNotesMutation(json, expectedInstanceId);
    }
    if (keys.length === 1 && keys[0] === "deadlineOn") {
      return parseTaskUpdateDeadlineOnMutation(json, expectedInstanceId);
    }
    fail("invalid_request", "This checkpoint accepts exactly one supported Openza field per update.");
  }
  if (mutation.operation === "task.complete") return parseTaskCompleteMutation(json, expectedInstanceId);
  if (mutation.operation === "task.reopen") return parseTaskReopenMutation(json, expectedInstanceId);
  if (mutation.operation === "task.delete") return parseTaskDeleteMutation(json, expectedInstanceId);
  if (mutation.operation === "source.refreshSnapshot") return parseSourceRefreshMutation(json, expectedInstanceId);
  if (mutation.operation === "externalCommand.confirm" || mutation.operation === "externalCommand.reject") {
    return parseExternalCommandResultMutation(json, expectedInstanceId);
  }
  if (["task.setProject", "task.move", "task.addLabel", "task.removeLabel", "task.setParent"].includes(String(mutation.operation))) {
    return parseTaskRelationshipMutation(json, expectedInstanceId);
  }
  fail("invalid_request", "This checkpoint accepts task.create or title-only task.updateOpenzaFields.");
}

function validateDesktopActorEnvelope(
  mutation: Record<string, JsonValue>,
  expectedInstanceId: string,
  operations: readonly string[],
): void {
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);
  if (mutation.protocolVersion !== protocolVersion || mutation.product !== tasksProduct ||
      !operations.includes(String(mutation.operation)) || mutation.baseEntityVersion !== null) {
    fail("invalid_request", "The desktop source mutation envelope is invalid.");
  }
  requireIdentifier(mutation.instanceId, "instanceId");
  requireIdentifier(mutation.deviceId, "deviceId");
  requireIdentifier(mutation.mutationId, "mutationId");
  requireIdentifier(mutation.entityId, "entityId");
  if (mutation.instanceId !== expectedInstanceId) fail("instance_mismatch", "The mutation targets another Personal Cloud instance.");
  if (!Number.isSafeInteger(mutation.deviceSequence) || (mutation.deviceSequence as number) <= 0) {
    fail("invalid_request", "Device sequence must be a positive integer.");
  }
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");
}

export function parseSourceRefreshMutation(json: string, expectedInstanceId: string): SourceRefreshMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  validateDesktopActorEnvelope(mutation, expectedInstanceId, ["source.refreshSnapshot"]);
  const payload = requireObject(mutation.payload, "payload");
  requireExactKeys(payload, ["source"]);
  validateSafeSourceDescriptor(payload.source);
  return value as SourceRefreshMutation;
}

export function parseExternalCommandResultMutation(
  json: string,
  expectedInstanceId: string,
): ExternalCommandResultMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  validateDesktopActorEnvelope(mutation, expectedInstanceId, ["externalCommand.confirm", "externalCommand.reject"]);
  const payload = requireObject(mutation.payload, "payload");
  requireExactKeys(payload, ["requestedChangeSeq", "resolvedAt", "errorCode"]);
  if (!Number.isSafeInteger(payload.requestedChangeSeq) || (payload.requestedChangeSeq as number) <= 0) {
    fail("invalid_request", "The external command change sequence is invalid.");
  }
  requireTimestamp(payload.resolvedAt, "payload.resolvedAt");
  const allowedErrors = ["provider_rejected", "authentication_required", "retry_exhausted", "unsupported"];
  if (mutation.operation === "externalCommand.confirm" && payload.errorCode !== null) {
    fail("invalid_request", "A confirmed external command cannot contain an error code.");
  }
  if (mutation.operation === "externalCommand.reject" &&
      (typeof payload.errorCode !== "string" || !allowedErrors.includes(payload.errorCode))) {
    fail("invalid_request", "A rejected external command requires a safe error code.");
  }
  return value as ExternalCommandResultMutation;
}

export function parseTaskRelationshipMutation(json: string, expectedInstanceId: string): TaskRelationshipMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);
  if (mutation.protocolVersion !== 1 || mutation.product !== "tasks") fail("invalid_request", "The relationship mutation envelope is invalid.");
  requireIdentifier(mutation.instanceId, "instanceId"); requireIdentifier(mutation.deviceId, "deviceId");
  requireIdentifier(mutation.mutationId, "mutationId"); requireIdentifier(mutation.entityId, "entityId");
  if (mutation.instanceId !== expectedInstanceId) fail("instance_mismatch", "The mutation targets another instance.");
  if (!Number.isSafeInteger(mutation.deviceSequence) || (mutation.deviceSequence as number) <= 0 ||
      !Number.isSafeInteger(mutation.baseEntityVersion) || (mutation.baseEntityVersion as number) <= 0) {
    fail("invalid_request", "The relationship mutation version is invalid.");
  }
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");
  const payload = requireObject(mutation.payload, "payload");
  if (mutation.operation === "task.setProject" && payload.project === null) {
    requireExactKeys(payload, ["project"]);
  } else if (mutation.operation === "task.setProject" || mutation.operation === "task.move" || mutation.operation === "task.addLabel") {
    const key = mutation.operation === "task.setProject" ? "project" : mutation.operation === "task.move" ? "space" : "label";
    requireExactKeys(payload, [key]);
    const named = requireObject(payload[key], `payload.${key}`); requireExactKeys(named, ["id", "name"]);
    requireIdentifier(named.id, `${key}.id`); requireTitle(named.name, `${key}.name`);
  } else if (mutation.operation === "task.removeLabel") {
    requireExactKeys(payload, ["labelId"]); requireIdentifier(payload.labelId, "payload.labelId");
  } else if (mutation.operation === "task.setParent") {
    requireExactKeys(payload, ["parentId"]); if (payload.parentId !== null) requireIdentifier(payload.parentId, "payload.parentId");
  } else fail("invalid_request", "The relationship operation is unsupported.");
  return value as TaskRelationshipMutation;
}

export function parseTaskDeleteMutation(json: string, expectedInstanceId: string): TaskDeleteMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);
  if (mutation.protocolVersion !== 1) fail("unsupported_protocol", "Only Personal Cloud protocol version 1 is supported.");
  if (mutation.product !== "tasks") fail("unsupported_product", "This endpoint accepts Openza Tasks mutations only.");
  requireIdentifier(mutation.instanceId, "instanceId");
  requireIdentifier(mutation.deviceId, "deviceId");
  requireIdentifier(mutation.mutationId, "mutationId");
  requireIdentifier(mutation.entityId, "entityId");
  if (mutation.instanceId !== expectedInstanceId) fail("instance_mismatch", "The mutation targets another instance.");
  if (!Number.isSafeInteger(mutation.deviceSequence) || (mutation.deviceSequence as number) <= 0 ||
      !Number.isSafeInteger(mutation.baseEntityVersion) || (mutation.baseEntityVersion as number) <= 0 ||
      mutation.operation !== "task.delete") fail("invalid_request", "The task.delete mutation is invalid.");
  const payload = requireObject(mutation.payload, "payload");
  requireExactKeys(payload, ["deletedAt"]);
  requireTimestamp(payload.deletedAt, "payload.deletedAt");
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");
  return value as TaskDeleteMutation;
}

export function parseTaskReopenMutation(json: string, expectedInstanceId: string): TaskReopenMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);
  if (mutation.protocolVersion !== protocolVersion) {
    fail("unsupported_protocol", "Only Personal Cloud protocol version 1 is supported.");
  }
  if (mutation.product !== tasksProduct) {
    fail("unsupported_product", "This endpoint accepts Openza Tasks mutations only.");
  }
  requireIdentifier(mutation.instanceId, "instanceId");
  requireIdentifier(mutation.deviceId, "deviceId");
  requireIdentifier(mutation.mutationId, "mutationId");
  requireIdentifier(mutation.entityId, "entityId");
  if (mutation.instanceId !== expectedInstanceId) {
    fail("instance_mismatch", "The mutation targets another Personal Cloud instance.");
  }
  if (!Number.isSafeInteger(mutation.deviceSequence) || (mutation.deviceSequence as number) <= 0 ||
      !Number.isSafeInteger(mutation.baseEntityVersion) || (mutation.baseEntityVersion as number) <= 0 ||
      mutation.operation !== "task.reopen") {
    fail("invalid_request", "The task.reopen mutation is invalid.");
  }
  const payload = requireObject(mutation.payload, "payload");
  requireExactKeys(payload, ["reopenedAt"]);
  requireTimestamp(payload.reopenedAt, "payload.reopenedAt");
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");
  return value as TaskReopenMutation;
}

export function parseTaskCompleteMutation(json: string, expectedInstanceId: string): TaskCompleteMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);
  if (mutation.protocolVersion !== protocolVersion) {
    fail("unsupported_protocol", "Only Personal Cloud protocol version 1 is supported.");
  }
  if (mutation.product !== tasksProduct) {
    fail("unsupported_product", "This endpoint accepts Openza Tasks mutations only.");
  }
  requireIdentifier(mutation.instanceId, "instanceId");
  requireIdentifier(mutation.deviceId, "deviceId");
  requireIdentifier(mutation.mutationId, "mutationId");
  requireIdentifier(mutation.entityId, "entityId");
  if (mutation.instanceId !== expectedInstanceId) {
    fail("instance_mismatch", "The mutation targets another Personal Cloud instance.");
  }
  if (!Number.isSafeInteger(mutation.deviceSequence) || (mutation.deviceSequence as number) <= 0 ||
      !Number.isSafeInteger(mutation.baseEntityVersion) || (mutation.baseEntityVersion as number) <= 0 ||
      mutation.operation !== "task.complete") {
    fail("invalid_request", "The task.complete mutation is invalid.");
  }
  const payload = requireObject(mutation.payload, "payload");
  requireExactKeys(payload, ["completedAt"]);
  requireTimestamp(payload.completedAt, "payload.completedAt");
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");
  return value as TaskCompleteMutation;
}

export function parseTaskCreateMutation(json: string, expectedInstanceId: string): TaskCreateMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);

  if (mutation.protocolVersion !== protocolVersion) {
    fail("unsupported_protocol", "Only Personal Cloud protocol version 1 is supported.");
  }
  if (mutation.product !== tasksProduct) {
    fail("unsupported_product", "This endpoint accepts Openza Tasks mutations only.");
  }

  requireIdentifier(mutation.instanceId, "instanceId");
  requireIdentifier(mutation.deviceId, "deviceId");
  requireIdentifier(mutation.mutationId, "mutationId");
  requireIdentifier(mutation.entityId, "entityId");
  if (mutation.instanceId !== expectedInstanceId) {
    fail("instance_mismatch", "The mutation targets another Personal Cloud instance.");
  }
  if (!Number.isSafeInteger(mutation.deviceSequence) || (mutation.deviceSequence as number) <= 0) {
    fail("invalid_request", "Device sequence must be a positive integer.");
  }
  if (mutation.operation !== "task.create" || mutation.baseEntityVersion !== null) {
    fail("invalid_request", "K2 accepts task.create without a base entity version only.");
  }

  const payload = requireObject(mutation.payload, "payload");
  const payloadKeys = Object.keys(payload).sort();
  if (!(payloadKeys.length === 1 && payloadKeys[0] === "task") &&
      !(payloadKeys.length === 2 && payloadKeys[0] === "source" && payloadKeys[1] === "task")) {
    fail("invalid_request", "Task creation accepts a task and one optional safe source descriptor only.");
  }
  const task = requireObject(payload.task, "payload.task");
  requireExactKeys(task, ["id", "spaceId", "title", "completionState", "workflowStatus", "createdAt"]);
  requireIdentifier(task.id, "payload.task.id");
  requireIdentifier(task.spaceId, "payload.task.spaceId");
  if (mutation.entityId !== task.id) {
    fail("invalid_request", "The mutation entity ID must match the task ID.");
  }
  requireTitle(task.title, "payload.task.title");
  if (task.completionState !== "open" || task.workflowStatus !== "inbox") {
    fail("invalid_request", "K2 creates open Inbox tasks only.");
  }
  requireTimestamp(task.createdAt, "payload.task.createdAt");
  if ("source" in payload) validateSafeSourceDescriptor(payload.source);
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");

  return value as TaskCreateMutation;
}

function validateSafeSourceDescriptor(value: JsonValue | undefined): void {
  const source=requireObject(value,"payload.source");
  requireExactKeys(source,["integrationKind","externalIdHash","sourceUrl","title","description","projectName","priority","plannedOn","plannedAt","deadlineOn","deadlineAt","recurrenceRule","refreshedAt"]);
  if(typeof source.integrationKind!=="string"||source.integrationKind.length<1||source.integrationKind.length>64) fail("invalid_request","The source integration kind is invalid.");
  if(typeof source.externalIdHash!=="string"||!/^[a-f0-9]{64}$/.test(source.externalIdHash)) fail("invalid_request","The source identity hash is invalid.");
  requireTitle(source.title,"payload.source.title");
  for(const key of ["sourceUrl","description","projectName","recurrenceRule"] as const) if(source[key]!==null&&typeof source[key]!=="string") fail("invalid_request",`payload.source.${key} must be text or null.`);
  if(source.priority!==null&&(!Number.isSafeInteger(source.priority)||(source.priority as number)<1||(source.priority as number)>4)) fail("invalid_request","The source priority is invalid.");
  for(const key of ["plannedOn","deadlineOn"] as const) if(source[key]!==null) requireDate(source[key],`payload.source.${key}`);
  for(const key of ["plannedAt","deadlineAt"] as const) if(source[key]!==null) requireTimestamp(source[key],`payload.source.${key}`);
  requireTimestamp(source.refreshedAt,"payload.source.refreshedAt");
}

export function parseTaskUpdateTitleMutation(json: string, expectedInstanceId: string): TaskUpdateTitleMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);

  if (mutation.protocolVersion !== protocolVersion) {
    fail("unsupported_protocol", "Only Personal Cloud protocol version 1 is supported.");
  }
  if (mutation.product !== tasksProduct) {
    fail("unsupported_product", "This endpoint accepts Openza Tasks mutations only.");
  }
  requireIdentifier(mutation.instanceId, "instanceId");
  requireIdentifier(mutation.deviceId, "deviceId");
  requireIdentifier(mutation.mutationId, "mutationId");
  requireIdentifier(mutation.entityId, "entityId");
  if (mutation.instanceId !== expectedInstanceId) {
    fail("instance_mismatch", "The mutation targets another Personal Cloud instance.");
  }
  if (!Number.isSafeInteger(mutation.deviceSequence) || (mutation.deviceSequence as number) <= 0) {
    fail("invalid_request", "Device sequence must be a positive integer.");
  }
  if (mutation.operation !== "task.updateOpenzaFields") {
    fail("invalid_request", "This checkpoint accepts title-only task.updateOpenzaFields.");
  }
  if (!Number.isSafeInteger(mutation.baseEntityVersion) || (mutation.baseEntityVersion as number) <= 0) {
    fail("invalid_request", "A title update requires a positive base entity version.");
  }
  const payload = requireObject(mutation.payload, "payload");
  requireExactKeys(payload, ["title"]);
  requireTitle(payload.title, "payload.title");
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");
  return value as TaskUpdateTitleMutation;
}

export function parseTaskUpdateWorkflowStatusMutation(
  json: string,
  expectedInstanceId: string,
): TaskUpdateWorkflowStatusMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);

  validateOpenzaFieldsEnvelope(mutation, expectedInstanceId);
  const payload = requireObject(mutation.payload, "payload");
  requireExactKeys(payload, ["workflowStatus"]);
  if (payload.workflowStatus !== "none" && payload.workflowStatus !== "inbox" &&
      payload.workflowStatus !== "next" && payload.workflowStatus !== "waiting" &&
      payload.workflowStatus !== "someday") {
    fail("invalid_request", "Workflow status is not supported by this checkpoint.");
  }
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");
  return value as TaskUpdateWorkflowStatusMutation;
}

export function parseTaskUpdatePriorityMutation(
  json: string,
  expectedInstanceId: string,
): TaskUpdatePriorityMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);

  validateOpenzaFieldsEnvelope(mutation, expectedInstanceId);
  const payload = requireObject(mutation.payload, "payload");
  requireExactKeys(payload, ["priority"]);
  if (!Number.isSafeInteger(payload.priority) || (payload.priority as number) < 1 ||
      (payload.priority as number) > 4) {
    fail("invalid_request", "Priority must be an integer from 1 through 4.");
  }
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");
  return value as TaskUpdatePriorityMutation;
}

export function parseTaskUpdatePlannedOnMutation(
  json: string,
  expectedInstanceId: string,
): TaskUpdatePlannedOnMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);
  validateOpenzaFieldsEnvelope(mutation, expectedInstanceId);
  const payload = requireObject(mutation.payload, "payload");
  requireExactKeys(payload, ["plannedOn"]);
  if (payload.plannedOn !== null) requireDate(payload.plannedOn, "payload.plannedOn");
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");
  return value as TaskUpdatePlannedOnMutation;
}

export function parseTaskUpdatePlannedAtMutation(
  json: string,
  expectedInstanceId: string,
): TaskUpdatePlannedAtMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);
  validateOpenzaFieldsEnvelope(mutation, expectedInstanceId);
  const payload = requireObject(mutation.payload, "payload");
  requireExactKeys(payload, ["plannedAt"]);
  if (payload.plannedAt !== null) requireTimestamp(payload.plannedAt, "payload.plannedAt");
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");
  return value as TaskUpdatePlannedAtMutation;
}

export function parseTaskUpdateNotesMutation(json: string, expectedInstanceId: string): TaskUpdateNotesMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);
  validateOpenzaFieldsEnvelope(mutation, expectedInstanceId);
  const payload = requireObject(mutation.payload, "payload");
  requireExactKeys(payload, ["notes"]);
  if (payload.notes !== null && typeof payload.notes !== "string") fail("invalid_request", "Task notes must be text or null.");
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");
  return value as TaskUpdateNotesMutation;
}

export function parseTaskUpdateDeadlineOnMutation(json: string, expectedInstanceId: string): TaskUpdateDeadlineOnMutation {
  const value = new StrictJsonParser(json).parse();
  const mutation = requireObject(value, "mutation");
  requireExactKeys(mutation, [
    "protocolVersion", "product", "instanceId", "deviceId", "mutationId", "deviceSequence",
    "operation", "entityId", "baseEntityVersion", "payload", "clientCreatedAt",
  ]);
  validateOpenzaFieldsEnvelope(mutation, expectedInstanceId);
  const payload = requireObject(mutation.payload, "payload");
  requireExactKeys(payload, ["deadlineOn"]);
  if (payload.deadlineOn !== null) requireDate(payload.deadlineOn, "payload.deadlineOn");
  requireTimestamp(mutation.clientCreatedAt, "clientCreatedAt");
  return value as TaskUpdateDeadlineOnMutation;
}

function validateOpenzaFieldsEnvelope(mutation: Record<string, JsonValue>, expectedInstanceId: string): void {
  if (mutation.protocolVersion !== protocolVersion) {
    fail("unsupported_protocol", "Only Personal Cloud protocol version 1 is supported.");
  }
  if (mutation.product !== tasksProduct) {
    fail("unsupported_product", "This endpoint accepts Openza Tasks mutations only.");
  }
  requireIdentifier(mutation.instanceId, "instanceId");
  requireIdentifier(mutation.deviceId, "deviceId");
  requireIdentifier(mutation.mutationId, "mutationId");
  requireIdentifier(mutation.entityId, "entityId");
  if (mutation.instanceId !== expectedInstanceId) {
    fail("instance_mismatch", "The mutation targets another Personal Cloud instance.");
  }
  if (!Number.isSafeInteger(mutation.deviceSequence) || (mutation.deviceSequence as number) <= 0) {
    fail("invalid_request", "Device sequence must be a positive integer.");
  }
  if (mutation.operation !== "task.updateOpenzaFields") {
    fail("invalid_request", "This checkpoint accepts task.updateOpenzaFields.");
  }
  if (!Number.isSafeInteger(mutation.baseEntityVersion) || (mutation.baseEntityVersion as number) <= 0) {
    fail("invalid_request", "An Openza field update requires a positive base entity version.");
  }
}

export function parseCheckpointAcknowledgement(
  json: string,
  expectedInstanceId: string,
): CheckpointAcknowledgement {
  const value = new StrictJsonParser(json).parse();
  const acknowledgement = requireObject(value, "checkpoint acknowledgement");
  requireExactKeys(acknowledgement, ["protocolVersion", "product", "instanceId", "deviceId", "checkpoint"]);
  if (acknowledgement.protocolVersion !== protocolVersion) {
    fail("unsupported_protocol", "Only Personal Cloud protocol version 1 is supported.");
  }
  if (acknowledgement.product !== tasksProduct) {
    fail("unsupported_product", "This endpoint accepts Openza Tasks checkpoints only.");
  }
  requireIdentifier(acknowledgement.instanceId, "instanceId");
  requireIdentifier(acknowledgement.deviceId, "deviceId");
  if (acknowledgement.instanceId !== expectedInstanceId) {
    fail("instance_mismatch", "The checkpoint targets another Personal Cloud instance.");
  }
  if (!Number.isSafeInteger(acknowledgement.checkpoint) || (acknowledgement.checkpoint as number) < 0) {
    fail("invalid_request", "Checkpoint must be a non-negative integer.");
  }
  return value as CheckpointAcknowledgement;
}

export function canonicalize(json: string): string {
  return canonicalizeValue(new StrictJsonParser(json).parse());
}

export async function computeCanonicalHash(json: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(json));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalizeValue(value: JsonValue): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    requireValidUnicode(value, "JSON string");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("invalid_request", "K2 accepts safe integer JSON numbers only.");
    return value.toString();
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeValue).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeValue(value[key])}`).join(",")}}`;
}

function requireObject(value: JsonValue | undefined, field: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_request", `${field} must be an object.`);
  }
  return value as Record<string, JsonValue>;
}

function requireExactKeys(value: Record<string, JsonValue>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("invalid_request", "The JSON object contains missing or unknown K2 properties.");
  }
}

function requireIdentifier(value: JsonValue, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumIdentifierLength || !identifierPattern.test(value)) {
    fail("invalid_request", `${field} is not a valid K2 identifier.`);
  }
}

function requireTimestamp(value: JsonValue, field: string): asserts value is string {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    fail("invalid_request", `${field} must be a millisecond-precision UTC timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail("invalid_request", `${field} must be a millisecond-precision UTC timestamp.`);
  }
}

function requireDate(value: JsonValue, field: string): asserts value is string {
  if (typeof value !== "string" || !datePattern.test(value)) {
    fail("invalid_request", `${field} must be an ISO calendar date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail("invalid_request", `${field} must be an ISO calendar date.`);
  }
}

function requireTitle(value: JsonValue, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("invalid_request", "Task title must not be empty.");
  }
  requireValidUnicode(value, field);
  if (new TextEncoder().encode(value).byteLength > maximumTitleUtf8Bytes) {
    fail("invalid_request", "Task title exceeds the checkpoint size limit.");
  }
}

function requireValidUnicode(value: string, field: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("invalid_request", `${field} contains invalid Unicode.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("invalid_request", `${field} contains invalid Unicode.`);
    }
  }
}

function fail(code: string, message: string): never {
  throw new ContractError(code, message);
}

export function parseStrictJson(json: string): JsonValue {
  return new StrictJsonParser(json).parse();
}

class StrictJsonParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.offset !== this.source.length) fail("invalid_request", "Unexpected content follows the JSON document.");
    return value;
  }

  private parseValue(): JsonValue {
    this.skipWhitespace();
    const character = this.source[this.offset];
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === "\"") return this.parseString();
    if (character === "t") return this.parseLiteral("true", true);
    if (character === "f") return this.parseLiteral("false", false);
    if (character === "n") return this.parseLiteral("null", null);
    return this.parseNumber();
  }

  private parseObject(): Record<string, JsonValue> {
    this.offset += 1;
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return result;
    }
    while (true) {
      this.skipWhitespace();
      if (this.source[this.offset] !== "\"") fail("invalid_request", "Object property name must be a string.");
      const key = this.parseString();
      if (keys.has(key)) fail("invalid_request", `Duplicate JSON property '${key}' is not allowed.`);
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.offset++] !== ":") fail("invalid_request", "Object property is missing ':'.");
      result[key] = this.parseValue();
      this.skipWhitespace();
      const separator = this.source[this.offset++];
      if (separator === "}") return result;
      if (separator !== ",") fail("invalid_request", "Object property is missing ','.");
    }
  }

  private parseArray(): JsonValue[] {
    this.offset += 1;
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return result;
    }
    while (true) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const separator = this.source[this.offset++];
      if (separator === "]") return result;
      if (separator !== ",") fail("invalid_request", "Array item is missing ','.");
    }
  }

  private parseString(): string {
    const start = this.offset++;
    let escaped = false;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset++];
      if (!escaped && character === "\"") {
        try {
          const value = JSON.parse(this.source.slice(start, this.offset)) as string;
          requireValidUnicode(value, "JSON string");
          return value;
        } catch (error) {
          if (error instanceof ContractError) throw error;
          fail("invalid_request", "Invalid JSON string.");
        }
      }
      if (!escaped && character.charCodeAt(0) < 0x20) fail("invalid_request", "Unescaped control character in JSON string.");
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
    }
    fail("invalid_request", "Unterminated JSON string.");
  }

  private parseNumber(): number {
    const match = this.source.slice(this.offset).match(/^-?(?:0|[1-9]\d*)/);
    if (!match) fail("invalid_request", "Invalid JSON value.");
    this.offset += match[0].length;
    if ([".", "e", "E"].includes(this.source[this.offset])) fail("invalid_request", "K2 accepts integer JSON numbers only.");
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value)) fail("invalid_request", "K2 accepts safe integer JSON numbers only.");
    return value;
  }

  private parseLiteral<T extends JsonPrimitive>(text: string, value: T): T {
    if (this.source.slice(this.offset, this.offset + text.length) !== text) fail("invalid_request", "Invalid JSON literal.");
    this.offset += text.length;
    return value;
  }

  private skipWhitespace(): void {
    while ([" ", "\t", "\n", "\r"].includes(this.source[this.offset])) this.offset += 1;
  }
}
