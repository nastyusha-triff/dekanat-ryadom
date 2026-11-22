import {all,one,run,stmt,json} from './db.mjs';
import {assert,HttpError,body,digest,random,equal,verifyPassword,validDate,moscowDate} from './security.mjs';
import {courseForecast,courseJournalScenario} from './forecast.mjs';
import {requestTypes,currentTransfers,nextSteps,dateRu,transferText} from './student-services.mjs';
import {courseGrades} from './grading.mjs';
import {seed} from './seed.mjs';
import {management} from './management.mjs';

const ISO = value => new Date(value).toISOString();
const parseData = r => r?{...json(r.data),id:r.id,...(r.display_number?{number:r.display_number}:{}),...(r.version?{version:r.version}:{})}:null;
const page = url => ({limit:Math.max(1,Math.min(50,Number(url.searchParams.get('limit'))||20)),offset:Math.max(0,Math.min(100000,Math.floor(Number(url.searchParams.get('offset'))||0)))});
const list = (items,limit) => ({items:items.slice(0,limit),has_more:items.length>limit});
const response = (data,status=200,headers={}) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}});
const cookieName = request => new URL(request.url).protocol==='https:'?'__Host-portal_sid':'portal_sid';
const cookie = (request,value,seconds) => `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${new URL(request.url).protocol==='https:'?'; Secure':''}`;
const role = (user,expected) => assert(user.role===expected||expected==='teacher'&&user.role==='deanery',403,'Доступ запрещен.');
const publicUser = user => ({...json(user.profile),id:user.id,username:user.username,role:user.role,profile_version:user.profile_version});

async function course(db,user,id,studentId=null){
  const c=await one(db,'SELECT * FROM subjects WHERE id=?',[id]);
  assert(c,404,'Дисциплина недоступна.');
  if(['teacher','deanery'].includes(user.role)){if(user.role==='teacher')assert(c.teacher_id===user.id,403,'Нет доступа к этой дисциплине.');}
  else {role(user,'student');assert(!studentId||studentId===user.id,403,'Доступ запрещен.');studentId=user.id;}
  if(studentId)assert(await one(db,'SELECT 1 FROM enrollments WHERE subject_id=? AND student_id=?',[id,studentId]),404,'Студент не записан на дисциплину.');
  return c;
}
const requestTransitions={submitted:['in_progress','needs_info','ready','closed'],in_progress:['needs_info','ready','closed'],needs_info:['in_progress','ready','closed'],ready:['closed','in_progress'],closed:['in_progress']};
async function ownedRequest(db,user,id){
  assert(['student','deanery'].includes(user.role),403,'Доступ запрещен.');
  const r=await one(db,'SELECT * FROM requests WHERE id=?'+(user.role==='student'?' AND student_id=?':''),user.role==='student'?[id,user.id]:[id]);
  assert(r,404,'Заявка недоступна.');
  const student=user.role==='deanery'?await one(db,'SELECT profile FROM users WHERE id=?',[r.student_id]):null;
  return {...json(r.data),id:r.id,number:r.display_number,status:r.status,version:r.version,updated_at:r.updated_at,...(student?{student:json(student.profile),allowed_statuses:[r.status,...requestTransitions[r.status]]}:{})};
}

async function currentSession(db,request,now){
  const token=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName(request)+'='))?.split('=')[1];
  if(!token)return null;
  return one(db,'SELECT u.*,s.csrf,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',[await digest(token),now]);
}
const notifyStmt=(db,id,userId,kind,now,title,message,route)=>stmt(db,'INSERT INTO notifications(id,user_id,kind,published_at,data) VALUES(?,?,?,?,?)',[id,userId,kind,now,JSON.stringify({title,body:message,route})]);

