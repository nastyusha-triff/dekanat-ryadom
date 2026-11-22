import {cleanText} from '../scripts/expanded-fixtures.mjs';
import {all,one,stmt} from './db.mjs';
import {courseGrades} from './grading.mjs';
export async function seed(db,d,now){
  const version=await one(db,"SELECT value FROM meta WHERE key='seed_version'");
  if(version?.value==='2'){await improveContent(db);return {seeded:false};}
  const upgrading=!!version;
  const queries=[];
  const add=(table,values)=>queries.push(stmt(db,`INSERT OR IGNORE INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(()=>'?').join(',')})`,Object.values(values)));
  const encode=JSON.stringify;
  for(const u of d.users)add('users',{id:u.id,username:u.username,role:u.role,password_hash:u.password_hash,profile:encode(u.profile)});
  for(const s of d.subjects){const details=d.catalog.course_details.find(c=>c.subject_id===s.subject_id);add('subjects',{id:s.subject_id,teacher_id:details.teacher_id,name:s.subject_name,details:encode({...s,...details})});}
  const enrollment=new Map();
  for(const s of [...d.grades,...d.schedule,...d.exams])enrollment.set(JSON.stringify([s.student_id,s.subject_id]),{student_id:s.student_id,subject_id:s.subject_id});
  for(const e of enrollment.values())add('enrollments',e);
  for(const s of d.schedule){const {student_id,schedule_id,...lesson}=s;add('lessons',{id:s.lesson_id,subject_id:s.subject_id,date:s.date,data:encode(lesson)});add('lesson_students',{id:schedule_id,lesson_id:s.lesson_id,student_id});}
  for(const e of d.exams){const {student_id,exam_registration_id,...exam}=e;add('exams',{id:e.exam_id,subject_id:e.subject_id,date:e.date,data:encode(exam)});add('exam_students',{id:exam_registration_id,exam_id:e.exam_id,student_id});}
  for(const a of d.assignments)add('assignments',{id:a.assignment_id,subject_id:a.subject_id,sort_order:Number(a.sort_order),data:encode(a)});
  for(const r of d.assignment_results)add('results',{student_id:r.student_id,assignment_id:r.assignment_id,score:r.score===''?null:Number(r.score),status:r.status,submitted_at:r.submitted_at||null,graded_at:r.graded_at||null,feedback:r.feedback,version:1});
  for(const r of d.grading_rules)add('rules',{id:r.rule_id,subject_id:r.subject_id,sort_order:Number(r.sort_order),data:encode(r)});
  for(const r of d.rule_publications)add('rule_publications',r);
  for(const r of d.catalog.requests)add('requests',{id:r.request_id,student_id:r.student_id,status:r.status,updated_at:r.updated_at,data:encode(r),version:1});
  const notify=(id,user_id,kind,published_at,data,expires_at=null)=>add('notifications',{id,user_id,kind,published_at:new Date(published_at).toISOString(),expires_at:expires_at?new Date(expires_at).toISOString():null,data:encode(data)});
  for(const h of d.request_history){add('request_history',{id:h.history_id,request_id:h.request_id,occurred_at:h.occurred_at,status:h.status,message:h.message,actor:'Деканат'});const r=d.catalog.requests.find(r=>r.request_id===h.request_id);notify('request:'+h.history_id,r.student_id,'request',h.occurred_at,{title:r.title,body:h.message,route:'request/'+r.request_id});}
  for(const c of d.schedule_changes){add('changes',{id:c.change_id,lesson_id:c.lesson_id,announced_at:c.announced_at,data:encode(c)});const users=new Set(c.affected_student_ids.split('|'));users.add(d.catalog.course_details.find(x=>x.subject_id===c.subject_id).teacher_id);for(const id of users)notify('change:'+c.change_id+':'+id,id,'schedule',c.announced_at,{title:'Перенос занятия',body:`${d.subjects.find(s=>s.subject_id===c.subject_id).subject_name}: ${c.new_date}, ${c.new_start_time}`,route:'lesson/'+c.lesson_id});}
  for(const a of d.catalog.announcements){add('announcements',{id:a.announcement_id,published_at:new Date(a.published_at).toISOString(),expires_at:new Date(a.expires_at).toISOString(),data:encode(a)});for(const id of a.student_ids){add('announcement_users',{announcement_id:a.announcement_id,user_id:id});notify('announcement:'+a.announcement_id+':'+id,id,'announcement',a.published_at,{title:a.title,body:a.summary,route:'announcement/'+a.announcement_id},a.expires_at);}}
  for(const e of d.exams){const at=new Date(`${e.date}T${e.start_time}:00+03:00`);at.setUTCDate(at.getUTCDate()-1);notify('reminder:'+e.exam_registration_id,e.student_id,'reminder',at.toISOString(),{title:'Завтра экзамен',body:`${e.subject_name}, ${e.start_time}, ${e.room}`,route:'subject/'+e.subject_id},`${e.date}T${e.end_time}:00+03:00`);}
  add('meta',{key:'ui',value:encode(d.catalog.ui)});add('meta',{key:'schedule_range',value:encode(d.range)});add('meta',{key:'demo_accounts',value:encode(d.demo_accounts)});
  if(upgrading){
    // One-time presentation cleanup; retain existing grades, requests, and course edits.
    for(const [table,column] of [['users','profile'],['subjects','details'],['lessons','data'],['exams','data'],['changes','data'],['requests','data'],['announcements','data'],['notifications','data']]){
      for(const row of await all(db,`SELECT id,${column} AS value FROM ${table}`)){
        const value=JSON.stringify(cleanText(JSON.parse(row.value)));
        if(value!==row.value)queries.push(stmt(db,`UPDATE ${table} SET ${column}=? WHERE id=?`,[value,row.id]));
      }
    }
    for(const row of await all(db,'SELECT id,message,actor FROM request_history')){
      if(cleanText(row.message)!==row.message||cleanText(row.actor)!==row.actor)queries.push(stmt(db,'UPDATE request_history SET message=?,actor=? WHERE id=?',[cleanText(row.message),cleanText(row.actor),row.id]));
    }
    for(const row of await all(db,'SELECT student_id,assignment_id,feedback FROM results'))if(cleanText(row.feedback)!==row.feedback)queries.push(stmt(db,'UPDATE results SET feedback=? WHERE student_id=? AND assignment_id=?',[cleanText(row.feedback),row.student_id,row.assignment_id]));
    for(const c of d.catalog.course_details){
      const previous=await one(db,'SELECT details FROM subjects WHERE id=?',[c.subject_id]);
      if(previous)queries.push(stmt(db,'UPDATE subjects SET details=? WHERE id=?',[JSON.stringify({...c,...cleanText(JSON.parse(previous.details))}),c.subject_id]));
    }
    for(const u of d.users){
      const previous=await one(db,'SELECT username,profile FROM users WHERE id=?',[u.id]);
      if(previous){
        const oldProfile=cleanText(JSON.parse(previous.profile));
        const profile={...u.profile,...Object.fromEntries(Object.entries(oldProfile).filter(([,value])=>value!==''&&value!==null))};
        if(profile.faculty)profile.faculty=profile.faculty.replace(/^факультет/,'Факультет');
        // Extend existing profiles without replacing fields edited by the user.
        queries.push(stmt(db,'UPDATE users SET profile=? WHERE id=?',[JSON.stringify(profile),u.id]));
        if(previous.username.startsWith('demo_'))queries.push(stmt(db,'UPDATE users SET username=?,password_hash=? WHERE id=?',[u.username,u.password_hash,u.id]));
      }
    }
  }
  for(const [key,value] of [['ui',d.catalog.ui],['schedule_range',d.range],['demo_accounts',d.demo_accounts]])queries.push(stmt(db,'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,encode(value)]));
  for(let i=0;i<queries.length;i+=70)await db.batch(queries.slice(i,i+70));
  for(const e of enrollment.values())await courseGrades(db,e.student_id,e.subject_id,now);
  await db.batch([stmt(db,"INSERT INTO meta(key,value) VALUES('seed_version','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value")]);
  await improveContent(db);
  return {seeded:true,users:d.users.length,courses:d.subjects.length,enrollments:enrollment.size};
}

async function improveContent(db){
  if(await one(db,"SELECT 1 FROM meta WHERE key='content_v3'"))return;
  const updates=[];
  for(const row of await all(db,'SELECT id,details FROM subjects')){
    const d=JSON.parse(row.details);d.resources=[{label:'Чат курса',icon:'chat',url:'https://t.me/nastyusha_triff'},{label:'Материалы курса',icon:'book',url:'https://www.google.com/'}];
    updates.push(stmt(db,'UPDATE subjects SET details=? WHERE id=?',[JSON.stringify(d),row.id]));
  }
  for(const [table,column] of [['requests','data'],['notifications','data'],['request_history','message']])updates.push(stmt(db,`UPDATE ${table} SET ${column}=replace(replace(${column},'нстрационная','Учебная'),'нстрационный','предварительный') WHERE ${column} LIKE '%нстрацион%'`));
  for(const row of await all(db,"SELECT * FROM requests WHERE status='needs_info'")){
    const last=await one(db,'SELECT actor FROM request_history WHERE request_id=? ORDER BY julianday(occurred_at) DESC,rowid DESC LIMIT 1',[row.id]);
    if(last?.actor==='Студент'){const r=JSON.parse(row.data);r.status='in_progress';r.clarification_fields=[];r.next_action='Уточнение отправлено. Ожидайте ответа деканата.';updates.push(stmt(db,"UPDATE requests SET status='in_progress',data=?,version=version+1 WHERE id=?",[JSON.stringify(r),row.id]));}
  }
  updates.push(stmt(db,"INSERT INTO meta VALUES('content_v3','1')"));await db.batch(updates);
}
