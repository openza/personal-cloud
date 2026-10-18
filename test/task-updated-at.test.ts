import { env, exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { parseTaskCreateMutation, parseTaskUpdateTitleMutation } from '../src/protocol.ts';
import { applyTaskCreate } from '../src/task-create.ts';
import { applyTaskTitleUpdate } from '../src/task-title-update.ts';
import { readTasks } from '../src/task-read.ts';
import create from './fixtures/valid-task-create.json?raw';
import update from './fixtures/valid-task-title-update.json?raw';

it('retains the accepted Updated time through exact mutation replay',async()=>{
  await applyTaskCreate(env.DB,parseTaskCreateMutation(create,env.INSTANCE_ID),create,{now:()=>new Date('2026-09-13T06:30:01.000Z')});
  expect((await readTasks(env.DB,env.INSTANCE_ID)).tasks[0].updatedAt).toBe('2026-09-13T06:30:01.000Z');
  const parsed=parseTaskUpdateTitleMutation(update,env.INSTANCE_ID);
  await applyTaskTitleUpdate(env.DB,parsed,update,{now:()=>new Date('2026-09-13T07:00:00.000Z')});
  await applyTaskTitleUpdate(env.DB,parsed,update,{now:()=>new Date('2026-09-14T07:00:00.000Z')});
  const task=(await readTasks(env.DB,env.INSTANCE_ID)).tasks[0];
  expect(task.updatedAt).toBe('2026-09-13T07:00:00.000Z');
  expect(task.createdAt).not.toBe(task.updatedAt);
  const patch = {protocolVersion:1,product:'tasks',instanceId:env.INSTANCE_ID,deviceId:'updated-fixture',deviceSequence:1,
    mutationId:'updated-fixture-patch',operation:'task.patch',entityId:task.id,baseEntityVersion:2,
    payload:{fields:{notes:'Changed in Web'}},clientCreatedAt:'2026-10-17T00:00:00.000Z'};
  const response=await exports.default.fetch('https://personal-cloud.local/v1/tasks/mutations',{method:'POST',body:JSON.stringify(patch)});
  expect(response.status).toBe(201);
  const receipt=await response.json() as {serverAcceptedAt:string};
  expect((await readTasks(env.DB,env.INSTANCE_ID)).tasks[0].updatedAt).toBe(receipt.serverAcceptedAt);
});