function fields(schema,input){
  assert(input && typeof input==='object' && !Array.isArray(input),400,'Заполните поля формы.');
  const output={};
  for(const f of schema){
    try {
    let value=input[f.key]??f.default??'';
    assert(typeof value==='string'||typeof value==='number',400,`Проверьте поле «${f.label}».`);
    value=String(value).trim();
    assert(!f.required||value.length>0,400,`Заполните поле «${f.label}».`);
    assert(value.length<=Math.min(f.max_length||2000,4000),400,`Слишком длинное поле «${f.label}».`);
    if(value&&f.type==='select')assert(f.options.some(o=>o.value===value),400,`Выберите значение «${f.label}».`);
    if(value&&f.type==='email')assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),400,'Проверьте адрес почты.');
    if(value&&f.type==='tel')assert(/^[+()\d\s-]{5,30}$/.test(value),400,'Проверьте телефон.');
    if(value&&f.type==='date')assert(validDate(value),400,'Проверьте дату.');
    if(value&&f.type==='number')assert(Number.isFinite(Number(value))&&(!f.integer||Number.isInteger(Number(value)))&&(f.min===undefined||Number(value)>=f.min)&&(f.max===undefined||Number(value)<=f.max),400,'Проверьте число.');
    output[f.key]=value;
    }catch(e){e.field=f.key;throw e;}
  }
  return output;
}
function idemKey(request){const key=request.headers.get('idempotency-key');assert(key&&/^[\w-]{16,100}$/.test(key),400,'Нужен идентификатор отправки.');return key;}
async function replay(db,userId,key,fingerprint){const old=await one(db,'SELECT * FROM idempotency WHERE user_id=? AND key=?',[userId,key]);if(old)assert(old.fingerprint===fingerprint,409,'Этот идентификатор уже использован для другого текста. Повторите отправку с новым идентификатором.');return old;}

async function schedule(db,user,from,to,limit=51,offset=0,params=new URLSearchParams()){
  const filter=user.role==='deanery'?'1=1':user.role==='student'?'EXISTS (SELECT 1 FROM lesson_students ls WHERE ls.lesson_id=l.id AND ls.student_id=?)':'s.teacher_id=?';
  const conditions=[],args=[];
  for(const key of ['course','academic_group','language_group','faculty','program','track_names']){
    const value=params.get(key);if(!value)continue;
    assert(user.role!=='student',403,'Фильтры групп доступны преподавателю и деканату.');
    assert(value.length<=200,400,'Слишком длинное значение фильтра.');
    conditions.push(key==='track_names'?"instr('|'||json_extract(u.profile,'$.track_names')||'|','|'||?||'|')>0":`CAST(json_extract(u.profile,'$.${key}') AS TEXT)=?`);args.push(value);
  }
  const extra=conditions.length?` AND EXISTS(SELECT 1 FROM lesson_students ls JOIN users u ON u.id=ls.student_id WHERE ls.lesson_id=l.id AND ${conditions.join(' AND ')})`:'';
  return (await all(db,`SELECT l.data,t.profile AS teacher FROM lessons l JOIN subjects s ON s.id=l.subject_id JOIN users t ON t.id=s.teacher_id WHERE ${filter} AND l.date>=? AND l.date<=?${extra} ORDER BY l.date,json_extract(l.data,'$.start_time'),l.id LIMIT ? OFFSET ?`,[...(user.role==='deanery'?[]:[user.id]),from,to,...args,limit,offset])).map(r=>({...json(r.data),teacher:json(r.teacher).full_name}));
}
async function exams(db,user,limit=51,offset=0,from='0000-01-01'){
  const filter=user.role==='deanery'?'1=1':user.role==='student'?'EXISTS (SELECT 1 FROM exam_students es WHERE es.exam_id=e.id AND es.student_id=?)':'s.teacher_id=?';
  return (await all(db,`SELECT e.data,t.profile AS teacher FROM exams e JOIN subjects s ON s.id=e.subject_id JOIN users t ON t.id=s.teacher_id WHERE ${filter} AND e.date>=? ORDER BY e.date,json_extract(e.data,'$.start_time'),e.id LIMIT ? OFFSET ?`,[...(user.role==='deanery'?[]:[user.id]),from,limit,offset])).map(r=>({...json(r.data),teacher:json(r.teacher).full_name}));
}
async function announcements(db,user,now,limit=21,offset=0){return (await all(db,"SELECT a.* FROM announcements a JOIN announcement_users u ON u.announcement_id=a.id WHERE u.user_id=? AND a.published_at<=? AND (a.expires_at IS NULL OR a.expires_at>?) ORDER BY json_extract(a.data,'$.pinned') DESC,a.published_at DESC LIMIT ? OFFSET ?",[user.id,now,now,limit,offset])).map(parseData);}

