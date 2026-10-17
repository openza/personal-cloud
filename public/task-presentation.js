export function taskSortCopy(mode,direction,label) {
  if(mode==='created')return {defaultLabel:'Newest first',reverseLabel:'Oldest first',summary:`Sort: ${direction==='reverse'?'Oldest':'Newest'} first`};
  return {defaultLabel:'Ascending',reverseLabel:'Descending',summary:`Sort: ${label} ${direction==='reverse'?'Desc':'Asc'}`};
}
export function taskTextError(title,notes='') {if(!title.trim())return 'Enter a task title.';if(new TextEncoder().encode(title.trim()).length>512)return 'Title is too long. Shorten it and try again.';if(new TextEncoder().encode(notes.trim()).length>4096)return 'Notes are too long. Shorten them and try again.';return null;}
export function uniqueLabelNames(value){const names=[];for(const name of value.split(',').map(item=>item.trim()).filter(Boolean))if(!names.some(item=>item.localeCompare(name,undefined,{sensitivity:'accent'})===0))names.push(name);return names;}
export function taskCopyText(field,{task,draft,projectName,formatTime,statusLabel,priorityLabel}) {
  const date=(on,at)=>at?formatTime(at):on||'None',source=task.source;
  if(field==='title')return draft.title.trim();
  if(field==='notes')return draft.notes.trim();
  if(field==='source')return source?[source.integrationKind,`Title: ${source.title}`,`Project: ${source.projectName||'None'}`,`Date: ${date(source.plannedOn,source.plannedAt)}`,`Deadline: ${date(source.deadlineOn,source.deadlineAt)}`,`Priority: ${source.priority==null?'None':priorityLabel(source.priority)}`,`Created: ${formatTime(task.createdAt)}`,`Recurring: ${source.recurrenceRule||'None'}`,...(source.sourceUrl?[`URL: ${source.sourceUrl}`]:[])].join('\n'):'';
  if(field==='metadata')return [`Created: ${formatTime(task.createdAt)}`,'Modified: Not reported by Personal Cloud',`Status: ${statusLabel(draft.workflowStatus)}`,`Project: ${projectName||'None'}`,`Date: ${draft.plannedOn||'None'}`,`Deadline: ${draft.deadlineOn||'None'}`,`Priority: ${priorityLabel(Number(draft.priority))}`,`Labels: ${task.labels.map(label=>label.name).join(', ')||'No labels'}`,`Source: ${source?.integrationKind||'Openza Tasks'}`].join('\n');
  return '';
}
