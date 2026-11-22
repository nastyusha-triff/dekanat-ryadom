import {all,one,json} from './db.mjs';
import {assert} from './security.mjs';
import {calculate,gradeInputs} from './grading.mjs';

// A journal scenario includes every leaf and every calculation, even for a
// course without a final rule. It never writes results or calculation caches.
export function journalScenario(assignments,rules,results,now,examEnd,assumptions={},teacher=false){
  assert(assumptions&&typeof assumptions==='object'&&!Array.isArray(assumptions),400,'Проверьте предполагаемые оценки.');
  const actual=calculate(assignments,rules,results,now,examEnd);
  const inputs=assignments.map(a=>{
    const v=actual.get(a.assignment_id),raw=results.find(r=>r.assignment_id===a.assignment_id);
    const confirmed=teacher?raw?.status==='graded'&&raw.score!==null&&raw.score!==undefined&&raw.score!=='':v.visible&&v.complete;
    return {id:a.assignment_id,title:a.title,max:Number(a.max_score),confirmed:!!confirmed,value:confirmed?(teacher?Number(raw.score):v.value):null};
  });
  const byId=new Map(inputs.map(i=>[i.id,i]));
  for(const [id,value] of Object.entries(assumptions)){
    const input=byId.get(id);
    assert(input&&!input.confirmed,400,'Можно менять только еще не выставленные оценки. Обновите журнал, если оценка уже появилась.');
    assert(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=input.max,400,`«${input.title}»: укажите число от 0 до ${input.max}.`);
  }
  const simulated=inputs.filter(i=>i.confirmed||Object.hasOwn(assumptions,i.id)).map(i=>({assignment_id:i.id,score:i.confirmed?i.value:assumptions[i.id],status:'graded',graded_at:now}));
  const projected=calculate(assignments.map(a=>({...a,published_at:now})),rules.map(r=>({...r,release_at:null,visibility:'always'})),simulated,now,now);
  return {inputs,rows:rules.map(r=>{const v=projected.get(r.rule_id);return {id:v.id,value:v.value,max:v.max,complete:v.complete,status:v.status,output_format:v.output_format,formula_error:v.formula_error};})};
}

export async function courseJournalScenario(db,studentId,subjectId,now,assumptions,teacher=false){
  const {assignments,rules,results,examEnd}=await gradeInputs(db,studentId,subjectId);
  return journalScenario(assignments,rules,results,now,examEnd,assumptions,teacher);
}

// Scenario inputs are publication-safe leaf grades; intermediate totals are never inputs.
export function forecast(assignments,rules,results,now,examEnd,assumptions={}){
  assert(assumptions&&typeof assumptions==='object'&&!Array.isArray(assumptions),400,'Проверьте предположения.');
  const unavailable=reason=>({available:false,reason,inputs:[],result:null});
  const finals=rules.filter(r=>r.role==='final');
  if(finals.length!==1)return unavailable(finals.length?'В курсе несколько итоговых формул. Преподавателю нужно определить единственный итог.':'Итоговая формула еще не настроена.');
  const final=finals[0],nodes=new Map([...assignments.map(a=>[a.assignment_id,a]),...rules.map(r=>[r.rule_id,r])]),needed=new Set();
  function visit(id){if(needed.has(id))return;needed.add(id);const n=nodes.get(id);for(const child of String(n?.input_ids||'').split('|').filter(Boolean))visit(child);}
  visit(final.rule_id);
  if([...needed].some(id=>!nodes.has(id)))return unavailable('В формуле отсутствует один из компонентов.');
  if(rules.some(r=>needed.has(r.rule_id)&&r.operation==='provided'&&!r.implementation))return unavailable('Для формулы не задан механизм расчета.');
  if(assignments.some(a=>needed.has(a.assignment_id)&&Date.parse(a.published_at)>Date.parse(now)))return unavailable('Часть компонентов еще не опубликована. Расчет появится после их публикации.');
  const actual=calculate(assignments,rules,results,now,examEnd);
  const inputs=assignments.filter(a=>needed.has(a.assignment_id)).map(a=>{const v=actual.get(a.assignment_id);return {id:a.assignment_id,title:a.title,group:a.assessment_group,max:Number(a.max_score),confirmed:v.visible&&v.complete,value:v.visible&&v.complete?v.value:null};});
  for(const [id,value] of Object.entries(assumptions)){
    const input=inputs.find(i=>i.id===id);assert(input&&!input.confirmed,400,'Можно предполагать только еще не опубликованные оценки итоговой формулы.');
    assert(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=input.max,400,`«${input.title}»: укажите число от 0 до ${input.max}.`);
  }
  const simulated=inputs.filter(i=>i.confirmed||Object.hasOwn(assumptions,i.id)).map(i=>({assignment_id:i.id,score:i.confirmed?i.value:assumptions[i.id],status:'graded',graded_at:now}));
  const projected=calculate(assignments.map(a=>({...a,published_at:now})),rules.map(r=>({...r,release_at:null,visibility:'always'})),simulated,now,now).get(final.rule_id);
  const pending=inputs.filter(i=>!i.confirmed&&!Object.hasOwn(assumptions,i.id)).length;
  return {available:true,inputs:inputs.map(i=>({...i,assumed:Object.hasOwn(assumptions,i.id)?assumptions[i.id]:null})),formula:projected.formula,title:final.title,max:projected.max,pending,result:pending||!projected.complete?null:projected.value,output_format:projected.output_format,error:projected.formula_error||null,limitations:'Прогноз по текущей формуле. Предположения не сохраняются и не меняют оценки. Публикация результата и допуск к аттестации определяются преподавателем.'};
}
export async function courseForecast(db,studentId,subjectId,now,assumptions){
  const [a,r,results,exam]=await Promise.all([all(db,'SELECT data FROM assignments WHERE subject_id=? ORDER BY sort_order,id',[subjectId]),all(db,'SELECT r.data,p.release_at FROM rules r LEFT JOIN rule_publications p ON p.rule_id=r.id AND p.student_id=? WHERE r.subject_id=?',[studentId,subjectId]),all(db,'SELECT r.* FROM results r JOIN assignments a ON a.id=r.assignment_id WHERE r.student_id=? AND a.subject_id=?',[studentId,subjectId]),one(db,'SELECT e.data FROM exams e JOIN exam_students s ON s.exam_id=e.id WHERE s.student_id=? AND e.subject_id=? ORDER BY e.date DESC LIMIT 1',[studentId,subjectId])]);
  const e=exam?json(exam.data):null;
  return forecast(a.map(x=>json(x.data)),r.map(x=>({...json(x.data),release_at:x.release_at})),results,now,e?`${e.date}T${e.end_time}:00+03:00`:null,assumptions);
}
