import {all,one,stmt,json} from './db.mjs';
import {assert,HttpError,body,random,validDate} from './security.mjs';
import {dateRu,lessonEnd} from './student-services.mjs';
import {parseFormula} from './formulas.mjs';
import {validateGraph} from './grading.mjs';

const text=(value,label,max=2000,required=true)=>{
  assert(typeof value==='string'&&value.trim().length<=max&&(!required||value.trim()),400,`Проверьте поле «${label}».`);
  return value.trim();
};
const url=value=>{const v=text(value||'','Ссылка',1000,false);assert(!v||/^https:\/\//i.test(v)&&(()=>{try{return !!new URL(v).hostname;}catch{return false;}})(),400,'Ссылка должна начинаться с https://.');return v;};
const version=(b,r)=>assert(Number.isInteger(b.version)&&b.version===r.version,409,'Данные уже изменены. Откройте форму заново.');
async function owned(db,user,id){
  assert(['teacher','deanery'].includes(user.role),403,'Доступно только преподавателю.');
  const c=await one(db,'SELECT * FROM subjects WHERE id=?',[id]);
  assert(c,404,'Дисциплина не найдена.');assert(user.role==='deanery'||c.teacher_id===user.id,403,'Нет доступа к этой дисциплине.');return c;
}
const audit=(db,user,kind,id,now,old,next,guard=false)=>stmt(db,`INSERT INTO management_history(id,actor_id,kind,object_id,occurred_at,old_data,new_data) VALUES(?,${guard?'CASE WHEN changes()=1 THEN ? ELSE NULL END':'?'},?,?,?,?,?)`,[random(),user.id,kind,id,now,old?JSON.stringify(old):null,JSON.stringify(next)]);
const guardedBatch=async(db,queries)=>{try{await db.batch(queries);}catch(e){throw new HttpError(409,'Данные изменились одновременно. Обновите страницу и повторите действие.');}};
function timeRange(b){
  assert(validDate(b.date),400,'Проверьте дату занятия.');
  for(const t of [b.start_time,b.end_time])assert(typeof t==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(t),400,'Проверьте время.');
  assert(b.start_time<b.end_time,400,'Окончание должно быть позже начала.');
}
async function recipients(db,subject,b){
  assert(Array.isArray(b.student_ids)&&b.student_ids.length>0&&b.student_ids.length<=200&&b.student_ids.every(x=>typeof x==='string'),400,'Выберите студентов или группу.');
  const ids=[...new Set(b.student_ids)];
  const enrolled=new Set((await all(db,'SELECT student_id FROM enrollments WHERE subject_id=?',[subject])).map(x=>x.student_id));
  assert(ids.every(id=>enrolled.has(id)),400,'Можно выбрать только студентов этой дисциплины.');return ids;
}
function slotConflict(teacherId,b,ids,ignore=''){
  const parts=[],args=[];
  for(const [table,registrations,key] of [['lessons','lesson_students','lesson_id'],['exams','exam_students','exam_id']]){
    parts.push(`SELECT l.data FROM ${table} l JOIN subjects s ON s.id=l.subject_id WHERE l.date=? AND l.id<>? AND json_extract(l.data,'$.start_time')<? AND json_extract(l.data,'$.end_time')>? AND (s.teacher_id=? OR lower(json_extract(l.data,'$.room'))=lower(?) OR EXISTS (SELECT 1 FROM ${registrations} reg WHERE reg.${key}=l.id AND reg.student_id IN (${ids.map(()=>'?').join(',')})))`);
    args.push(b.date,ignore,b.end_time,b.start_time,teacherId,b.room,...ids);
  }
  return {sql:parts.join(' UNION ALL '),args};
}
async function checkSlot(db,slot){
  const row=await one(db,slot.sql+' LIMIT 1',slot.args);
  if(row){const l=json(row.data);throw new HttpError(409,`В это время уже есть занятие «${l.subject_name}» (${l.start_time}–${l.end_time}, ${l.room}). Выберите другое время или аудиторию.`);}
}
const slotAudit=(db,user,kind,id,now,old,next,slot)=>stmt(db,`INSERT INTO management_history(id,actor_id,kind,object_id,occurred_at,old_data,new_data) VALUES(?,CASE WHEN changes()=1 AND NOT EXISTS (${slot.sql}) THEN ? ELSE NULL END,?,?,?,?,?)`,[random(),...slot.args,user.id,kind,id,now,old?JSON.stringify(old):null,JSON.stringify(next)]);

export async function management(request,{db,user,path,now,url:requestUrl}){
  const method=request.method;
  if(path[0]==='profile'&&path.length===1&&method==='PUT'){
    const b=await body(request);version(b,{version:user.profile_version});
    const email=text(b.email,'Почта',254),phone=text(b.phone||'','Телефон',30,false);
    assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),400,'Проверьте адрес почты.');
    assert(!phone||/^[+()\d\s-]{5,30}$/.test(phone)&&phone.replace(/\D/g,'').length>=5,400,'Проверьте телефон.');
    const before=json(user.profile),data={...before,email,phone};
    if(user.role!=='student')data.consultation=text(b.consultation||'','Приемные часы',500,false);
    else assert(b.consultation===undefined,403,'Приемные часы доступны преподавателю и деканату.');
    await guardedBatch(db,[stmt(db,'UPDATE users SET profile=?,profile_version=profile_version+1 WHERE id=? AND profile_version=?',[JSON.stringify(data),user.id,b.version]),audit(db,user,'profile',user.id,now,before,data,true)]);
    return {data:{saved:true,version:b.version+1}};
  }
  if(path[0]==='teachers'&&path[1]&&method==='GET'){
    const t=await one(db,"SELECT id,profile FROM users WHERE id=? AND role='teacher'",[path[1]]);assert(t,404,'Преподаватель не найден.');
    if(user.role==='student')assert(await one(db,'SELECT 1 FROM subjects s JOIN enrollments e ON e.subject_id=s.id WHERE s.teacher_id=? AND e.student_id=?',[t.id,user.id]),403,'Профиль недоступен.');
    const courses=await all(db,'SELECT id,name FROM subjects WHERE teacher_id=? ORDER BY name',[t.id]);
    return {data:{...json(t.profile),id:t.id,courses}};
  }
  if(path[0]==='lessons'&&path[1]==='slots'&&method==='POST'){
    const b=await body(request),old=b.lesson_id?await one(db,'SELECT * FROM lessons WHERE id=?',[b.lesson_id]):null;
    if(b.lesson_id)assert(old,404,'Занятие недоступно.');
    const c=await owned(db,user,old?.subject_id||b.subject_id);
    if(old)assert(lessonEnd(json(old.data))>Date.parse(now),403,'Прошедшее занятие нельзя редактировать.');
    timeRange(b);b.room=text(b.room,'Аудитория',100);const ids=await recipients(db,c.id,b);
    const minute=t=>Number(t.slice(0,2))*60+Number(t.slice(3)),duration=minute(b.end_time)-minute(b.start_time);
    assert(duration>=15&&duration<=240,400,'Для подбора слотов выберите длительность от 15 минут до 4 часов.');
    const hhmm=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0'),slots=[];
    // Batch occupied intervals once; suggestions and saving share the same teacher/room/roster conflict predicate.
    for(let day=0;day<7&&slots.length<8;day++){
      const date=new Date(Date.parse(b.date+'T12:00:00Z')+day*86400000).toISOString().slice(0,10);
      const query=slotConflict(c.teacher_id,{...b,date,start_time:'00:00',end_time:'23:59'},ids,old?.id);
      const busy=(await all(db,query.sql,query.args)).map(r=>json(r.data));
      for(let start=9*60;start+duration<=22*60&&slots.length<8;start+=30){
        const end=start+duration;if(Date.parse(`${date}T${hhmm(start)}:00+03:00`)<=Date.parse(now))continue;
        if(old){const previous=json(old.data);if(previous.date===date&&previous.start_time===hhmm(start)&&previous.end_time===hhmm(end)&&previous.room.toLowerCase()===b.room.toLowerCase())continue;}
        if(busy.some(l=>minute(l.start_time)<end&&minute(l.end_time)>start))continue;
        slots.push({date,start_time:hhmm(start),end_time:hhmm(end),room:b.room});start+=Math.max(0,duration-30);
      }
    }
    return {data:{slots,timezone:'Europe/Moscow',note:'Ближайшие свободные интервалы с 09:00 до 22:00 за 7 дней от выбранной даты. Учитываются преподаватель, аудитория и выбранные студенты. При сохранении доступность проверяется снова.'}};
  }
  if(path[0]==='lessons'&&(method==='POST'||method==='PUT')){
    const b=await body(request),old=path[1]?await one(db,'SELECT * FROM lessons WHERE id=?',[path[1]]):null;
    if(method==='PUT')assert(old,404,'Занятие не найдено.');
    assert(method==='POST'?!path[1]:!!path[1],404,'Операция не найдена.');
    const c=await owned(db,user,old?.subject_id||b.subject_id);
    if(old){version(b,old);assert(!b.subject_id||b.subject_id===old.subject_id,400,'Дисциплину существующей пары изменить нельзя.');}
    if(old){const previous=json(old.data);assert(Date.parse(`${previous.date}T${previous.end_time}:00+03:00`)>Date.parse(now),403,'Прошедшее занятие нельзя редактировать.');}
    timeRange(b);assert(Date.parse(`${b.date}T${b.end_time}:00+03:00`)>Date.parse(now),400,'Нельзя сохранить занятие в прошлом.');b.room=text(b.room,'Аудитория',100);
    const ids=await recipients(db,c.id,b);await checkSlot(db,slotConflict(c.teacher_id,b,ids,old?.id));
    const id=old?.id||'L-'+crypto.randomUUID(),before=old?json(old.data):null;
    const changed=before&&['date','start_time','end_time','room'].some(k=>before[k]!==b[k]);
    const data={...before,lesson_id:id,subject_id:c.id,subject_name:c.name,date:b.date,start_time:b.start_time,end_time:b.end_time,room:b.room,timezone:'Europe/Moscow',topic:text(b.topic||'','Тема занятия',500,false),status:changed?'rescheduled':before?.status||'scheduled'};
    const writes=[old?stmt(db,'UPDATE lessons SET date=?,data=?,version=version+1 WHERE id=? AND version=?',[b.date,JSON.stringify(data),id,old.version]):stmt(db,'INSERT INTO lessons(id,subject_id,date,data) VALUES(?,?,?,?)',[id,c.id,b.date,JSON.stringify(data)]),slotAudit(db,user,'lesson',id,now,before,data,slotConflict(c.teacher_id,b,ids,id)),stmt(db,'DELETE FROM lesson_students WHERE lesson_id=?',[id]),...ids.map(s=>stmt(db,'INSERT INTO lesson_students(id,lesson_id,student_id) VALUES(?,?,?)',[s+'__'+id,id,s]))];
    if(changed){const change={change_id:'CHG-'+crypto.randomUUID(),lesson_id:id,subject_id:c.id,old_date:before.date,old_start_time:before.start_time,old_end_time:before.end_time,old_room:before.room,new_date:b.date,new_start_time:b.start_time,new_end_time:b.end_time,new_room:b.room,announced_at:now};writes.push(stmt(db,'INSERT INTO changes(id,lesson_id,announced_at,data) VALUES(?,?,?,?)',[change.change_id,id,now,JSON.stringify(change)]));}
    const former=old?(await all(db,'SELECT student_id FROM lesson_students WHERE lesson_id=?',[id])).map(s=>s.student_id):[];
    for(const student of new Set([...ids,...former]))writes.push(stmt(db,'INSERT INTO notifications(id,user_id,kind,published_at,data) VALUES(?,?,?,?,?)',[random(),student,'schedule',now,JSON.stringify({title:ids.includes(student)?old?'Занятие обновлено':'Новое занятие':'Изменен состав занятия',body:ids.includes(student)?`${c.name}: ${dateRu(b.date)}, ${b.start_time} · ${b.room}`:`${c.name}: занятие больше не входит в ваше расписание.`,route:ids.includes(student)?'lesson/'+id:'schedule'})]));
    const range=json((await one(db,"SELECT value FROM meta WHERE key='schedule_range'")).value);
    writes.push(stmt(db,"UPDATE meta SET value=? WHERE key='schedule_range'",[JSON.stringify([b.date<range[0]?b.date:range[0],b.date>range[1]?b.date:range[1]])]));
    await guardedBatch(db,writes);return {status:old?200:201,data:{...data,version:(old?.version||0)+1}};
  }
  if(path[0]!=='courses'||!path[1])return null;
  const id=path[1];
  const supported=method==='PUT'&&!path[2]||['manage','assignments','rules','exam'].includes(path[2]);
  if(!supported)return null;
  const c=await owned(db,user,id);
  if(path[2]==='manage'&&method==='GET'){
    const assignments=(await all(db,'SELECT * FROM assignments WHERE subject_id=? ORDER BY sort_order,id',[id])).map(r=>({...json(r.data),id:r.id,version:r.version}));
    const rules=(await all(db,'SELECT * FROM rules WHERE subject_id=? ORDER BY sort_order,id',[id])).map(r=>({...json(r.data),id:r.id,revision:r.version}));
    const exams=[];for(const r of await all(db,'SELECT * FROM exams WHERE subject_id=? ORDER BY date,id',[id]))exams.push({...json(r.data),id:r.id,version:r.version,student_ids:(await all(db,'SELECT student_id FROM exam_students WHERE exam_id=?',[r.id])).map(x=>x.student_id)});
    return {data:{assignments,rules,exams}};
  }
  if(method==='PUT'&&!path[2]){
    const b=await body(request);version(b,c);
    const name=text(b.name,'Название',200),description=text(b.description||'','О курсе',4000,false),consultation=text(b.consultation||'','Консультации',500,false);
    assert(['exam','pass_fail','none'].includes(b.assessment_type),400,'Выберите аттестацию.');
    const details={...json(c.details),subject_name:name,description,consultation,assessment_type:b.assessment_type,assessment_label:{exam:'Экзамен',pass_fail:'Зачет',none:'Без экзамена'}[b.assessment_type],resources:[{label:'Чат курса',icon:'chat',url:url(b.chat_url)},{label:'Материалы курса',icon:'book',url:url(b.materials_url)}]};
    const writes=[stmt(db,'UPDATE subjects SET name=?,details=?,version=version+1 WHERE id=? AND version=?',[name,JSON.stringify(details),id,c.version]),audit(db,user,'course',id,now,json(c.details),details,true)];
    for(const table of ['lessons','exams'])writes.push(stmt(db,`UPDATE ${table} SET data=json_set(data,'$.subject_name',?),version=version+1 WHERE subject_id=?`,[name,id]));
    await guardedBatch(db,writes);return {data:{saved:true,version:c.version+1}};
  }
  if(path[2]==='assignments'&&['POST','PUT'].includes(method)){
    const b=await body(request),old=path[3]?await one(db,'SELECT * FROM assignments WHERE id=? AND subject_id=?',[path[3],id]):null;
    if(method==='PUT'){assert(old,404,'Задание не найдено.');version(b,old);}else assert(!path[3],400,'Проверьте адрес задания.');
    const max=Number(b.max_score);assert(Number.isFinite(max)&&max>0&&max<=10000,400,'Максимальный балл должен быть от 0 до 10000.');
    assert(['coursework','exam'].includes(b.assessment_group),400,'Выберите вид работы.');
    if(old){const r=await one(db,'SELECT MAX(score) AS score FROM results WHERE assignment_id=?',[old.id]);assert(r.score===null||r.score<=max,400,'Максимум меньше уже выставленной оценки. Сначала исправьте оценки.');}
    const assignmentId=old?.id||'A-'+crypto.randomUUID(),published=b.published_at||now;
    assert(typeof published==='string'&&!isNaN(Date.parse(published)),400,'Проверьте дату публикации.');
    const due=b.due_at===undefined?(old?json(old.data).due_at:''):b.due_at;
    assert(!due||typeof due==='string'&&Number.isFinite(Date.parse(due)),400,'Проверьте дедлайн.');
    const data={...(old?json(old.data):{}),assignment_id:assignmentId,subject_id:id,title:text(b.title,'Название задания',200),assessment_group:b.assessment_group,kind:text(b.kind||'Работа','Вид работы',100),max_score:max,published_at:new Date(published).toISOString(),due_at:due?new Date(due).toISOString():'',sort_order:old?.sort_order||Number((await one(db,'SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM assignments WHERE subject_id=?',[id])).n),group_id:b.assessment_group==='exam'?'exam':'practice'};
    await guardedBatch(db,[old?stmt(db,'UPDATE assignments SET data=?,version=version+1 WHERE id=? AND version=?',[JSON.stringify(data),assignmentId,old.version]):stmt(db,'INSERT INTO assignments(id,subject_id,sort_order,data) VALUES(?,?,?,?)',[assignmentId,id,data.sort_order,JSON.stringify(data)]),audit(db,user,'assignment',assignmentId,now,old?json(old.data):null,data,true)]);
    return {status:old?200:201,data:{...data,version:(old?.version||0)+1}};
  }
  if(path[2]==='rules'&&['POST','PUT'].includes(method)){
    const b=await body(request),old=path[3]?await one(db,'SELECT * FROM rules WHERE id=? AND subject_id=?',[path[3],id]):null;
    if(method==='PUT'){assert(old,404,'Правило не найдено.');version(b,old);}else assert(!path[3],400,'Проверьте адрес правила.');
    assert(['sum','weighted','average','best_n','threshold','provided','expression'].includes(b.operation),400,'Выберите способ расчета.');
    assert(['additional','progress','final','exam'].includes(b.role),400,'Выберите назначение результата.');
    assert(['always','after_exam'].includes(b.visibility)&&['wait','partial'].includes(b.missing_policy),400,'Проверьте условия публикации.');
    const ruleId=old?.id||'RULE-'+crypto.randomUUID();
    const data={...(old?json(old.data):{}),rule_id:ruleId,subject_id:id,title:text(b.title,'Название результата',200),operation:b.operation,input_ids:b.operation==='expression'?'':text(b.input_ids,'Зависимости',4000),weights:text(b.weights||'','Веса',2000,false),parameter:text(b.parameter||'','Параметр',100,false),output_max:Number(b.output_max),output_format:b.operation==='threshold'?'pass_fail':'score',missing_policy:b.missing_policy,role:b.role,visibility:b.visibility,formula_display:'',version:String((old?.version||0)+1),sort_order:old?.sort_order||100,group_id:'results'};
    delete data.implementation;
    if(b.operation==='provided')data.implementation={kind:'normalized_weighted_bonus',weights:b.weights.split('|').map(Number),bonus:Number(b.bonus),cap:Number(b.output_max)};
    const assignments=(await all(db,'SELECT data FROM assignments WHERE subject_id=?',[id])).map(r=>json(r.data)),rules=(await all(db,'SELECT data FROM rules WHERE subject_id=? AND id<>?',[id,ruleId])).map(r=>json(r.data));
    try{
      if(b.operation==='expression'){
        const nodes=[...assignments,...rules],previous=old?json(old.data):null;
        const parsed=parseFormula(b.expression,label=>{
          const saved=previous?.expression===b.expression?previous.expression_bindings?.[label]:null;
          if(saved&&nodes.some(n=>(n.assignment_id||n.rule_id)===saved))return saved;
          const matches=nodes.filter(n=>n.title===label||n.assignment_id===label||n.rule_id===label);
          if(matches.length>1)throw new Error(`Название «${label}» неоднозначно. Используйте идентификатор работы.`);
          return matches[0]?.assignment_id||matches[0]?.rule_id;
        });
        data.expression=b.expression;data.expression_bindings=parsed.bindings;data.input_ids=parsed.ids.join('|');data.missing_policy='wait';
      }else {delete data.expression;delete data.expression_bindings;}
      validateGraph(assignments,[...rules,data]);
    }catch(e){throw new HttpError(400,e.message);}
    // Serialize graph changes per course, so concurrent edits cannot introduce a cycle.
    await guardedBatch(db,[stmt(db,'UPDATE subjects SET version=version+1 WHERE id=? AND version=?',[id,c.version]),audit(db,user,'formula_graph',id,now,null,{rule_id:ruleId},true),old?stmt(db,'UPDATE rules SET data=?,version=version+1 WHERE id=? AND version=?',[JSON.stringify(data),ruleId,old.version]):stmt(db,'INSERT INTO rules(id,subject_id,sort_order,data) VALUES(?,?,?,?)',[ruleId,id,data.sort_order,JSON.stringify(data)]),audit(db,user,'rule',ruleId,now,old?json(old.data):null,data,true)]);
    return {status:old?200:201,data:{saved:true,id:ruleId}};
  }
  if(path[2]==='exam'&&['POST','PUT'].includes(method)){
    const b=await body(request),old=path[3]?await one(db,'SELECT * FROM exams WHERE id=? AND subject_id=?',[path[3],id]):null;
    if(method==='PUT'){assert(old,404,'Экзамен не найден.');version(b,old);}else assert(!path[3],400,'Проверьте адрес экзамена.');
    timeRange(b);b.room=text(b.room,'Аудитория',100);const students=await recipients(db,id,b),examId=old?.id||'EX-'+crypto.randomUUID();
    await checkSlot(db,slotConflict(c.teacher_id,b,students,examId));
    const data={...(old?json(old.data):{}),exam_id:examId,subject_id:id,subject_name:c.name,date:b.date,start_time:b.start_time,end_time:b.end_time,room:text(b.room,'Аудитория',100),timezone:'Europe/Moscow',status:'scheduled',exam_type:json(c.details).assessment_type};
    const previous=old?(await all(db,'SELECT student_id FROM exam_students WHERE exam_id=?',[examId])).map(x=>x.student_id):[];
    const writes=[old?stmt(db,'UPDATE exams SET date=?,data=?,version=version+1 WHERE id=? AND version=?',[b.date,JSON.stringify(data),examId,old.version]):stmt(db,'INSERT INTO exams(id,subject_id,date,data) VALUES(?,?,?,?)',[examId,id,b.date,JSON.stringify(data)]),slotAudit(db,user,'exam',examId,now,old?json(old.data):null,data,slotConflict(c.teacher_id,b,students,examId)),stmt(db,'DELETE FROM exam_students WHERE exam_id=?',[examId]),...students.map(s=>stmt(db,'INSERT INTO exam_students(id,exam_id,student_id) VALUES(?,?,?)',[s+'__'+examId,examId,s]))];
    writes.push(stmt(db,"UPDATE notifications SET expires_at=? WHERE kind='reminder' AND json_extract(data,'$.exam_id')=?",[now,examId]));
    for(const student of previous)writes.push(stmt(db,'UPDATE notifications SET expires_at=? WHERE id=?',[now,'reminder:'+student+'__'+examId]));
    for(const student of new Set([...students,...previous])){
      writes.push(stmt(db,'INSERT INTO notifications(id,user_id,kind,published_at,data) VALUES(?,?,?,?,?)',[random(),student,'schedule',now,JSON.stringify({title:'Аттестация обновлена',body:students.includes(student)?`${c.name}: ${dateRu(b.date)}, ${b.start_time} · ${b.room}`:`${c.name}: изменен состав участников аттестации.`,route:'subject/'+id})]));
      if(students.includes(student))writes.push(stmt(db,'INSERT INTO notifications(id,user_id,kind,published_at,expires_at,data) VALUES(?,?,?,?,?,?)',[random(),student,'reminder',new Date(Date.parse(`${b.date}T${b.start_time}:00+03:00`)-86400000).toISOString(),new Date(`${b.date}T${b.end_time}:00+03:00`).toISOString(),JSON.stringify({exam_id:examId,title:'Завтра аттестация',body:`${c.name}, ${b.start_time} · ${b.room}`,route:'subject/'+id})]));
    }
    await guardedBatch(db,writes);
    return {status:old?200:201,data:{saved:true,id:examId}};
  }
  return null;
}
