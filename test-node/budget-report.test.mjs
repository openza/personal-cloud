import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
test('derived FIFO day report retains the original prefix and includes edit-triggered reads',async()=>{
 await mkdir('artifacts',{recursive:true});const dir=await mkdtemp('artifacts/budget-report-unit-');
 try{
  const totals={first_upload:{requests:1,envelopes:1,rowsRead:3,rowsWritten:10},
   existing_backlog:{requests:1801,envelopes:1801,rowsRead:1801,rowsWritten:36020},
   source_heartbeat_cycle:{requests:1,envelopes:1,rowsRead:2,rowsWritten:10},
   normal_edits_100:{requests:100,envelopes:100,rowsRead:100,rowsWritten:2000},
   browser_refresh:{requests:2,rowsRead:5,rowsWritten:0},initial_status_poll:{requests:1,rowsRead:1,rowsWritten:0},session_rotation:{requests:1,rowsRead:1,rowsWritten:4}};
  await writeFile(dir+'/input.json',JSON.stringify({syntheticOnly:true,population:{providerSourceItems:2},sourceCase:1,pendingCase:1801,totals,dispatches:[{scenario:'first_upload',operation:'task.create',credits:50,requests:1,rowsRead:3,rowsWritten:10}]}));
  await writeFile(dir+'/idle.json',JSON.stringify({syntheticOnly:true,population:{providerSourceItems:2},sourceCase:1,dailyIdle:{requests:3888,rowsRead:10000,rowsWritten:3456},totals:{owner_note_adopted:{requests:1,rowsRead:3,rowsWritten:22},owner_note_native:{requests:1,rowsRead:2,rowsWritten:20},catalog_content_change_adopted:{requests:1,rowsRead:4,rowsWritten:10},catalog_content_change_unadopted:{requests:1,rowsRead:3,rowsWritten:10},catalog_full_cycle_pull_ack:{requests:2,rowsRead:4,rowsWritten:4}}}));
  const command=spawnSync(process.execPath,['scripts/report-budget.mjs',dir+'/input.json',dir+'/output.json',dir+'/idle.json'],{encoding:'utf8'});
  assert.equal(command.status,0,command.stderr);const report=JSON.parse(await readFile(dir+'/output.json','utf8'));
  const backlog=report.scenarios[0];assert.equal(backlog.originalDrainedDay,2);assert.equal(backlog.daysToNoBacklog,2);
  assert.equal(backlog.days[0].originalPending,1);assert.equal(backlog.days[0].envelopes,1800);assert.equal(backlog.maxWaitDays,1);
  assert.equal(report.allModelledDaysBelowHalf,true);
  const working=report.browserCases.find(c=>c.hours===24&&c.editHours===6&&c.editOrigin==='web');assert.equal(working.snapshotReads,317);
  assert.equal(working.immediateRefreshes,100);assert.equal(working.rowsWritten,976);
  assert.equal(report.scenarios[1].days[0].rowsWritten,10+40+2000+576+3456);
  const web=report.scenarios.find(s=>s.name==='fresh_seed'&&s.editOrigin==='web'&&s.catalogChangesPerDay===0);
  assert.equal(web.days[0].webWriteCredits,2500);assert.equal(web.days[0].writeCredits,50+64);
  assert.equal(web.days[0].rowsWritten,10+40+2200+976+3456);assert.equal(web.days[0].webEnvelopes,100);
  const normal=report.scenarios.find(s=>s.name==='normal_day'&&s.editOrigin==='web'&&s.catalogChangesPerDay===0);
  assert.equal(normal.daysToNoBacklog,1);assert.equal(normal.originalDrainedDay,null);assert.equal(normal.days[0].pending,0);assert.equal(normal.days[0].writeCredits,64);
  totals.provider_delivery_one={requests:9,rowsRead:256,rowsWritten:47};
  const input=JSON.parse(await readFile(dir+'/input.json','utf8'));input.totals=totals;await writeFile(dir+'/input.json',JSON.stringify(input));
  await writeFile(dir+'/counts.json',JSON.stringify({total:1801,operations:{'source.refreshSnapshot':1799,'externalCommand.confirm':2}}));
  const counted=spawnSync(process.execPath,['scripts/report-budget.mjs',dir+'/input.json',dir+'/counted-output.json',dir+'/idle.json',dir+'/counts.json'],{encoding:'utf8'});
  assert.equal(counted.status,0,counted.stderr);const mixed=JSON.parse(await readFile(dir+'/counted-output.json','utf8'));
  for(const name of ['count_mix_sources_then_confirms','count_mix_confirms_then_sources']){
   const s=mixed.scenarios.find(s=>s.name===name&&s.editOrigin==='desktop'&&s.catalogChangesPerDay===0);
   assert.equal(s.originalDrainedDay,1);assert.equal(s.days[0].originalPending,0);
  }
  assert.equal(mixed.pendingCounts.total,1801);assert.equal(mixed.measuredFamilyWriteCeiling.find(c=>c.editOrigin==='web').maximumMeasuredWriteRatio,47/50);
 }finally{await rm(dir,{recursive:true});}
});
