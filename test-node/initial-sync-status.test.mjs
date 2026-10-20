import { test } from "node:test";
import assert from "node:assert/strict";
import { initialStatusCopy, unavailableStatusCopy, createInitialStatusMonitor, initialEmptyState } from "../public/initial-sync-status.js";
const device = { displayName: "Synthetic desktop", state: "uploading", acknowledged: 3, total: 9 };

test("partial uploading reassures that metadata follows tasks and counts changes without percent", () => {
  const copy = initialStatusCopy({ protocolVersion: 1, state: "uploading", devices: [device] });
  assert.match(copy.detail, /Spaces, projects, and labels/);
  assert.match(copy.detail, /keep using tasks/);
  assert.match(copy.devices[0], /3 of 9 initial changes/);
  assert.match(copy.devices[0], /uploaded/);
  assert.deepEqual(copy.progress[0], {label:"Synthetic desktop initial changes uploaded",uploading:true,value:3,total:9});
  assert.doesNotMatch(JSON.stringify(copy), /%/);
});
test("unknown, stale, blocked and complete have distinct safe guidance", () => {
  for (const state of ["unknown", "blocked", "interrupted", "complete"]) {
    const copy = initialStatusCopy({ protocolVersion: 1, state, devices: [{ ...device, state }] });
    assert.ok(copy.title); assert.match(copy.detail, /Desktop|desktop/);
  }
  assert.match(initialStatusCopy({ protocolVersion: 1, state: "interrupted", devices: [] }).detail, /does not confirm completion/);
  const copy = initialStatusCopy({ protocolVersion: 1, state: "unknown", devices: [{ ...device, state: "unknown", acknowledged: null, total: null }] });
  assert.doesNotMatch(copy.devices[0], /uploaded/);
  assert.match(unavailableStatusCopy().detail, /may not support/);
});
test("empty views follow active upload state and unknown counts are indeterminate",()=>{
  assert.equal(initialEmptyState("uploading").title,"Your tasks are arriving");
  assert.equal(initialEmptyState("uploading",true).title,"No matching tasks yet");
  assert.match(initialEmptyState("blocked").detail,/Retry sync/);
  assert.match(initialEmptyState("interrupted").detail,/Retry sync/);
  assert.equal(initialEmptyState("complete").title,"Nothing here");
  assert.equal(initialEmptyState("unknown").title,"Nothing here");
  assert.match(initialEmptyState("unavailable").detail,/has not been confirmed/);
  const copy=initialStatusCopy({protocolVersion:1,state:"uploading",devices:[{...device,acknowledged:null,total:null}]});
  assert.equal(copy.progress[0].total,null);assert.equal(copy.progress[0].uploading,true);
});
test("invalid protocol never claims success and raw error codes are not displayed", () => {
  assert.deepEqual(initialStatusCopy({protocolVersion:2,state:"complete",devices:[]}), unavailableStatusCopy());
  assert.doesNotMatch(initialStatusCopy({protocolVersion:1,state:"blocked",devices:[{...device,errorCode:"private exception"}]}).devices[0], /private exception/);
});

function fixture(read) {
  const renders=[], timers=new Map();let sequence=0;
  const monitor=createInitialStatusMonitor({read,render:copy=>renders.push(copy),schedule:(fn,ms)=>{timers.set(++sequence,{fn,ms});return sequence;},cancel:id=>timers.delete(id)});
  return {monitor,renders,timers};
}
test("status starts independently, retries API failure and refreshes after resume", async () => {
  let fail=true;
  const f=fixture(async()=>{if(fail)throw Object.assign(new Error(),{status:500});return {protocolVersion:1,state:"complete",devices:[]};});
  f.monitor.start();await f.monitor.refresh();
  assert.match(f.renders.at(-1).title, /could not be checked/);
  assert.equal([...f.timers.values()].find(t=>t.ms===30_000)?.ms,30_000);
  fail=false;const pending=f.monitor.refresh({resuming:true});
  assert.match(f.renders.at(-1).title,/Checking latest/);await pending;
  assert.match(f.renders.at(-1).title,/complete/);f.monitor.stop();assert.equal(f.timers.size,0);
});
test("401/old cloud and offline reads never prevent a later telemetry retry", async () => {
  for(const status of [401,404,500]) {
    const f=fixture(()=>{throw Object.assign(new Error(),{status});});f.monitor.start();await f.monitor.refresh();
    assert.match(f.renders.at(-1).title,/could not be checked/);
    await [...f.timers.values()].find(t=>t.ms===30_000).fn();assert.equal(f.renders.length,2);f.monitor.stop();
  }
});
test("resume replaces a suspended in-flight read and discards its completion in either order", async () => {
  for (const staleFirst of [true, false]) {
    const requests=[];
    const f=fixture(signal=>new Promise(resolve=>requests.push({signal,resolve})));
    f.monitor.start();const stale=f.monitor.refresh();await Promise.resolve();
    const resumed=f.monitor.refresh({resuming:true});await Promise.resolve();
    assert.equal(requests.length,2);assert.equal(requests[0].signal.aborted,true);
    assert.equal([...f.timers.values()].filter(t=>t.ms===10_000).length,1);
    assert.equal(f.renders.at(-1).state,"checking");
    const finishStale=async()=>{requests[0].resolve({protocolVersion:1,state:"uploading",devices:[device]});await stale;};
    if(staleFirst) {
      await finishStale();assert.equal(f.renders.at(-1).state,"checking");
      assert.deepEqual([...f.timers.values()].map(t=>t.ms),[10_000]);
    }
    const joined=f.monitor.refresh();await Promise.resolve();assert.equal(requests.length,2);
    requests[1].resolve({protocolVersion:1,state:"complete",devices:[]});await resumed;await joined;
    const timers=[...f.timers.keys()];
    if(!staleFirst)await finishStale();
    assert.deepEqual(f.renders.map(copy=>copy.state),["checking","complete"]);
    assert.deepEqual([...f.timers.keys()],timers);
    assert.deepEqual([...f.timers.values()].map(t=>t.ms),[300_000]);
    f.monitor.stop();assert.equal(f.timers.size,0);
  }
});
test("completed status backs off, but resume/manual check immediately discovers an active upload",async()=>{
 let state='complete',reads=0;const f=fixture(async()=>{reads++;return{protocolVersion:1,state,devices:[]};});
 f.monitor.start();await f.monitor.refresh();assert.deepEqual([...f.timers.values()].map(t=>t.ms),[300_000]);
 state='uploading';await f.monitor.refresh({resuming:true});assert.equal(reads,2);assert.equal(f.renders.at(-1).state,'uploading');
 assert.deepEqual([...f.timers.values()].map(t=>t.ms),[30_000]);f.monitor.stop();
});
test("signout discards an in-flight response and allows new session monitor", async () => {
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));f.monitor.start();
  const pending=f.monitor.refresh();await Promise.resolve();f.monitor.stop();finish({protocolVersion:1,state:"complete",devices:[]});await pending;
  assert.equal(f.renders.length,0);assert.equal(f.timers.size,0);
});
test("slow status requests receive a bounded abort deadline", async () => {
  const f=fixture(signal=>new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("timeout")))));
  f.monitor.start();const pending=f.monitor.refresh();await Promise.resolve();
  [...f.timers.values()].find(t=>t.ms===10_000).fn();await pending;
  assert.match(f.renders.at(-1).title,/could not be checked/);f.monitor.stop();
});
