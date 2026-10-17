import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_SPACES, resolveSpace, creationSpace, queryTasks, matchesView, taskComparator, groupTasks, localDate, plannedEdit, searchWorkspace } from "../public/workspace-query.js";

const spaces = [{ id: "space_default", name: "Personal" }, { id: "space_other", name: "Work" }];
const task = (id, fields = {}) => ({ id, title: id, notes: null, spaceId: "space_default", parentId: null, projectId: null, completionState: "open", workflowStatus: "inbox", priority: 2, plannedOn: null, plannedAt: null, deadlineOn: null, createdAt: "2026-10-01T10:00:00Z", completedAt: null, labels: [], source: null, ...fields });

test("All Spaces survives refresh/removal; creation always chooses a real Space", () => {
  assert.equal(resolveSpace(spaces, ALL_SPACES), ALL_SPACES);
  assert.equal(resolveSpace([], ALL_SPACES), ALL_SPACES);
  assert.equal(resolveSpace(spaces, "removed"), "space_default");
  assert.equal(creationSpace(spaces, ALL_SPACES), "space_default");
  assert.equal(creationSpace(spaces, "space_other"), "space_other");
  assert.equal(creationSpace([], ALL_SPACES), "");
});

test("Space/project scope, completion and Inbox exclusions remain independent", () => {
  const payload = { tasks: [task("a"), task("b", { spaceId: "space_other" }), task("p", { projectId: "project_a" }), task("done", { completionState: "completed" })] };
  const ids = options => queryTasks(payload, { spaceId: ALL_SPACES, view: "all", ...options }).map(item => item.id);
  assert.deepEqual(ids({}), ["a", "b", "p"]);
  assert.deepEqual(ids({ spaceId: "space_other" }), ["b"]);
  assert.deepEqual(ids({ view: "inbox" }), ["a", "b"]);
  assert.deepEqual(ids({ projectId: "project_a" }), ["p"]);
  assert.deepEqual(ids({ view: "completed" }), ["done"]);
});

test("matching provider descendants retain ancestor context across list filters", () => {
  const payload = { tasks: [task("root"), task("child", { parentId: "root", title: "needle", priority: 1, workflowStatus: "next" }), task("grandchild", { parentId: "child", notes: "deep match", source: { integrationKind: "todoist", recurrenceRule: "every week" } })] };
  assert.deepEqual(queryTasks(payload, { spaceId: ALL_SPACES, view: "next", search: "needle", priority: "1" }).map(item => item.id), ["root"]);
  assert.deepEqual(queryTasks(payload, { spaceId: ALL_SPACES, view: "all", search: "deep match", repeat: "only" }).map(item => item.id), ["root"]);
});

test("repeat/source/label/status filters compose", () => {
  const payload = { tasks: [task("a"), task("b", { workflowStatus: "next", labels: [{ id: "label_a", name: "Focus" }], source: { integrationKind: "todoist", recurrenceRule: "daily" } })] };
  assert.deepEqual(queryTasks(payload, { spaceId: ALL_SPACES, view: "all", repeat: "only", source: "todoist", label: "label_a", status: "next" }).map(item => item.id), ["b"]);
  assert.deepEqual(queryTasks(payload, { spaceId: ALL_SPACES, view: "all", repeat: "exclude" }).map(item => item.id), ["a"]);
});

test("date-only dates stay local; exact times follow local day; either deadline or plan matches views", () => {
  const today = localDate(new Date("2026-10-13T00:30:00Z"));
  const item = task("a", { plannedAt: "2026-10-13T00:30:00Z", deadlineOn: "2026-10-01" });
  assert.equal(matchesView(item, "today", today), true);
  assert.equal(matchesView(item, "overdue", today), true);
  assert.equal(matchesView(task("b", { plannedOn: today }), "today", today), true);
  assert.equal(matchesView(task("done", { completionState: "completed", plannedOn: today }), "today", today), false);
});

test("date sorting takes earliest plan/deadline, compares moments, and keeps undated last in both directions", () => {
  const a = task("a", { plannedOn: "2026-12-01", deadlineOn: "2026-10-01" }), b = task("b", { plannedOn: "2026-11-01" }), none = task("none");
  assert.deepEqual([none,b,a].sort(taskComparator("date")).map(item => item.id), ["a","b","none"]);
  assert.deepEqual([none,b,a].sort(taskComparator("date","reverse")).map(item => item.id), ["b","a","none"]);
});

