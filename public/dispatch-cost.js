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
export function mutationCredits(m){
  // Unknown future operations are held visibly until their cost policy is reviewed.
  if(!m||!Object.hasOwn(operationCredits,m.operation))return dispatchLimits.writeCredits+1;
  let cost=operationCredits[m.operation];
  if(m.operation==='task.createRich'){
    if(!Array.isArray(m.payload?.task?.labels))return dispatchLimits.writeCredits+1;
    cost+=10*m.payload.task.labels.length;
  }
  if((m.operation==='task.create'||m.operation==='task.createRich')&&m.payload?.source)cost+=16;
  return Number.isSafeInteger(cost)?cost:dispatchLimits.writeCredits+1;
}
export function requestCredits(path,body){
  if(path==='/v1/tasks/mutations')return mutationCredits(body);
  if(path==='/v1/tasks/mutations/batch'){
    if(!Array.isArray(body?.mutations))return dispatchLimits.writeCredits+1;
    // Reserve the exact transmitted prefix, without reordering or refunding suffixes.
    return body.mutations.reduce((n,m)=>n+mutationCredits(m),0);
  }
  return 0;
}
