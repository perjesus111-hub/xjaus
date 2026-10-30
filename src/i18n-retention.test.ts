import {it,expect} from 'vitest';
import ts from 'typescript';
import source from './i18n.ts?raw';
import dictionary from './i18n-dictionary.ts?raw';
// @ts-expect-error Node is test-only, not a renderer dependency.
import {execFileSync} from 'node:child_process';
// @ts-expect-error Node is test-only, not a renderer dependency.
import process from 'node:process';
it('locale registry does not retain detached targets through a self-capturing render callback',()=>{
 const compile=(code:string)=>ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2021}}).outputText;
 const uri=(code:string)=>'data:text/javascript;charset=utf-8,'+encodeURIComponent(code);
 const dictUri=uri(compile(dictionary)),moduleUri=uri(compile(source).split("'./i18n-dictionary'").join(JSON.stringify(dictUri)));
 const probe=`const {bindText,t}=await import(${JSON.stringify(moduleUri)});let weak;(function fixture(){const target={textContent:''};bindText(target,()=>target.textContent?t('play'):t('play'));weak=new WeakRef(target);})();for(let i=0;i<12;i++){await new Promise(r=>setImmediate(r));global.gc();}console.log(JSON.stringify({collected:weak.deref()===undefined}));`;
 const args=['--expose-gc','--input-type=module'];
 expect([process.execPath,...args].join(' ').length).toBeLessThan(32767);
 const result=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8',input:probe}));expect(result.collected).toBe(true);
});
