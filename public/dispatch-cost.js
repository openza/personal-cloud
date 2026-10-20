// Conservative workload credits, not Cloudflare billing or an account-global limit.
export const dispatchLimits={requests:10000,envelopes:3000,writeCredits:45000};
export const operationCredits={
  'task.patch':25,'source.refreshSnapshot':16,
  'task.create':50,'task.createRich':50,'task.updateOpenzaFields':50,
  'task.complete':50,'task.reopen':50,'task.delete':50,
  'task.setProject':50,'task.move':50,'task.addLabel':50,'task.removeLabel':50,'task.setParent':50,
  'space.put':50,'project.put':50,'provider.scope.put':50,'provider.catalog.put':50,
  'provider.intent.request':50,'provider.intent.start':50,'provider.intent.resolve':50,
  'externalCommand.confirm':50,'externalCommand.reject':50,
  'project.delete':45000,'task.moveTree':45000,
};
export const fanoutBudget={protocolVersion:1,requestHeader:'x-openza-fanout-bound',baseCredits:100,perEntityCredits:12};
export function mutationCredits(m,fanoutBound){
  // Unknown future operations are held visibly until their cost policy is reviewed.
  if(!m||!Object.hasOwn(operationCredits,m.operation))return dispatchLimits.writeCredits+1;
  let cost=operationCredits[m.operation];
  if((m.operation==='project.delete'||m.operation==='task.moveTree')&&Number.isSafeInteger(fanoutBound)&&fanoutBound>=0)
    cost=fanoutBudget.baseCredits+fanoutBudget.perEntityCredits*fanoutBound;
  if(m.operation==='task.createRich'){
    if(!Array.isArray(m.payload?.task?.labels))return dispatchLimits.writeCredits+1;
    cost+=10*m.payload.task.labels.length;
  }
  if((m.operation==='task.create'||m.operation==='task.createRich')&&m.payload?.source)cost+=16;
  return Number.isSafeInteger(cost)?cost:dispatchLimits.writeCredits+1;
}
export function requestCredits(path,body,fanoutBound){
  if(path==='/v1/tasks/mutations')return mutationCredits(body,fanoutBound);
  if(path==='/v1/tasks/mutations/batch'){
    if(!Array.isArray(body?.mutations))return dispatchLimits.writeCredits+1;
    // Reserve the exact transmitted prefix, without reordering or refunding suffixes.
    return body.mutations.reduce((n,m)=>n+mutationCredits(m,fanoutBound),0);
  }
  return 0;
}
export function requestFanoutBound(path,body,{health,payload}={}){
  const capability=health?.capabilities?.fanoutBudget;
  if(capability?.protocolVersion!==1||capability.requestHeader!==fanoutBudget.requestHeader||!payload||payload.hasMore||!Array.isArray(payload.tasks)||!Array.isArray(payload.allProjects??payload.projects))return undefined;
  const items=path==='/v1/tasks/mutations'?[body]:path==='/v1/tasks/mutations/batch'?body?.mutations:[];
  if(!Array.isArray(items)||!items.some(m=>['project.delete','task.moveTree'].includes(m?.operation)))return undefined;
  const tasks=payload.tasks.filter(t=>!t.deletedAt),projects=(payload.allProjects??payload.projects).filter(p=>!p.deletedAt);
  const bounds=items.filter(m=>['project.delete','task.moveTree'].includes(m?.operation)).map(m=>{
    // A recovered pending mutation may already have changed local references.
    // The complete workspace is a conservative fallback; never edit its body.
    if(m.operation==='project.delete')return projects.some(p=>p.id===m.entityId)?tasks.filter(t=>t.projectId===m.entityId).length+projects.filter(p=>p.parentId===m.entityId).length:tasks.length+projects.length;
    if(!tasks.some(t=>t.id===m.entityId))return tasks.length+projects.length;
    const tree=new Set([m.entityId]);let changed=true;
    while(changed){changed=false;for(const task of tasks)if(tree.has(task.parentId)&&!tree.has(task.id)){tree.add(task.id);changed=true;}}
    return tree.size;
  });
  return Math.max(...bounds);
}
