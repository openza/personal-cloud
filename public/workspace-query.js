// '*' cannot be a protocol entity id. It is a view scope, never a mutation target.
export const ALL_SPACES = "*";

export function resolveSpace(spaces, selected) {
  if (selected === ALL_SPACES || spaces.some(space => space.id === selected)) return selected;
  return spaces.find(space => space.id === "space_default")?.id || spaces[0]?.id || ALL_SPACES;
}

export function creationSpace(spaces, selected) {
  return spaces.find(space => space.id === selected)?.id ||
    spaces.find(space => space.id === "space_default")?.id || spaces[0]?.id || "";
}
export function visibleProjects(payload,spaceId,status='active',search='') {
  const query=search.trim().toLocaleLowerCase();
  return (payload.allProjects||payload.projects).filter(project=>!project.deletedAt&&payload.spaces.some(space=>space.id===project.spaceId)&&(spaceId===ALL_SPACES||project.spaceId===spaceId)&&(status==='all'||project.status===status)&&[project.name,project.description].some(value=>value?.toLocaleLowerCase().includes(query)));
}

export function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function moment(value, exact = false) {
  if (!value) return null;
  const date = new Date(exact ? value : `${value}T00:00:00`);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function taskDates(task) {
  return [moment(task.plannedAt || task.plannedOn, Boolean(task.plannedAt)), moment(task.deadlineAt || task.deadlineOn,Boolean(task.deadlineAt)),moment(task.scheduledStart,true)].filter(Boolean);
}

export function earliestDate(task) {
  const dates = taskDates(task);
  return dates.length ? new Date(Math.min(...dates.map(date => date.valueOf()))) : null;
}

// Date-only editing follows Desktop's date picker. Keep an exact plan intact
// when its displayed local day was not edited, including seconds and offset.
export function plannedEdit(task, date) {
  const displayed = task.plannedOn || (task.plannedAt ? localDate(new Date(task.plannedAt)) : "");
  return date === displayed ? null : ["plannedOn", date || null];
}

export function matchesView(task, view, today = localDate(new Date())) {
  const open = task.completionState === "open";
  if (view === "completed") return !open;
  if (!open) return false;
  if (view === "inbox") return task.workflowStatus === "inbox" && !task.projectId;
  if (view === "next" || view === "waiting" || view === "someday") return task.workflowStatus === view;
  const dates = taskDates(task).map(localDate);
  if (view === "today") return dates.includes(today);
  if (view === "calendar") return dates.length > 0;
  if (view === "overdue") return dates.some(date => date < today);
  return true;
}

export function matchesSearch(task, search) {
  return [task.title, task.notes, task.source?.description].some(value => value?.toLocaleLowerCase().includes(search));
}

export function queryTasks(payload, options) {
  const { spaceId, projectId, view, search = "", status = "", priority = "", label = "", source = "", repeat = "" } = options;
  const scoped = payload.tasks.filter(task => spaceId === ALL_SPACES || task.spaceId === spaceId);
  const byId = new Map(scoped.map(task => [task.id, task]));
  const roots = new Map();
  for (const task of scoped) {
    const repeating = Boolean((task.recurrenceRule||task.source?.recurrenceRule)?.trim());
    if (!matchesView(task, view) || (projectId && task.projectId !== projectId) ||
        (search && !matchesSearch(task, search)) || (status && task.workflowStatus !== status) ||
        (priority && String(task.priority) !== priority) ||
        (label && !task.labels.some(item => item.id === label)) ||
        (source && (source === "openza" ? Boolean(task.source) : task.source?.integrationKind !== source)) ||
        (repeat === "only" && !repeating) || (repeat === "exclude" && repeating)) continue;
    let root = task;
    const seen = new Set([root.id]);
    while (root.parentId && byId.has(root.parentId) && !seen.has(root.parentId)) {
      root = byId.get(root.parentId); seen.add(root.id);
    }
    roots.set(root.id, root);
  }
  return [...roots.values()];
}

export function searchWorkspace(payload, search, spaceId, includeCompleted = false) {
  const query = search.trim().toLocaleLowerCase();
  const tokens = [...new Set(query.split(/\s+/).filter(Boolean))];
  if (!tokens.length) return [];
  const results = [];
  const score = (title, bodies) => {
    const name = title.toLocaleLowerCase(), body = bodies.filter(Boolean).join(" ").toLocaleLowerCase();
    if (!tokens.every(token => name.includes(token) || body.includes(token))) return null;
    if (name === query) return 1000;
    if (name.startsWith(query)) return 900;
    if (name.includes(query)) return 800;
    if (tokens.some(token => name.startsWith(token))) return 700;
    if (tokens.some(token => name.includes(token))) return 600;
    return 300;
  };
  for (const task of payload.tasks) {
    if ((spaceId !== ALL_SPACES && task.spaceId !== spaceId) || (!includeCompleted && task.completionState !== "open")) continue;
    const rank = score(task.title, [task.notes, task.source?.description]);
    if (rank !== null) results.push({ kind: "task", item: task, score: rank, title: task.title });
  }
  for (const project of payload.projects) {
    if (spaceId !== ALL_SPACES && project.spaceId !== spaceId) continue;
    if(project.status==="archived"||project.deletedAt||payload.spaces?.find(s=>s.id===project.spaceId)?.isArchived)continue;
    const rank = score(project.name, [project.description]);
    if (rank !== null) results.push({ kind: "project", item: project, score: rank, title: project.name });
  }
  return results.sort((a,b)=>b.score-a.score||(a.kind===b.kind?0:a.kind==="task"?-1:1)||a.title.localeCompare(b.title)).slice(0,25);
}

export function taskComparator(mode, direction = "default") {
  const sign = direction === "reverse" ? -1 : 1;
  const title = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  const created = (a, b) => b.createdAt.localeCompare(a.createdAt);
  const date = (a, b) => {
    const left = earliestDate(a), right = earliestDate(b);
    if (!left || !right) return left ? -1 : right ? 1 : 0;
    return sign * (left - right);
  };
  return (a, b) => {
    if (mode === "title") return sign * title(a, b);
    if (mode === "created") return sign * created(a, b);
    if (mode === "date") return date(a, b) || created(a, b);
    if (mode === "project") {const left=a.projectId||"",right=b.projectId||"";return sign*(left<right?-1:left>right?1:0)||a.priority-b.priority||title(a,b);}
    return Number(a.completionState === "completed") - Number(b.completionState === "completed") ||
      sign * (a.priority - b.priority) || date(a, b) || created(a, b);
  };
}

export function groupTasks(tasks, mode, projects = []) {
  if (mode === "none") return [["", tasks, ""]];
  const groups = new Map();
  const dateGroup = (date, prefix, reverse=false) => date ? {key:prefix+":"+localDate(date),name:localDate(date),sort:(reverse?-1:1)*date.valueOf()} : {key:prefix+":none",name:prefix==="completed"?"No completed date":"No date",sort:Infinity};
  for (const task of tasks) {
    let assignments;
    if (mode === "date") assignments = [dateGroup(taskDates(task)[0], "date")];
    else if (mode === "project") {const project=projects.find(project=>project.id===task.projectId);assignments=[{key:"project:"+(task.projectId||"none"),name:project?.name||"No project"}];}
    else if (mode === "status") {const completed=task.completionState==="completed",status=completed?"completed":task.workflowStatus;assignments=[{key:"status:"+status,name:({none:"None",inbox:"Inbox",next:"Next",waiting:"Waiting For",someday:"Someday",completed:"Completed"})[status],sort:({none:0,inbox:1,next:2,waiting:3,someday:4,completed:8})[status]}];}
    else if (mode === "priority") assignments = [{key:"priority:"+task.priority,name:({1:"Urgent",2:"High",3:"Normal",4:"Low"})[task.priority],sort:task.priority}];
    else if (mode === "label") assignments = task.labels.length ? task.labels.map(label=>({key:"label:"+label.id,name:label.name,sort:0})) : [{key:"label:none",name:"No label",sort:1}];
    else if (mode === "repeat") {const repeating=Boolean(task.recurrenceRule?.trim()||task.source?.recurrenceRule?.trim());assignments=[{key:"repeat:"+repeating,name:repeating?"Repeating":"One-time",sort:Number(repeating)}];}
    else if (mode === "created" || mode === "completed") assignments = [dateGroup(moment(mode==="created"?task.createdAt:task.completedAt,true),mode,true)];
    else assignments = [{key:"source:"+(task.source?.integrationKind||"openza"),name:task.source?.integrationKind||"Openza"}];
    for (const assignment of assignments) {
      if (!groups.has(assignment.key)) groups.set(assignment.key,{...assignment,tasks:[]});
      groups.get(assignment.key).tasks.push(task);
    }
  }
  return [...groups.values()].sort((a,b)=>((a.sort??0)-(b.sort??0))||a.name.localeCompare(b.name)).map(group=>[group.name,group.tasks,group.key]);
}

export function projectComparator(mode,direction="default",favorites=true,counts=new Map()){const sign=direction==="reverse"?-1:1;return(a,b)=>{const favorite=favorites?Number(Boolean(b.isFavorite))-Number(Boolean(a.isFavorite)):0;if(favorite)return favorite;if(mode==="updated"&&Boolean(a.updatedAt)!==Boolean(b.updatedAt))return a.updatedAt?-1:1;const rank=mode==="created"?(a.createdAt||"").localeCompare(b.createdAt||""):mode==="updated"?(a.updatedAt||"").localeCompare(b.updatedAt||""):mode==="count"?(counts.get(a.id)||0)-(counts.get(b.id)||0):mode==="default"?(a.sortOrder||0)-(b.sortOrder||0):a.name.localeCompare(b.name,undefined,{sensitivity:"base"});return (mode==="default"?rank:sign*rank)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id);};}
