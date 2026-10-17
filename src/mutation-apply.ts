import {workspaceOperations,type WorkspaceMutation} from "./workspace-protocol.ts";
import {applyWorkspaceMutation} from "./workspace-mutations.ts";
import type { TaskMutation, TaskRelationshipMutation } from "./protocol.ts";
import { applyTaskCreate } from "./task-create.ts";
import { applyTaskOpenzaFieldsUpdate } from "./task-title-update.ts";
import { applyTaskComplete } from "./task-complete.ts";
import { applyTaskReopen } from "./task-reopen.ts";
import { applyTaskDelete } from "./task-delete.ts";
import { applyTaskRelationship } from "./task-relationships.ts";
import { applyExternalCommandResult, applySourceRefresh } from "./source-lifecycle.ts";

export function mutationCapability(mutation: TaskMutation): "desktop_sync" | "provider_bridge" {
  return mutation.operation.startsWith("provider.") && mutation.operation!=="provider.intent.request" || (mutation.operation==="task.createRich"&&Boolean(mutation.payload.source)) || (mutation.operation==="task.create"&&Boolean(mutation.payload.source)) || mutation.operation === "source.refreshSnapshot" || mutation.operation.startsWith("externalCommand.")
    ? "provider_bridge" : "desktop_sync";
}

// Single and sequential batch endpoints share the exact existing handlers.
export async function applyMutation(db: D1Database, mutation: TaskMutation, raw: string) {
  if(workspaceOperations.includes(mutation.operation as any)) return applyWorkspaceMutation(db,mutation as WorkspaceMutation,raw);
  if (mutation.operation === "task.create") return applyTaskCreate(db, mutation, raw);
  if (mutation.operation === "task.complete") return applyTaskComplete(db, mutation, raw);
  if (mutation.operation === "task.reopen") return applyTaskReopen(db, mutation, raw);
  if (mutation.operation === "task.delete") return applyTaskDelete(db, mutation, raw);
  if (mutation.operation === "task.updateOpenzaFields") return applyTaskOpenzaFieldsUpdate(db, mutation, raw);
  if (mutation.operation === "source.refreshSnapshot") return applySourceRefresh(db, mutation, raw);
  if (mutation.operation === "externalCommand.confirm" || mutation.operation === "externalCommand.reject")
    return applyExternalCommandResult(db, mutation, raw);
  return applyTaskRelationship(db, mutation as TaskRelationshipMutation, raw);
}
