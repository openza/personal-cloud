// Development-only instrumentation. A batch records each statement result once.
export function instrumentD1(database, record, onError=()=>{}) {
  const underlying=new WeakMap();
  function result(value,sql){
    if(!value?.meta||!Number.isFinite(value.meta.rows_read)||!Number.isFinite(value.meta.rows_written))
      throw Error('D1 metadata unavailable; do not guess budget rows.');
    record({sql,rowsRead:value.meta.rows_read,rowsWritten:value.meta.rows_written});return value;
  }
  function statement(base,sql){
    const wrapped={
      bind:(...values)=>statement(base.bind(...values),sql),
      all:async()=>result(await base.all(),sql),
      run:async()=>result(await base.run(),sql),
      first:async(column)=>{const row=result(await base.all(),sql).results[0];if(!row)return null;
        if(column!==undefined&&!Object.hasOwn(row,column))throw Error('D1_COLUMN_NOTFOUND');return column===undefined?row:row[column];},
    };
    underlying.set(wrapped,{base,sql});return wrapped;
  }
  return {
    prepare:sql=>statement(database.prepare(sql),sql),
    batch:async statements=>{
      const originals=statements.map(s=>{const original=underlying.get(s);if(!original)throw Error('Uninstrumented statement');return original;});
      let results;
      try{results=await database.batch(originals.map(s=>s.base));}catch(error){onError(error);throw error;}
      return results.map((r,i)=>result(r,originals[i].sql));
    },
  };
}
