import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseFormula,evaluateFormula} from '../server/formulas.mjs';
import {calculate} from '../server/grading.mjs';
const resolve=label=>({'Задание 1':'a','Задание 2':'b'}[label]);
test('Text formula grammar handles precedence, repeated references, unary signs and simple functions',()=>{
 for(const [source,expected] of [['0.6*[Задание 1] + 0.4*[Задание 2]',76],['sum([Задание 1], [Задание 2]) / 2',75],['max(0, min(100, [Задание 1] + 30))',100],['-(-[Задание 1]) + 2 * (3 + 1)',88],['[Задание 1] / [Задание 1]',1]]){
   const p=parseFormula(source,resolve);assert.equal(evaluateFormula(p.ast,new Map([['a',80],['b',70]])),expected);
 }
 assert.deepEqual(parseFormula('[Задание 1] + [Задание 1]',resolve).ids,['a']);
});
test('Text formulas reject code, unknown references, unsupported syntax and pathological complexity',()=>{
 for(const source of ['__import__("os")','process.exit()','[Задание 1].constructor','[Задание 1];1','[Задание 1] ** 2','[Задание 1] // 2','sqrt([Задание 1])','[Нет оценки]','[Задание 1] +','min()','1+2','('.repeat(40)+'[Задание 1]'+')'.repeat(40)])assert.throws(()=>parseFormula(source,resolve),undefined,source);
 assert.throws(()=>evaluateFormula(parseFormula('[Задание 1] / 0',resolve).ast,new Map([['a',1]])),/ноль/);
});
test('Expression results wait for publication, recalculate chains and report arithmetic errors without breaking journals',()=>{
 const assignments=['a','b'].map(id=>({assignment_id:id,title:id,subject_id:'c',max_score:100,published_at:'2026-01-01',assessment_group:'coursework'}));
 const make=(id,expression,bindings)=>({rule_id:id,subject_id:'c',title:id,operation:'expression',input_ids:[...new Set(Object.values(bindings))].join('|'),expression,expression_bindings:bindings,output_max:200,missing_policy:'wait',visibility:'always'});
 const rules=[make('r','0.6*[a]+0.4*[b]',{a:'a',b:'b'}),make('next','[r]+5',{r:'r'}),make('bad','[a]/([b]-70)',{a:'a',b:'b'})];
 const results=[{assignment_id:'a',score:80,status:'graded',graded_at:'2026-01-01'},{assignment_id:'b',score:70,status:'graded',graded_at:'2026-12-01'}];
 const before=calculate(assignments,rules,results,'2026-11-22');assert.equal(before.get('r').value,null);assert.equal(before.get('next').value,null);
 const after=calculate(assignments,rules,results,'2026-12-02');assert.equal(after.get('r').value,76);assert.equal(after.get('next').value,81);assert.equal(after.get('bad').status,'calculation_error');assert.match(after.get('bad').formula_error,/ноль/);
 const hidden=calculate(assignments,[{...rules[0],visibility:'after_exam'},rules[1]],results,'2026-12-02');assert.equal(hidden.get('next').value,null);
 assert.throws(()=>calculate(assignments,[make('x','[y]',{y:'y'}),make('y','[x]',{x:'x'})],results,'2026-12-02'),/Цикл/);
});
