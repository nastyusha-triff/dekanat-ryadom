import {all, one, stmt, json} from './db.mjs';
import {parseFormula,evaluateFormula} from './formulas.mjs';
import {digest} from './security.mjs';

const split = v => Array.isArray(v) ? v : String(v||'').split('|').filter(Boolean);
const latest = values => values.filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1) || null;
const finite = n => typeof n==='number' && Number.isFinite(n);

export function validateGraph(assignments, rules) {
  const nodes = new Map([...assignments.map(a=>[a.assignment_id,a]),...rules.map(r=>[r.rule_id,r])]);
  if(nodes.size!==assignments.length+rules.length)throw new Error('Повторяющийся идентификатор работы или правила.');
  const done=new Set();
  function visit(id,path=new Set()) {
    const n=nodes.get(id); if(!n)throw new Error(`Неизвестная зависимость: ${id}`);
    if(path.has(id))throw new Error(`Цикл в формулах: ${id}`);
    if(done.has(id))return;
    if(n.assignment_id){if(!(Number(n.max_score)>0))throw new Error('Неверный максимум.');done.add(id);return;}
    const ids=split(n.input_ids);if(!ids.length||new Set(ids).size!==ids.length)throw new Error('Пустые или повторные входы.');
    if(!['sum','weighted','average','best_n','threshold','provided','expression'].includes(n.operation))throw new Error('Неизвестный оператор.');
    if(!['wait','partial'].includes(n.missing_policy)||(!Number.isFinite(Number(n.output_max))||!(Number(n.output_max)>0)))throw new Error('Неверная политика или шкала.');
    for(const child of ids){if(nodes.get(child)?.subject_id!==n.subject_id)throw new Error('Зависимость вне курса.');visit(child,new Set([...path,id]));}
    if(n.operation==='expression'){
      const parsed=parseFormula(n.expression,label=>n.expression_bindings?.[label]);
      if(n.missing_policy!=='wait'||parsed.ids.length!==ids.length||parsed.ids.some(id=>!ids.includes(id)))throw new Error('Некорректные зависимости формулы.');
    }
    if(n.operation==='weighted'){
      const w=split(n.weights).map(Number);
      if(w.length!==ids.length||w.some(x=>!finite(x)||x<0||x>1)||Math.abs(w.reduce((a,b)=>a+b,0)-1)>1e-9)throw new Error('Некорректные веса.');
    }
    if(n.operation==='best_n'&&(!Number.isInteger(Number(n.parameter))||Number(n.parameter)<1||Number(n.parameter)>ids.length))throw new Error('Некорректное N.');
    if(n.operation==='threshold'&&(ids.length!==1||!Number.isFinite(Number(n.parameter))))throw new Error('Некорректный порог.');
    if(n.operation==='provided' && n.implementation){const m=n.implementation;if(m.kind!=='normalized_weighted_bonus'||m.weights.length!==ids.length||m.weights.some(w=>!finite(w)||w<0||w>1)||Math.abs(m.weights.reduce((a,b)=>a+b,0)-1)>1e-9||!finite(m.bonus)||m.bonus<0||m.cap!==Number(n.output_max))throw new Error('Некорректный бонусный расчет.');}
    done.add(id);
  }
  for(const id of nodes.keys())visit(id);
}