export async function updateRequest(db,id,input,now,actor='Деканат'){
  const row=await one(db,'SELECT * FROM requests WHERE id=?',[id]);assert(row,404,'Заявка не найдена.');
  assert(input.status===row.status||requestTransitions[row.status]?.includes(input.status),400,'Недопустимый переход статуса.');
  assert(input.version===row.version,409,'Заявка уже обновлена. Прочитайте ее заново.');
  assert(typeof input.response==='string'&&input.response.trim().length>0&&input.response.length<=4000,400,'Укажите ответ до 4000 символов.');
  assert(typeof input.next_action==='string'&&input.next_action.trim().length>0&&input.next_action.length<=1000,400,'Укажите следующий шаг.');
  assert(!input.expected_ready_date||validDate(input.expected_ready_date),400,'Проверьте срок.');
  for(const k of ['pickup_location','pickup_hours','required_clarification','delivery_method'])assert(input[k]===undefined||typeof input[k]==='string'&&input[k].length<=1000,400,'Проверьте поля получения.');
  const r={...json(row.data),status:input.status,response:input.response.trim(),next_action:input.next_action.trim(),updated_at:now};
  for(const key of ['expected_ready_date','pickup_location','pickup_hours','required_clarification','delivery_method'])if(input[key]!==undefined)r[key]=input[key];
  assert(['pickup','portal'].includes(r.delivery_method),400,'Неизвестный способ получения.');
  if(r.status==='needs_info'){assert(r.required_clarification,400,'Укажите нужное уточнение.');r.clarification_fields=[{key:'reply',label:r.required_clarification,type:'textarea',required:true,max_length:2000}];}
  if(r.status==='ready'){r.ready_at=now;assert(r.delivery_method!=='pickup'||r.pickup_location&&r.pickup_hours,400,'Укажите место и часы выдачи.');}
  if(r.status==='closed')r.closed_at=now;else delete r.closed_at;
  r.delivery_label=r.delivery_method==='pickup'?'Личное получение':'Ответ в портале';
  const event=random();
  // CAS guard is the first write. A failed guard rolls the entire batch back via a NOT NULL violation.
  await db.batch([
    stmt(db,'UPDATE requests SET status=?,updated_at=?,data=?,version=version+1 WHERE id=? AND version=?',[r.status,now,JSON.stringify(r),id,input.version]),
    stmt(db,"INSERT INTO request_history(id,request_id,occurred_at,status,message,actor) VALUES(?,CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?,?,?)",[event,id,now,r.status,r.response,actor]),
    notifyStmt(db,random(),row.student_id,'request',now,r.title,r.response,'request/'+id)
  ]).catch(()=>{throw new HttpError(409,'Заявка уже обновлена. Прочитайте ее заново.');});
  return {...r,version:input.version+1};
}

