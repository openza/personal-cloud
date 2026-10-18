import {readD1Migrations} from '@cloudflare/vitest-plugin';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Prepare an export only. Never connect to or modify a database here.
export async function prepareCloudRestore(inputPath, outputPath) {
  const input=path.resolve(inputPath), output=path.resolve(outputPath);
  if(input===output)throw new Error('Choose a separate output file; keep the original export.');
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'openza-cloud-restore-'));
  const temporarySql=path.join(temporary,'0001_export.sql');
  try {
    await fs.chmod(temporary,0o700);
    await fs.writeFile(temporarySql,await fs.readFile(input),{mode:0o600,flag:'wx'});
    const [{queries}]=await readD1Migrations(temporary);
    const pragmas=[], tables=[], inserts=[], indexes=[], triggers=[];
    for(const query of queries) {
      const statement=query.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,'').trim();
      if(/^PRAGMA\s+defer_foreign_keys\s*=\s*(?:TRUE|ON|1)\s*;?$/i.test(statement))pragmas.push(query);
      else if(/^CREATE\s+TABLE\b/i.test(statement))tables.push(query);
      else if(/^INSERT\s+INTO\b/i.test(statement))inserts.push(query);
      else if(/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement))indexes.push(query);
      else if(/^CREATE\s+TRIGGER\b/i.test(statement))triggers.push(query);
      else throw new Error('Unsupported export statement; no restore file was written.');
    }
    if(pragmas.length!==1||!tables.length||!inserts.length)
      throw new Error('Expected a complete Cloudflare SQL export with deferred foreign keys, schema and data.');
    const ordered=[...pragmas,...tables,...inserts,...indexes,...triggers];
    const digest=query=>createHash('sha256').update(query).digest('hex');
    if(JSON.stringify(queries.map(digest).sort())!==JSON.stringify(ordered.map(digest).sort()))
      throw new Error('Statement verification failed; no restore file was written.');
    const sql=ordered.map(query=>query.trim().replace(/;+$/,'')+';').join('\n')+'\n';
    await fs.writeFile(output,sql,{mode:0o600,flag:'wx'});
    return {tables:tables.length,inserts:inserts.length,statements:queries.length};
  } finally {
    await fs.rm(temporarySql,{force:true});
    await fs.rmdir(temporary);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.length!==4) {
    console.error('Usage: npm run prepare:restore -- <original-export.sql> <new-restore.sql>');
    process.exitCode=2;
  } else {
    try {
      const result=await prepareCloudRestore(process.argv[2],process.argv[3]);
      console.log(`Prepared ${result.tables} tables and ${result.inserts} inserts; original SQL statements preserved. No database was changed.`);
    } catch(error) {
      console.error(error.code==='EEXIST'?'Output already exists; choose a new file.':error.message);
      process.exitCode=1;
    }
  }
}