export function calculate(assignments,rules,results,now,examEnd=null) {
  validateGraph(assignments,rules);
  const nowMs=Date.parse(now), cache=new Map(), raw=new Map(results.map(r=>[r.assignment_id,r]));
  for(const a of assignments) {
    const r=raw.get(a.assignment_id), isExam=a.assessment_group==='exam';
    const visibleAt=latest([a.published_at,r?.graded_at,isExam?examEnd:null]);
    const visible=!!r && r.status==='graded' && r.score!==null && r.score!=='' && finite(Number(r.score)) && !!r.graded_at && Date.parse(visibleAt)<=nowMs && (!isExam||!!examEnd);
    if(r?.score!==null && r?.score!==undefined && r.score!=='' && (!finite(Number(r.score))||Number(r.score)<0||Number(r.score)>Number(a.max_score)))throw new Error('Оценка вне диапазона.');
    const submitted=!!r?.submitted_at&&Date.parse(r.submitted_at)<=nowMs;
    cache.set(a.assignment_id,{id:a.assignment_id,title:a.title,type:'assignment',value:visible?Number(r.score):null,max:Number(a.max_score),complete:visible,status:visible?'graded':submitted||r?.status==='submitted'?'submitted':'not_submitted',published_at:visible?visibleAt:null,feedback:visible?r.feedback:'',due_at:a.due_at||null,submitted_at:submitted?r.submitted_at:null,visible:Date.parse(a.published_at)<=nowMs&&(!isExam||(!!examEnd&&Date.parse(examEnd)<=nowMs)),formula:'—'});
    cache.get(a.assignment_id)._changed_at=r?.changed_at&&Date.parse(r.changed_at)<=nowMs?r.changed_at:null;
    cache.get(a.assignment_id).graded_at=visible?(cache.get(a.assignment_id)._changed_at||r.graded_at):null;
  }
  const ruleMap=new Map(rules.map(r=>[r.rule_id,r]));
  function compute(id){
    if(cache.has(id))return cache.get(id);
    const r=ruleMap.get(id), children=split(r.input_ids).map(compute).map(c=>c.visible?c:{...c,value:null,complete:false}), known=children.filter(c=>c.value!==null);
    const released=!r.release_at||Date.parse(r.release_at)<=nowMs;
    const complete=children.every(c=>c.complete)&&released, max=r.operation==='sum'?children.reduce((s,c)=>s+c.max,0):Number(r.output_max);
    let value=null, formula=r.formula_display||'', unsupported=false,formulaError='';
    const allowed=released&&(complete||r.missing_policy==='partial');
    if(r.operation==='sum'){if(known.length&&allowed)value=known.reduce((s,c)=>s+c.value,0);formula ||= children.length<=3?children.map(c=>c.title).join(' + '):`Сумма ${children.length} работ (максимум ${max})`;}
    if(r.operation==='weighted'){
      const w=split(r.weights).map(Number);
      if(known.length&&allowed)value=children.reduce((s,c,i)=>s+(c.value===null?0:c.value/c.max*w[i]*max),0);
      formula ||= children.map((c,i)=>`${w[i]*max} × (${c.title} / ${c.max})`).join(' + ');
    }
    if(r.operation==='average'){if(known.length&&allowed)value=known.reduce((s,c)=>s+c.value/c.max,0)/known.length*max;formula ||= `Среднее ${complete?'всех':'опубликованных'} нормированных результатов × ${max}`;}
    if(r.operation==='best_n'){const n=Number(r.parameter);if(known.length>=n&&allowed)value=known.map(c=>c.value/c.max).sort((a,b)=>b-a).slice(0,n).reduce((a,b)=>a+b,0)/n*max;formula ||= `Среднее ${n} лучших результатов (балл / максимум) × ${max}`;}
    if(r.operation==='threshold'){if(known.length&&allowed)value=children[0].value>=Number(r.parameter)?1:0;formula ||= `${children[0].title} ≥ ${r.parameter} — зачтено`;}
    if(r.operation==='provided'){
      const m=r.implementation;
      if(!m)unsupported=true;
      else if(known.length&&allowed)value=Math.min(m.cap,children.reduce((s,c,i)=>s+(c.value===null?0:c.value/c.max*m.weights[i]*max),m.bonus));
    }
    if(r.operation==='expression'){
      formula=r.expression;
      if(complete){try{value=evaluateFormula(parseFormula(r.expression,label=>r.expression_bindings[label]).ast,new Map(children.map(c=>[c.id,c.value])));if(value<0||value>max)throw new Error('Результат вне шкалы от 0 до '+max+'.');}catch(e){value=null;formulaError=e.message;}}
    }
    const result={id,title:r.title,type:'calculated',role:r.role,value,max,complete:complete&&!unsupported&&!formulaError,formula_error:formulaError||undefined,status:formulaError?'calculation_error':unsupported?'recalculation_required':value===null?'pending':complete?'graded':'partial',published_at:value===null?null:latest([...children.map(c=>c.published_at),r.release_at]),formula,version:r.version,output_format:r.output_format,visible:r.visibility!=='after_exam'||!!examEnd&&Date.parse(examEnd)<=nowMs,children:children.map(c=>({id:c.id,title:c.title,value:c.value,max:c.max,status:c.status,published_at:c.published_at,visible:c.visible}))};
    if(value!==null)result.published_at=latest([result.published_at,...children.map(c=>c._changed_at)]);
    result.graded_at=value===null?null:latest(children.filter(c=>c.visible).map(c=>c.graded_at));
    cache.set(id,result);return result;
  }
  for(const r of rules)compute(r.rule_id);
  return cache;
}