export async function handleApi(request,env){
  const db=env.DB,url=new URL(request.url),path=url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent),method=request.method;
  // The clock can only be injected by an isolated test harness; HTTP parameters are ignored.
  const now=env.TEST_MODE===true&&typeof env.testNow==='function'?ISO(env.testNow()):new Date().toISOString();
  if(path[0]==='health'&&method==='GET'){await one(db,'SELECT 1 FROM meta LIMIT 1');return response({ok:true});}
  if(path[0]==='admin'){
    assert(env.ADMIN_TOKEN&&equal(request.headers.get('authorization'),`Bearer ${env.ADMIN_TOKEN}`),403,'Служебный доступ запрещен.');
    if(path[1]==='seed'&&method==='POST'){assert(env.SEED_DATA,503,'Seed не включен в сборку.');return response(await seed(db,env.SEED_DATA,now));}
    if(path[1]==='requests'&&path[2]){
      if(method==='GET')return response(await one(db,'SELECT * FROM requests WHERE id=?',[path[2]]));
      if(method==='PATCH')return response(await updateRequest(db,path[2],await body(request),now));
    }
    throw new HttpError(404,'Операция не найдена.');
  }
  if(!['GET','HEAD','OPTIONS'].includes(method))assert(request.headers.get('origin')===url.origin&&request.headers.get('sec-fetch-site')!=='cross-site',403,'Запрос с другого сайта запрещен.');
  if(['accounts','demo'].includes(path[0])&&method==='GET'){const r=await one(db,"SELECT value FROM meta WHERE key='demo_accounts'");return response({accounts:r?json(r.value):[]});}
  if(path[0]==='login'&&method==='POST'){
    const b=await body(request);assert(typeof b.username==='string'&&b.username.length<=100&&typeof b.password==='string'&&b.password.length<=200,400,'Введите логин и пароль.');
    const username=b.username.trim(),ip=request.headers.get('cf-connecting-ip')||env.CLIENT_IP||'local';
    const keys=await Promise.all(['account:'+username,'ip:'+ip].map(digest));
    for(const [i,key] of keys.entries()){
      await run(db,'INSERT INTO login_attempts(key,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN expires_at<=? THEN 1 ELSE attempts+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END',[key,ISO(Date.parse(now)+15*60000),now,now]);
      const a=await one(db,'SELECT attempts FROM login_attempts WHERE key=?',[key]);assert(a.attempts<=(i?60:12),429,'Слишком много попыток. Попробуйте через 15 минут.');
    }
    const u=await one(db,'SELECT * FROM users WHERE username=?',[username]);
    const fallback=await one(db,'SELECT password_hash FROM users LIMIT 1');
    const correct=await verifyPassword(b.password,u?.password_hash||fallback?.password_hash||'pbkdf2$600000$00000000000000000000000000000000$');
    assert(u&&correct,401,'Неверный логин или пароль.');
    const token=random(),csrf=random();
    await db.batch([stmt(db,'DELETE FROM sessions WHERE expires_at<=?',[now]),stmt(db,'INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)',[await digest(token),u.id,csrf,ISO(Date.parse(now)+12*3600000)]),stmt(db,'DELETE FROM login_attempts WHERE key=?',[keys[0]])]);
    return response({user:publicUser(u),csrf},200,{'Set-Cookie':cookie(request,token,43200)});
  }
  const user=await currentSession(db,request,now);assert(user,401,'Войдите в кабинет.');
  if(!['GET','HEAD'].includes(method))assert(equal(request.headers.get('x-csrf-token'),user.csrf),403,'Защитный токен устарел. Обновите страницу.');
  const {limit,offset}=page(url);
  const managed=await management(request,{db,user,path,now,url});if(managed)return response(managed.data,managed.status||200);
  if(path[0]==='deanery'&&path[1]==='overview'&&method==='GET'){role(user,'deanery');return response({counts:await all(db,'SELECT status,count(*) AS count FROM requests GROUP BY status'),students:(await one(db,"SELECT count(*) AS n FROM users WHERE role='student'")).n});}
  if(path[0]==='session'&&method==='GET'){
    const [ui,range,unread]=await Promise.all([one(db,"SELECT value FROM meta WHERE key='ui'"),one(db,"SELECT value FROM meta WHERE key='schedule_range'"),one(db,'SELECT count(*) AS n FROM notifications n LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=? WHERE n.user_id=? AND r.read_at IS NULL AND n.published_at<=? AND (n.expires_at IS NULL OR n.expires_at>?)',[user.id,user.id,now,now])]);
    return response({user:publicUser(user),csrf:user.csrf,now,today:moscowDate(now),ui:{...json(ui.value),request_types:requestTypes},schedule_range:json(range.value),unread:unread.n});
  }
  if(path[0]==='logout'&&method==='POST'){await run(db,'DELETE FROM sessions WHERE token_hash=?',[user.token_hash]);return response({ok:true},200,{'Set-Cookie':cookie(request,'',0)});}
  if(path[0]==='home'&&method==='GET'){
    const today=moscowDate(now),future=await schedule(db,user,today,'9999-12-31',150),next=future.find(l=>Date.parse(`${l.date}T${l.end_time}:00+03:00`)>Date.parse(now));
    const requestRows=user.role==='student'?await all(db,"SELECT * FROM requests WHERE student_id=? AND status IN ('ready','needs_info') ORDER BY julianday(updated_at) DESC LIMIT 2",[user.id]):[];
    const changes=await currentTransfers(db,user,now),examRows=await exams(db,user,1000,0,today);
    return response({next:next||null,remaining_today:future.filter(l=>l.date===today&&Date.parse(`${l.date}T${l.end_time}:00+03:00`)>Date.parse(now)),today_lessons:future.filter(l=>l.date===today).length,actions:requestRows.map(parseData),next_steps:await nextSteps(db,user,now,next,changes,examRows),changes:changes.slice(0,2),changes_total:changes.length,exams:examRows,announcements:await announcements(db,user,now,2)});
  }
  if(path[0]==='changes'&&method==='GET'){const changes=await currentTransfers(db,user,now);return response({...list(changes.slice(offset,offset+limit+1),limit),total:changes.length});}
  if(path[0]==='schedule'&&path[1]==='options'&&method==='GET'){
    role(user,'teacher');
    const rows=await all(db,`SELECT DISTINCT u.profile FROM users u JOIN enrollments e ON e.student_id=u.id JOIN subjects s ON s.id=e.subject_id WHERE ${user.role==='deanery'?'1=1':'s.teacher_id=?'}`,user.role==='deanery'?[]:[user.id]);
    const profiles=rows.map(r=>json(r.profile)),options={};
    for(const key of ['course','academic_group','language_group','faculty','program','track_names'])options[key]=[...new Set(profiles.flatMap(p=>key==='track_names'?String(p[key]||'').split('|'):[String(p[key]||'')]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru',{numeric:true}));
    return response(options);
  }
  if(path[0]==='schedule'&&!path[1]&&method==='GET'){
    const from=url.searchParams.get('from')||moscowDate(now),to=url.searchParams.get('to')||from;
    assert(validDate(from)&&validDate(to)&&to>=from&&(Date.parse(to)-Date.parse(from))<=6*86400000,400,'Выберите период до семи дней.');
    const changes=new Map((await currentTransfers(db,user,now,{future:false})).map(c=>[c.lesson_id,c]));return response({...list((await schedule(db,user,from,to,limit+1,offset,url.searchParams)).map(l=>({...l,transfer:changes.get(l.lesson_id)||null})),limit),from,to});
  }
  if(path[0]==='lessons'&&path[1]&&method==='GET'){
    const l=await one(db,'SELECT * FROM lessons WHERE id=?',[path[1]]);assert(l,404,'Занятие недоступно.');await course(db,user,l.subject_id);
    if(user.role==='student')assert(await one(db,'SELECT 1 FROM lesson_students WHERE lesson_id=? AND student_id=?',[l.id,user.id]),404,'Занятие недоступно.');
    const t=await one(db,'SELECT u.profile FROM users u JOIN subjects s ON s.teacher_id=u.id WHERE s.id=?',[l.subject_id]);
    return response({...parseData(l),editable:user.role!=='student'&&Date.parse(`${l.date}T${json(l.data).end_time}:00+03:00`)>Date.parse(now),...(user.role!=='student'?{student_ids:(await all(db,'SELECT student_id FROM lesson_students WHERE lesson_id=?',[l.id])).map(r=>r.student_id)}:{}),teacher:json(t.profile),changes:await currentTransfers(db,user,now,{future:false,lessonId:l.id})});
  }
  if(path[0]==='courses'&&method==='GET'&&!path[1]){
    const q=(url.searchParams.get('q')||'').slice(0,100),filter=user.role==='deanery'?'1=1':user.role==='student'?'EXISTS (SELECT 1 FROM enrollments e WHERE e.subject_id=s.id AND e.student_id=?)':'s.teacher_id=?';
    const rows=await all(db,`SELECT s.* FROM subjects s WHERE ${filter} AND s.name LIKE ? ORDER BY s.name LIMIT ? OFFSET ?`,[...(user.role==='deanery'?[]:[user.id]),'%'+q+'%',limit+1,offset]);
    const output=[];
    for(const c of rows.slice(0,limit)){const r={id:c.id,name:c.name,...json(c.details)};if(user.role==='student'){const grades=await courseGrades(db,user.id,c.id,now,{limit:0});r.summary=grades.summary;r.exam=grades.exam;}else r.students=(await one(db,'SELECT count(*) AS n FROM enrollments WHERE subject_id=?',[c.id])).n;output.push(r);}
    return response({items:output,has_more:rows.length>limit});
  }
  if(path[0]==='courses'&&path[1]){
    const id=path[1];
    if(!path[2]&&method==='GET'){const c=await course(db,user,id),t=await one(db,'SELECT profile FROM users WHERE id=?',[c.teacher_id]);return response({...json(c.details),id,name:c.name,version:c.version,teacher:json(t.profile)});}
    if(path[2]==='students'&&method==='GET'){role(user,'teacher');await course(db,user,id);const rows=await all(db,'SELECT u.id,u.profile FROM users u JOIN enrollments e ON e.student_id=u.id WHERE e.subject_id=? ORDER BY json_extract(u.profile,\'$.full_name\') LIMIT ? OFFSET ?',[id,limit+1,offset]);return response(list(rows.map(r=>({id:r.id,full_name:json(r.profile).full_name,academic_group:json(r.profile).academic_group})),limit));}
    if(path[2]==='forecast'&&['GET','POST'].includes(method)){role(user,'student');await course(db,user,id,user.id);return response(await courseForecast(db,user.id,id,now,method==='POST'?(await body(request)).assumptions||{}:{}));}
    if((path[2]==='journal'&&method==='GET')||(path[2]==='scenario'&&['GET','POST'].includes(method))){
      const studentId=user.role==='student'?user.id:url.searchParams.get('student_id');
      if(user.role==='student'&&url.searchParams.has('student_id'))assert(url.searchParams.get('student_id')===user.id,403,'Доступ запрещен.');
      assert(studentId,400,'Выберите студента.');await course(db,user,id,studentId);
      if(path[2]==='scenario')return response(await courseJournalScenario(db,studentId,id,now,method==='POST'?(await body(request)).assumptions??{}:{},user.role!=='student'));
      const p=await one(db,'SELECT profile FROM users WHERE id=?',[studentId]);
      return response({...await courseGrades(db,studentId,id,now,{teacher:user.role!=='student',limit,offset}),student:{id:studentId,full_name:json(p.profile).full_name}});
    }
    if(path[2]==='grades'&&path[3]&&path[4]){
      role(user,'teacher');const studentId=path[3],assignmentId=path[4];await course(db,user,id,studentId);
      const a=await one(db,'SELECT * FROM assignments WHERE id=? AND subject_id=?',[assignmentId,id]);assert(a,404,'Работа не найдена.');
      if(path[5]==='history'&&method==='GET'){const history=await all(db,'SELECT h.*,u.profile FROM grade_history h JOIN users u ON u.id=h.actor_id WHERE student_id=? AND assignment_id=? ORDER BY occurred_at DESC LIMIT ? OFFSET ?',[studentId,assignmentId,limit+1,offset]);return response(list(history.map(h=>({id:h.id,occurred_at:h.occurred_at,actor:json(h.profile).full_name,old:json(h.old_data),new:json(h.new_data)})),limit));}
      if(method==='PUT'&&!path[5]){
        const b=await body(request),maximum=Number(json(a.data).max_score);
        assert(b.score===null||typeof b.score==='number'&&Number.isFinite(b.score)&&b.score>=0&&b.score<=maximum,400,`Оценка должна быть от 0 до ${maximum}.`);
        assert(typeof b.feedback==='string'&&b.feedback.length<=2000,400,'Комментарий должен быть не длиннее 2000 символов.');
        assert(Number.isInteger(b.version)&&b.version>=0,400,'Нужна версия оценки.');
        assert(!b.published_at||typeof b.published_at==='string'&&!isNaN(Date.parse(b.published_at)),400,'Проверьте дату публикации.');
        const r=await one(db,'SELECT * FROM results WHERE student_id=? AND assignment_id=?',[studentId,assignmentId]);
        assert((r?.version||0)===b.version,409,'Оценка уже изменена. Обновите журнал и сравните значения; ваш текст сохранен.');
        const published=b.score===null?null:b.published_at&&Date.parse(b.published_at)>Date.parse(now)?ISO(b.published_at):now;
        const next={score:b.score,status:b.score===null?(r?.submitted_at||r?.status==='submitted'?'submitted':'not_submitted'):'graded',feedback:b.feedback.trim(),graded_at:published,version:b.version+1};
        const write=r?stmt(db,'UPDATE results SET score=?,status=?,feedback=?,graded_at=?,changed_at=?,version=version+1 WHERE student_id=? AND assignment_id=? AND version=?',[next.score,next.status,next.feedback,next.graded_at,now,studentId,assignmentId,b.version]):stmt(db,'INSERT INTO results(student_id,assignment_id,score,status,feedback,graded_at,changed_at,version) VALUES(?,?,?,?,?,?,?,1)',[studentId,assignmentId,next.score,next.status,next.feedback,next.graded_at,now]);
        await db.batch([write,stmt(db,'INSERT INTO grade_history(id,student_id,assignment_id,actor_id,occurred_at,old_data,new_data) VALUES(?,CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?,?,?,?)',[random(),studentId,assignmentId,user.id,now,JSON.stringify(r?{score:r.score,feedback:r.feedback,graded_at:r.graded_at,version:r.version}:null),JSON.stringify(next)])]).catch(()=>{throw new HttpError(409,'Оценка уже изменена. Обновите журнал; ваш текст сохранен.');});
        await courseGrades(db,studentId,id,now);
        return response({saved:true,version:next.version});
      }
    }
  }
  if(path[0]==='exams'&&method==='GET')return response(list(await exams(db,user,limit+1,offset),limit));
  if(path[0]==='requests'){
    assert(['student','deanery'].includes(user.role),403,'Доступ запрещен.');
    if(user.role==='deanery'&&!path[1]&&method==='GET'){
      const state=url.searchParams.get('status')||'all',q=(url.searchParams.get('q')||'').slice(0,100);
      const condition=state==='active'?" AND r.status<>'closed'":Object.hasOwn(requestTransitions,state)?' AND r.status=?':'';
      const args=Object.hasOwn(requestTransitions,state)?[state]:[];
      const rows=await all(db,"SELECT r.*,u.profile FROM requests r JOIN users u ON u.id=r.student_id WHERE 1=1"+condition+" AND (json_extract(u.profile,'$.full_name') LIKE ? OR json_extract(r.data,'$.title') LIKE ? OR r.id LIKE ? OR printf('%04d',r.display_number) LIKE ?) ORDER BY julianday(r.updated_at) DESC,r.id LIMIT ? OFFSET ?",[...args,'%'+q+'%','%'+q+'%','%'+q+'%','%'+q.replace(/^№\s*/, '')+'%',limit+1,offset]);
      return response(list(rows.map(r=>({...parseData(r),student:json(r.profile)})),limit));
    }
    if(!path[1]&&method==='GET'){const state=url.searchParams.get('status'),args=[user.id],condition=state==='active'?" AND status<>'closed'":state==='closed'?" AND status='closed'":'';return response(list((await all(db,'SELECT * FROM requests WHERE student_id=?'+condition+' ORDER BY julianday(updated_at) DESC LIMIT ? OFFSET ?',[...args,limit+1,offset])).map(parseData),limit));}
    if(!path[1]&&method==='POST'){
      role(user,'student');
      const b=await body(request),ui=json((await one(db,"SELECT value FROM meta WHERE key='ui'")).value),type=requestTypes.find(t=>t.id===b.type);assert(type,400,'Выберите тип обращения.');
      const values=fields(type.fields,b.fields),key=idemKey(request),fingerprint=await digest(JSON.stringify({type:b.type,values}));
      const old=await replay(db,user.id,key,fingerprint);if(old)return response(await ownedRequest(db,user,old.object_id));
      const id='REQ-'+crypto.randomUUID(),r={request_id:id,student_id:user.id,request_type:type.id,title:type.label,...values,description:values.description||type.fields.map(f=>f.label+': '+(f.options?.find(o=>o.value===values[f.key])?.label||values[f.key])).join('\n'),student_snapshot:((p)=>({full_name:p.full_name,academic_group:p.academic_group,course:p.course,email:p.email}))(json(user.profile)),fields:values,status:'submitted',created_at:now,updated_at:now,expected_ready_date:'',next_action:'Ожидайте принятия обращения в работу. Срок появится после проверки.',response:'Обращение зарегистрировано.',delivery_method:'portal',delivery_label:'Способ получения сообщит деканат',pickup_location:'',pickup_hours:'',clarification_fields:[],links:[]};
      try{await db.batch([stmt(db,'INSERT INTO idempotency(user_id,key,fingerprint,object_id) VALUES(?,?,?,?)',[user.id,key,fingerprint,id]),stmt(db,'INSERT INTO requests(id,student_id,status,updated_at,data) VALUES(?,?,?,?,?)',[id,user.id,r.status,now,JSON.stringify(r)]),stmt(db,"INSERT INTO request_history(id,request_id,occurred_at,status,message,actor) VALUES(?,?,?,?,?,'Студент')",[random(),id,now,r.status,r.description]),notifyStmt(db,random(),user.id,'request',now,r.title,r.response,'request/'+id)]);}catch(e){const replayed=await replay(db,user.id,key,fingerprint);if(replayed)return response(await ownedRequest(db,user,replayed.object_id));throw e;}
      return response(await ownedRequest(db,user,id),201);
    }
    if(path[1]){
      const r=await ownedRequest(db,user,path[1]);
      if(!path[2]&&method==='GET')return response(r);
      if(!path[2]&&method==='PATCH'){role(user,'deanery');return response(await updateRequest(db,r.id,await body(request),now,publicUser(user).full_name+' · Деканат'));}
      if(path[2]==='history'&&method==='GET')return response(list(await all(db,'SELECT id,occurred_at,status,message,actor FROM request_history WHERE request_id=? ORDER BY julianday(occurred_at) DESC,id LIMIT ? OFFSET ?',[r.id,limit+1,offset]),limit));
      if(path[2]==='reply'&&method==='POST'){
        role(user,'student');
        const b=await body(request),key=idemKey(request);const previous=await one(db,'SELECT * FROM idempotency WHERE user_id=? AND key=?',[user.id,key]);if(previous){assert(previous.object_id===r.id&&previous.fingerprint===await digest(JSON.stringify({request:r.id,values:b.fields})),409,'Этот идентификатор уже использован.');return response({saved:true});}assert(r.status==='needs_info',409,'Сейчас уточнение не требуется.');const values=fields(r.clarification_fields,b.fields),fingerprint=await digest(JSON.stringify({request:r.id,values}));
        const old=await replay(db,user.id,key,fingerprint);if(old)return response({saved:true});
        const message=Object.entries(values).map(([k,v])=>(r.clarification_fields.find(f=>f.key===k)?.label||k)+': '+v).join('\n');
        const next={...r,status:'in_progress',clarification_fields:[],next_action:'Уточнение отправлено. Ожидайте ответа деканата.',updated_at:now};
        try{await db.batch([stmt(db,'INSERT INTO idempotency(user_id,key,fingerprint,object_id) VALUES(?,?,?,?)',[user.id,key,fingerprint,r.id]),stmt(db,"UPDATE requests SET status='in_progress',data=?,updated_at=?,version=version+1 WHERE id=? AND version=?",[JSON.stringify(next),now,r.id,r.version]),stmt(db,"INSERT INTO request_history(id,request_id,occurred_at,status,message,actor) VALUES(?,CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?,?,'Студент')",[random(),r.id,now,next.status,message]),notifyStmt(db,random(),user.id,'request',now,r.title,'Уточнение доставлено в деканат.','request/'+r.id)]);}catch(e){if(await replay(db,user.id,key,fingerprint))return response({saved:true});throw new HttpError(409,'Обращение обновлено. Откройте его заново; текст сохранен.');}
        return response({saved:true});
      }
    }
  }
  if(path[0]==='notifications'){
    if(!path[1]&&method==='GET'){const rows=await all(db,'SELECT n.*,r.read_at FROM notifications n LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=? WHERE n.user_id=? AND n.published_at<=? AND (n.expires_at IS NULL OR n.expires_at>?) ORDER BY n.published_at DESC,n.id LIMIT ? OFFSET ?',[user.id,user.id,now,now,limit+1,offset]);const transfers=new Map((await currentTransfers(db,user,now,{future:false})).map(c=>[c.lesson_id,c]));return response(list(rows.map(r=>{const n=parseData(r),c=n.route?.startsWith('lesson/')?transfers.get(n.route.slice(7)):null;return {...n,body:c?c.subject_name+'. '+transferText(c):n.body?.replace(/\b\d{4}-\d{2}-\d{2}\b/g,value=>validDate(value)?dateRu(value):value),transfer:c||null,kind:r.kind,published_at:r.published_at,read:!!r.read_at};}),limit));}
    if(path[1]&&path[2]==='read'&&method==='POST'){assert(await one(db,'SELECT 1 FROM notifications WHERE id=? AND user_id=? AND published_at<=? AND (expires_at IS NULL OR expires_at>?)',[path[1],user.id,now,now]),404,'Уведомление недоступно.');await run(db,'INSERT OR IGNORE INTO notification_reads(user_id,notification_id,read_at) VALUES(?,?,?)',[user.id,path[1],now]);return response({read:true});}
  }
  if(path[0]==='announcements'&&method==='GET'){
    if(!path[1])return response(list(await announcements(db,user,now,limit+1,offset),limit));
    const a=await one(db,'SELECT a.* FROM announcements a JOIN announcement_users u ON u.announcement_id=a.id WHERE a.id=? AND u.user_id=? AND a.published_at<=? AND (a.expires_at IS NULL OR a.expires_at>?)',[path[1],user.id,now,now]);assert(a,404,'Объявление недоступно.');return response(parseData(a));
  }
  throw new HttpError(404,'Страница или операция недоступна.');
}

export async function api(request,env){
  try{return await handleApi(request,env);}catch(e){if(!(e instanceof HttpError))console.error('Request failed:',e.message);return response({error:e instanceof HttpError?e.message:'Не удалось выполнить операцию. Попробуйте еще раз.',...(e instanceof HttpError&&e.field?{field:e.field}:{})},e.status||500);}
}