test("grouping uses every label and keeps same-named projects/labels separate by identity", () => {
  const a = task("a", { projectId: "project_a", labels: [{ id: "l1", name: "Focus" }, { id: "l2", name: "Review" }] });
  const b = task("b", { projectId: "project_b", labels: [{ id: "l3", name: "Focus" }] });
  const groups = groupTasks([a,b], "label");
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(group=>group[2]).sort(), ["label:l1","label:l2","label:l3"]);
  assert.equal(groupTasks([a,b], "project", [{id:"project_a",name:"Same"},{id:"project_b",name:"Same"}]).length, 2);
});

test("date groups prefer planned dates; priority and completed grouping follow Desktop ordering", () => {
  const timed = task("timed", { plannedAt: "2026-10-14T12:00:00Z", deadlineOn: "2026-10-01" });
  assert.equal(groupTasks([timed], "date")[0][0], localDate(new Date(timed.plannedAt)));
  assert.deepEqual(groupTasks([task("low",{priority:4}),task("urgent",{priority:1})],"priority").map(group=>group[0]),["Urgent","Low"]);
  assert.equal(groupTasks([task("done",{completionState:"completed",workflowStatus:"next"})],"status")[0][0],"Completed");
  assert.deepEqual(groupTasks([task("old",{completedAt:"2026-10-01T12:00:00Z"}),task("new",{completedAt:"2026-10-02T12:00:00Z"})],"completed").map(group=>group[1][0].id),["new","old"]);
});

test("unchanged exact planned dates preserve seconds/offset; date edits and clear use date-only mutation", () => {
  const item = task("a", { plannedAt: "2026-10-13T10:15:27.123+05:30" });
  assert.equal(plannedEdit(item, localDate(new Date(item.plannedAt))), null);
  assert.deepEqual(plannedEdit(item, "2026-12-01"), ["plannedOn", "2026-12-01"]);
  assert.deepEqual(plannedEdit(item, ""), ["plannedOn", null]);
});

test("global search matches all tokens across title/body, ranks exact titles, includes projects and direct children", () => {
  const payload = { projects: [{id:"project_a",name:"Needle",spaceId:"space_other"}], tasks: [task("body",{notes:"Needle"}),task("child",{parentId:"body",title:"Needle",spaceId:"space_other"}),task("done",{title:"Needle finished",completionState:"completed"}),task("tokens",{title:"First",notes:"Second"})] };
  assert.deepEqual(searchWorkspace(payload,"needle",ALL_SPACES).map(result=>result.item.id),["child","project_a","body"]);
  assert.deepEqual(searchWorkspace(payload,"needle","space_default",true).map(result=>result.item.id),["done","body"]);
  assert.deepEqual(searchWorkspace(payload,"first second",ALL_SPACES).map(result=>result.item.id),["tokens"]);
  assert.deepEqual(searchWorkspace(payload,"  ",ALL_SPACES),[]);
});

test("global search is bounded to Desktop's 25 best results", () => {
  const payload = {projects:[],tasks:Array.from({length:40},(_,i)=>task(`task_${i}`,{title:`Match ${i}`}))};
  assert.equal(searchWorkspace(payload,"match",ALL_SPACES).length,25);
});

test('local recurrence and exact deadlines/scheduled start participate in Desktop query groups',()=>{
 const scheduled=task('scheduled',{scheduledStart:'2026-10-13T12:00:00Z',deadlineAt:'2026-10-01T12:00:00Z',recurrenceRule:'daily'});
 assert.equal(matchesView(scheduled,'today',localDate(new Date(scheduled.scheduledStart))),true);
 assert.equal(matchesView(scheduled,'overdue','2026-10-13'),true);
 assert.deepEqual(queryTasks({tasks:[scheduled]},{spaceId:ALL_SPACES,view:'all',repeat:'only'}).map(t=>t.id),['scheduled']);
 assert.equal(groupTasks([scheduled],'repeat')[0][0],'Repeating');
});