export async function gradeInputs(db,studentId,subjectId) {
  const [ar,rr,results,exam] = await Promise.all([
    all(db,`SELECT data FROM assignments WHERE subject_id=? ORDER BY CASE json_extract(data,'$.assessment_group') WHEN 'exam' THEN 1 ELSE 0 END,sort_order,id`,[subjectId]),
    all(db,'SELECT r.data,p.release_at FROM rules r LEFT JOIN rule_publications p ON p.rule_id=r.id AND p.student_id=? WHERE r.subject_id=? ORDER BY r.sort_order,r.id',[studentId,subjectId]),
    all(db,'SELECT r.* FROM results r JOIN assignments a ON a.id=r.assignment_id WHERE r.student_id=? AND a.subject_id=?',[studentId,subjectId]),
    one(db,'SELECT e.data FROM exams e JOIN exam_students s ON s.exam_id=e.id WHERE s.student_id=? AND e.subject_id=? ORDER BY e.date DESC LIMIT 1',[studentId,subjectId])
  ]);
  const assignments=ar.map(x=>json(x.data)), rules=rr.map(x=>({...json(x.data),release_at:x.release_at})), e=exam?json(exam.data):null;
  return {assignments,rules,results,exam:e,examEnd:e?`${e.date}T${e.end_time}:00+03:00`:null};
}

export async function courseGrades(db,studentId,subjectId,now,{teacher=false,offset=0,limit=50}={}) {
  const {assignments,rules,results,exam:e,examEnd}=await gradeInputs(db,studentId,subjectId);
  const values=calculate(assignments,rules,results,now,examEnd);
  // Cache only the publication-safe projection; fingerprints do not contain hidden grades.
  const writes=[];
  for(const r of rules){const data=values.get(r.rule_id),fingerprint=await digest(JSON.stringify(data));writes.push(stmt(db,'INSERT INTO calculations(student_id,rule_id,fingerprint,data) VALUES(?,?,?,?) ON CONFLICT(student_id,rule_id) DO UPDATE SET fingerprint=excluded.fingerprint,data=excluded.data WHERE calculations.fingerprint<>excluded.fingerprint',[studentId,r.rule_id,fingerprint,JSON.stringify(data)]));}
  if(writes.length)await db.batch(writes);
  // Always return the calculation from this consistent input snapshot, never an old cached provided result.
  // A row's existence is independent of the release of its result. Keep all
  // assignment/rule metadata, but never reveal a hidden calculated value.
  const rows=[...assignments.map(a=>{const {_changed_at,...value}=values.get(a.assignment_id),r=results.find(x=>x.assignment_id===a.assignment_id),assessed=r?.changed_at||r?.graded_at;return {...value,...(teacher?{graded_at:r?.status==='graded'&&assessed&&Date.parse(assessed)<=Date.parse(now)?assessed:null,edit:{score:r?.score??null,feedback:r?.feedback||'',graded_at:r?.graded_at||null,version:r?.version||0}}:{})};}),...rules.map(r=>{const value=values.get(r.rule_id);return value.visible?value:{...value,value:null,complete:false,status:'pending',published_at:null,graded_at:null,children:[]};})];
  const works=rows.filter(r=>r.type==='assignment'),progress=rules.find(r=>r.role==='progress'),final=rules.find(r=>r.role==='final');
  const overview={graded:works.filter(r=>r.status==='graded').length,pending:works.filter(r=>r.status==='submitted').length,ungraded:works.filter(r=>r.status==='not_submitted').length,progress:progress?rows.find(r=>r.id===progress.rule_id):null,final_formula:final?values.get(final.rule_id).formula:null};
  return {overview,items:rows.slice(offset,offset+limit),total:rows.length,has_more:offset+limit<rows.length,summary:rules.filter(r=>['progress','final','exam'].includes(r.role)).map(r=>values.get(r.rule_id)).filter(r=>r.visible),exam:e};
}
