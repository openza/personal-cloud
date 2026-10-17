import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

test('all shipped Web JavaScript parses in the supported Node runtime',()=>{
  for(const file of readdirSync(new URL('../public/',import.meta.url)).filter(name=>name.endsWith('.js'))){
    execFileSync(process.execPath,['--check',fileURLToPath(new URL('../public/'+file,import.meta.url))],{stdio:'pipe'});
  }
});
