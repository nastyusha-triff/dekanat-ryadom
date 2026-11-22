import {test} from 'node:test';
import assert from 'node:assert/strict';
import {forecast,journalScenario} from '../server/forecast.mjs';
const now='2026-11-22T09:00:00Z';
const a=[{assignment_id:'a',subject_id:'s',title:'Первая',max_score:10,published_at:'2026-11-01T00:00:00Z',assessment_group:'coursework'},{assignment_id:'b',subject_id:'s',title:'Вторая',max_score:20,published_at:'2026-11-01T00:00:00Z',assessment_group:'coursework'},{assignment_id:'exam',subject_id:'s',title:'Экзамен',max_score:100,published_at:'2026-11-01T00:00:00Z',assessment_group:'exam'}];
const rules=[{rule_id:'sum',subject_id:'s',title:'Работы',operation:'sum',input_ids:'a|b',missing_policy:'partial',output_max:30,role:'progress'},{rule_id:'final',subject_id:'s',title:'Итог',operation:'weighted',input_ids:'sum|exam',weights:'0.6|0.4',missing_policy:'wait',output_max:100,role:'final'}];
const results=[{assignment_id:'a',score:0,status:'graded',graded_at:'2026-11-21T00:00:00Z'},{assignment_id:'exam',score:99,status:'graded',graded_at:'2026-12-01T00:00:00Z',feedback:'hidden'}];
test('Forecast fixes confirmed zero, does not leak hidden exam and does not persist or double-count subtotal',()=>{
 const original=JSON.stringify(results),f=forecast(a,rules,results,now,'2026-12-01T12:00:00+03:00',{b:15,exam:80});
 assert(Math.abs(f.result-62)<1e-9);assert.equal(f.inputs.length,3);assert(!f.inputs.some(x=>x.id==='sum'));assert.equal(f.inputs.find(x=>x.id==='a').confirmed,true);assert.equal(f.inputs.find(x=>x.id==='exam').value,null);assert(!JSON.stringify(f).includes('hidden'));assert.equal(JSON.stringify(results),original);
 assert.throws(()=>forecast(a,rules,results,now,null,{a:1}),/только/);
});
test('Forecast boundaries, decimals, missing assumptions and maximum score use journal engine',()=>{
 assert.equal(forecast(a,rules,[],now,null,{}).result,null);
 assert.equal(forecast(a,rules,[],now,null,{a:0,b:0,exam:0}).result,0);
 assert.equal(forecast(a,rules,[],now,null,{a:10,b:20,exam:100}).result,100);
 assert.equal(forecast(a,rules,[],now,null,{a:2.5,b:5,exam:12.5}).result,20);
 for(const assumptions of [{a:-1},{a:11},{a:'1'},{fake:1},{sum:30}])assert.throws(()=>forecast(a,rules,[],now,null,assumptions));
});
test('Forecast supports text formulas, surfaces division by zero, explains unsupported formulas',()=>{
 const r={...rules[1],operation:'expression',expression:'0.6 * [Первая] + 0.4 * [Вторая]',expression_bindings:{Первая:'a',Вторая:'b'},input_ids:'a|b'};
 assert.equal(forecast(a,[r],[],now,null,{a:10,b:20}).result,14);
 const div={...r,expression:'[Первая] / [Вторая]'};assert.match(forecast(a,[div],[],now,null,{a:1,b:0}).error,/ноль/);
 assert.equal(forecast(a,[],[],now,null).available,false);
 assert.equal(forecast(a,[{...r,operation:'provided'}],[],now,null).available,false);
});


test('Inline calculator recalculates every rule and fixes zero without leaking unpublished grades',()=>{
 const f=journalScenario(a,rules,results,now,'2026-12-01T12:00:00+03:00',{b:15,exam:80});
 assert.equal(f.rows.find(r=>r.id==='sum').value,15);assert(Math.abs(f.rows.find(r=>r.id==='final').value-62)<1e-9);
 assert.equal(f.inputs.find(i=>i.id==='exam').value,null);assert.equal(f.inputs.find(i=>i.id==='a').value,0);
 for(const assumptions of [{a:1},{sum:1},{b:-1},{b:21},{b:'5'},{missing:0}])assert.throws(()=>journalScenario(a,rules,results,now,null,assumptions));
 assert.equal(journalScenario(a,rules,results,now,null,{b:0,exam:0}).rows.find(r=>r.id==='final').value,0);
 assert(!JSON.stringify(f).includes('hidden'));
});
test('Inline calculator works without a final rule, includes unrelated work, and honors incomplete formulas',()=>{
 const f=journalScenario(a,[rules[0]],[],now,null,{b:2.5});assert.equal(f.inputs.length,3);assert.equal(f.rows[0].value,2.5);assert.equal(f.rows[0].status,'partial');
 assert.equal(journalScenario(a,rules,[],now,null,{b:2.5}).rows.find(r=>r.id==='final').value,null);
 assert.equal(journalScenario(a,[],[],now,null,{exam:10}).inputs.length,3);
 const expression={...rules[1],operation:'expression',expression:'[Первая] / [Вторая]',expression_bindings:{Первая:'a',Вторая:'b'},input_ids:'a|b'};
 assert.match(journalScenario(a,[expression],[],now,null,{a:1,b:0}).rows[0].formula_error,/ноль/);
 assert.equal(journalScenario(a,[expression],[],now,null,{a:1,b:2}).rows[0].value,.5);
});
test('Instructor scenario fixes already assigned future marks while student can only see published grades',()=>{
 const f=journalScenario(a,rules,results,now,null,{},true);assert.equal(f.inputs.find(i=>i.id==='exam').value,99);assert.equal(f.inputs.find(i=>i.id==='exam').confirmed,true);
 assert.throws(()=>journalScenario(a,rules,results,now,null,{exam:80},true));
});
