export function taskSortCopy(mode,direction,label) {
  if(mode==='created')return {defaultLabel:'Newest first',reverseLabel:'Oldest first',summary:`Sort: ${direction==='reverse'?'Oldest':'Newest'} first`};
  return {defaultLabel:'Ascending',reverseLabel:'Descending',summary:`Sort: ${label} ${direction==='reverse'?'Desc':'Asc'}`};
}
export function taskTextError(title,notes='') {if(!title.trim())return 'Enter a task title.';if(new TextEncoder().encode(title.trim()).length>512)return 'Title is too long. Shorten it and try again.';if(new TextEncoder().encode(notes.trim()).length>4096)return 'Notes are too long. Shorten them and try again.';return null;}
export function uniqueLabelNames(value){const names=[];for(const name of value.split(',').map(item=>item.trim()).filter(Boolean))if(!names.some(item=>item.localeCompare(name,undefined,{sensitivity:'accent'})===0))names.push(name);return names;}
export function formatTaskDate(value, now = new Date()) {
  if (!value) return "";
  // Parse a date-only value locally, so it cannot shift to the previous day in the Americas.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + "T12:00:00") : new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const day = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  if (day(date) === day(now)) return "Today";
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate()+1);
  if (day(date) === day(tomorrow)) return "Tomorrow";
  const parts = new Intl.DateTimeFormat(undefined, {weekday:"short", day:"numeric",month:"short"}).formatToParts(date);
  const part = type => parts.find(value=>value.type===type)?.value;
  return `${part("weekday")}, ${part("day")} ${part("month")}${date.getFullYear()!==now.getFullYear()?` ${date.getFullYear()}`:""}`;
}
export function taskRowPresentation(task, { view, projectId, projects = [], children = [], now } = {}) {
  const metadata = [];
  if (task.projectId && task.projectId !== projectId) metadata.push(projects.find(project => project.id === task.projectId)?.name || "Project");
  if (task.plannedOn || task.plannedAt) metadata.push(formatTaskDate(task.plannedOn || task.plannedAt, now));
  if (task.deadlineOn || task.deadlineAt) metadata.push(`Due ${formatTaskDate(task.deadlineOn || task.deadlineAt, now)}`);
  if (task.source) metadata.push(task.source.integrationKind);
  if (task.labels?.length) metadata.push([...task.labels].sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})).slice(0, 2).map(label => `@${label.name}`).join(", ") + (task.labels.length > 2 ? ` +${task.labels.length - 2}` : ""));
  if (children.length) metadata.push(`${children.filter(child => child.completionState === "completed").length}/${children.length} subtasks`);
  const status = task.completionState !== "completed" && task.workflowStatus !== "none" && task.workflowStatus !== view
    ? ({ inbox: "Inbox", next: "Next", waiting: "Waiting", someday: "Someday" })[task.workflowStatus] : "";
  const priority = ({ 1: "Urgent", 2: "High" })[task.priority] || "";
  return { metadata: metadata.filter(Boolean).join(" · "), status, priority };
}
export function formatTaskGroupDate(value, now = new Date()) {
  const date = new Date(value), relative = formatTaskDate(value, now);
  return relative === "Today" || relative === "Tomorrow" ? relative
    : new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",year:"numeric"}).format(date);
}
export function taskSaveError(error) {
  return error.code === "version_conflict"
    ? "This task changed on another device. Your draft is still here. Copy it before loading the latest task, then review and reapply your changes."
    : error.message || "This change could not be confirmed. Your draft is still here; retry when Personal Cloud reconnects.";
}
export function taskCopyText(field,{task,draft,projectName,formatTime,statusLabel,priorityLabel}) {
  const date=(on,at)=>at?formatTime(at):on||'None',source=task.source;
  if(field==='title')return draft.title.trim();
  if(field==='notes')return draft.notes.trim();
  if(field==='source')return source?[source.integrationKind,`Title: ${source.title}`,`Project: ${source.projectName||'None'}`,`Date: ${date(source.plannedOn,source.plannedAt)}`,`Deadline: ${date(source.deadlineOn,source.deadlineAt)}`,`Priority: ${source.priority==null?'None':priorityLabel(source.priority)}`,`Created: ${formatTime(task.createdAt)}`,`Recurring: ${source.recurrenceRule||'None'}`,...(source.sourceUrl?[`URL: ${source.sourceUrl}`]:[])].join('\n'):'';
  if(field==='metadata')return [`Created: ${formatTime(task.createdAt)}`,`Modified: ${task.updatedAt?formatTime(task.updatedAt):'Not reported by Personal Cloud'}`,`Status: ${statusLabel(draft.workflowStatus)}`,`Project: ${projectName||'None'}`,`Date: ${draft.plannedOn||'None'}`,`Deadline: ${draft.deadlineOn||'None'}`,`Priority: ${priorityLabel(Number(draft.priority))}`,`Labels: ${task.labels.map(label=>label.name).join(', ')||'No labels'}`,`Source: ${source?.integrationKind||'Openza Tasks'}`].join('\n');
  return '';
}
