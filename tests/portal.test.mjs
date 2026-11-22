import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixtures} from '../scripts/fixtures.mjs';
import {seed} from '../server/seed.mjs';
import {localDb,migrate} from '../server/local-db.mjs';
import {dispatch} from '../server/http.mjs';
import {one,all,run} from '../server/db.mjs';
import {calculate,validateGraph,courseGrades} from '../server/grading.mjs';
import {updateRequest} from '../server/api.mjs';

let data,db,env,dir,dbPath,now;
before(async()=>{data=await fixtures();});
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'portal-test-'));dbPath=join(dir,'db.sqlite');db=localDb(dbPath);migrate(db);now='2026-11-21T09:30:00.000Z';env={DB:db,TEST_MODE:true,testNow:()=>now};await seed(db,data,now);});
afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
async function call(path,{auth,method='GET',body,headers={}}={}){
 const h={'Origin':'https://portal.test',...(body?{'Content-Type':'application/json'}:{}),...(auth?{'Cookie':auth.cookie,'X-CSRF-Token':auth.csrf}:{}),...headers};
 const response=await dispatch(new Request('https://portal.test/api/'+path,{method,headers:h,body:body?JSON.stringify(body):undefined}),env,{});
 return {status:response.status,body:await response.json(),headers:response.headers};
}
async function login(username='year1_group1',password='Campus26!A1'){
 const r=await call('login',{method:'POST',body:{username,password}});assert.equal(r.status,200,JSON.stringify(r.body));return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.body.csrf};
}
const login2=()=>login('year2_group2','Campus26!B2');
const login3=()=>login('year2_group3','Campus26!C3');
const loginTeacher=()=>login('teacher1','Teacher26!A1');
const requestBody={type:'academic_transcript',fields:{description:'Нужна выписка для конкурсного показа',document_language:'ru'}};
const withKey=(key='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')=>({'Idempotency-Key':key});

test('Credentials are hashed, invalid login rejected, secure session and logout invalidate access',async()=>{
 const rows=await all(db,'SELECT password_hash FROM users');assert(rows.every(r=>r.password_hash.startsWith('pbkdf2$600000$')));assert(!JSON.stringify(rows).includes('Demo'));
 assert.equal((await call('session')).status,401);
 assert.equal((await call('login',{method:'POST',body:{username:'year1_group1',password:'wrong'}})).status,401);
 const r=await call('login',{method:'POST',body:{username:'year1_group1',password:'Campus26!A1'}});const cookie=r.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);assert.match(cookie,/__Host-/);
 const auth={cookie:cookie.split(';')[0],csrf:r.body.csrf};assert.equal((await call('session',{auth})).body.user.id,'STU-001');
 assert.equal((await call('logout',{auth,method:'POST',body:{}})).status,200);assert.equal((await call('session',{auth})).status,401);
});
test('Session expiry and brute-force limit are enforced',async()=>{
 const auth=await login();now='2026-11-22T09:30:00.000Z';assert.equal((await call('session',{auth})).status,401);
 for(let i=0;i<12;i++)assert.equal((await call('login',{method:'POST',body:{username:'nonexistent',password:'bad'}})).status,401);
 assert.equal((await call('login',{method:'POST',body:{username:'nonexistent',password:'bad'}})).status,429);
});
test('Students receive only their own objects, URL account/time cannot impersonate or reveal the future',async()=>{
 const a=await login(),b=await login2();
 assert.equal((await call('requests/REQ-002',{auth:a})).status,404);
 assert.equal((await call('requests/REQ-001',{auth:b})).status,404);
 assert.equal((await call('courses/Y1-FIN/journal?student_id=STU-002',{auth:a})).status,403);
 assert.equal((await call('courses/Y2-STRATEGY/journal',{auth:a})).status,404);
 const session=(await call('session?account=STU-002&preview=session-complete',{auth:a})).body;
 assert.equal(session.user.id,'STU-001');assert.equal(session.today,'2026-11-21');assert(!JSON.stringify(session).includes('initial_password'));
 const mine=(await call('requests',{auth:a})).body.items;assert(mine.every(r=>r.student_id==='STU-001'));
});
test('Origin and CSRF protect all mutations including login and grade writes',async()=>{
 const auth=await login();
 assert.equal((await call('requests',{auth,method:'POST',body:requestBody,headers:{...withKey(),'Origin':'https://attacker.test'}})).status,403);
 assert.equal((await call('requests',{auth,method:'POST',body:requestBody,headers:{...withKey(),'X-CSRF-Token':'bad'}})).status,403);
 assert.equal((await call('login',{method:'POST',body:{username:'x',password:'x'},headers:{Origin:'https://attacker.test'}})).status,403);
});
test('Teacher authorization uses course assignment and enrollment, grants no student request or admin privileges',async()=>{
 const t=await loginTeacher();assert.equal((await call('session',{auth:t})).body.user.role,'teacher');
 const courses=(await call('courses',{auth:t})).body.items;assert(courses.every(c=>c.teacher_id==='TCH-001'));
 assert.equal((await call('courses/Y1-ENG/journal?student_id=STU-001',{auth:t})).status,403);
 assert.equal((await call('courses/Y1-FIN/journal?student_id=STU-002',{auth:t})).status,404);
 assert.equal((await call('requests/REQ-001',{auth:t})).status,403);assert.equal((await call('admin/requests/REQ-001',{auth:t})).status,403);
 assert.equal((await call('courses/Y1-ENG/grades/STU-001/A-Y1-ENG-01',{auth:t,method:'PUT',body:{score:2,feedback:'',version:1}})).status,403);
});
test('CHG-001 is imported once at its current time, shared lessons/exams do not duplicate for teacher',async()=>{
 const a=await login(),t=await loginTeacher();
 const week=(await call('schedule?from=2026-11-23&to=2026-11-29',{auth:a})).body.items;
 const changed=week.filter(l=>l.change_id==='CHG-001');assert.equal(changed.length,1);assert.equal(changed[0].date,'2026-11-24');assert.equal(changed[0].start_time,'20:30');
 assert(!week.some(l=>l.lesson_id===changed[0].lesson_id&&l.date==='2026-11-23'));
 const teacherLessons=(await call('schedule?from=2026-11-23&to=2026-11-29',{auth:t})).body.items;assert.equal(new Set(teacherLessons.map(l=>l.lesson_id)).size,teacherLessons.length);
 const e=(await call('exams',{auth:t})).body.items;assert.equal(new Set(e.map(x=>x.exam_id)).size,e.length);
 assert.equal((await call('schedule?from=2026-01-01&to=2027-01-01',{auth:a})).status,400);
});
test('Requests validate, idempotent creation survives reload, re-login, SQLite reopen and repeat seed',async()=>{
 const auth=await login();assert.equal((await call('requests',{auth,method:'POST',body:{type:'academic_transcript',fields:{description:'',document_language:'xx'}},headers:withKey()})).status,400);
 const [a,b]=await Promise.all([call('requests',{auth,method:'POST',body:requestBody,headers:withKey()}),call('requests',{auth,method:'POST',body:requestBody,headers:withKey()})]);
 assert([200,201].includes(a.status));assert([200,201].includes(b.status));assert.equal(a.body.request_id,b.body.request_id);
 assert.equal((await one(db,"SELECT count(*) n FROM requests WHERE json_extract(data,'$.description')=?",[requestBody.fields.description])).n,1);
 assert.equal((await call('requests',{auth,method:'POST',body:{...requestBody,fields:{...requestBody.fields,description:'Другой текст'}},headers:withKey()})).status,409);
 assert.equal(a.body.expected_ready_date,'');
 db.close();db=localDb(dbPath);env.DB=db;migrate(db);assert.equal((await seed(db,data,now)).seeded,false);
 const fresh=await login();assert.equal((await call('requests/'+a.body.request_id,{auth:fresh})).body.description,requestBody.fields.description);
});
test('Clarification appends once and returns request to processing',async()=>{
 const auth=await login3(),payload={fields:{organization:'Вымышленный оргкомитет'}};
 const first=await call('requests/REQ-003/reply',{auth,method:'POST',body:payload,headers:withKey()});assert.equal(first.status,200);
 assert.equal((await call('requests/REQ-003/reply',{auth,method:'POST',body:payload,headers:withKey()})).status,200);
 const r=await call('requests/REQ-003',{auth});assert.equal(r.body.status,'in_progress');assert.equal(r.body.expected_ready_date,'2026-11-25');
 const h=(await call('requests/REQ-003/history',{auth})).body.items;assert.equal(h.filter(h=>h.message.includes('Вымышленный оргкомитет')).length,1);
});
test('Service status update is versioned, saves history, notifies and shows delivery information',async()=>{
 const row=await one(db,"SELECT version FROM requests WHERE id='REQ-001'");
 await updateRequest(db,'REQ-001',{status:'ready',version:row.version,response:'Справка готова',next_action:'Заберите справку',pickup_location:'Демо-102',pickup_hours:'10:00–17:00'},now);
 const auth=await login(),r=(await call('requests/REQ-001',{auth})).body;assert.equal(r.status,'ready');assert.equal(r.pickup_hours,'10:00–17:00');
 await assert.rejects(()=>updateRequest(db,'REQ-001',{status:'closed',version:row.version,response:'Закрыта',next_action:'Ответ получен'},now),/обновлена/);
 assert((await call('notifications',{auth})).body.items.some(n=>n.body==='Справка готова'));
});
test('Read state is per user and does not perform request actions; future reminders stay hidden',async()=>{
 const a=await login(),b=await login2(),items=(await call('notifications',{auth:a})).body.items;
 assert(items.length);assert(!items.some(n=>n.kind==='reminder'));
 assert.equal((await call('notifications/'+encodeURIComponent(items[0].id)+'/read',{auth:b,method:'POST',body:{}})).status,404);
 await call('notifications/'+encodeURIComponent(items[0].id)+'/read',{auth:a,method:'POST',body:{}});
 assert((await call('notifications',{auth:a})).body.items.find(n=>n.id===items[0].id).read);
 assert.equal((await call('requests/REQ-004',{auth:a})).body.status,'ready');
});
test('Teacher edit persists, creates audit, recalculates dependent summaries and rejects stale version',async()=>{
 const t=await loginTeacher(),s=await login(),id='A-Y1-FIN-01',path='courses/Y1-FIN/grades/STU-001/'+id;
 const before=(await call('courses/Y1-FIN/journal?limit=50',{auth:s})).body;
 const r=(await call('courses/Y1-FIN/journal?student_id=STU-001',{auth:t})).body.items.find(r=>r.id===id);
 now='2026-11-21T10:30:00.000Z';
 const changed=await call(path,{auth:t,method:'PUT',body:{score:0,feedback:'Опубликованный ноль',version:r.edit.version}});assert.equal(changed.status,200);
 assert.equal((await call(path,{auth:t,method:'PUT',body:{score:5,feedback:'Старая версия',version:r.edit.version}})).status,409);
 const after=(await call('courses/Y1-FIN/journal?limit=50',{auth:s})).body;assert.equal(after.items.find(r=>r.id===id).value,0);
 assert.notEqual(before.summary.find(r=>r.role==='progress').value,after.summary.find(r=>r.role==='progress').value);
 const h=(await call(path+'/history',{auth:t})).body.items;assert.equal(h.length,1);assert.equal(h[0].new.score,0);assert.equal(h[0].actor,'Елена Андреевна Воронцова');
 const again=(await call('courses/Y1-FIN/journal',{auth:s})).body;assert.equal(again.summary[0].published_at,after.summary[0].published_at);
 await seed(db,data,now);assert.equal((await one(db,'SELECT score FROM results WHERE student_id=? AND assignment_id=?',['STU-001',id])).score,0);
});
test('Empty and zero are distinct; grade ranges and student writes are rejected',async()=>{
 const t=await loginTeacher(),s=await login(),path='courses/Y1-FIN/grades/STU-001/A-Y1-FIN-01';
 assert.equal((await call(path,{auth:t,method:'PUT',body:{score:11,feedback:'',version:1}})).status,400);
 assert.equal((await call(path,{auth:s,method:'PUT',body:{score:5,feedback:'',version:1}})).status,403);
 assert.equal((await call(path,{auth:t,method:'PUT',body:{score:null,feedback:'Еще проверяется',version:1}})).status,200);
 const j=(await call('courses/Y1-FIN/journal',{auth:s})).body;assert.equal(j.items.find(r=>r.id==='A-Y1-FIN-01').value,null);assert.equal(j.summary.find(r=>r.role==='progress').status,'partial');
});
test('Future values/comments are absent from raw API, dependencies, summaries, and publication time gates exam after January move',async()=>{
 const auth=await login();const j=(await call('courses/Y1-FIN/journal?preview=session-complete&limit=50',{auth})).body;
 assert(j.summary.filter(r=>r.role==='final').every(r=>r.value===null));assert.equal(j.items.find(r=>r.id===data.assignments.find(a=>a.subject_id==='Y1-FIN'&&a.assessment_group==='exam').assignment_id).value,null);assert.equal(j.items.find(r=>r.id===data.assignments.find(a=>a.subject_id==='Y1-FIN'&&a.assessment_group==='exam').assignment_id).graded_at,null);
 for(const r of j.items.filter(r=>r.type==='calculated'))for(const c of r.children)if(data.assignments.find(a=>a.assignment_id===c.id)?.assessment_group==='exam')assert.equal(c.value,null);
 const t=await loginTeacher(),r=(await call('courses/Y1-FIN/journal?student_id=STU-001',{auth:t})).body.items.find(r=>r.id==='A-Y1-FIN-01');
 await call('courses/Y1-FIN/grades/STU-001/A-Y1-FIN-01',{auth:t,method:'PUT',body:{score:1.234567,feedback:'SECRET_FUTURE_FEEDBACK',published_at:'2027-02-01T09:00:00Z',version:r.edit.version}});
 const hidden=(await call('courses/Y1-FIN/journal?limit=50',{auth})).body;assert(!JSON.stringify(hidden).includes('SECRET_FUTURE_FEEDBACK'));assert(!JSON.stringify(hidden).includes('1.234567'));
 now='2027-02-02T09:30:00Z';const fresh=await login();const visible=(await call('courses/Y1-FIN/journal?limit=50',{auth:fresh})).body;assert.equal(visible.items.find(r=>r.id==='A-Y1-FIN-01').value,1.234567);
});
test('No-exam course, two study tracks and cross-year session are preserved',async()=>{
 const a=await login2();const session=(await call('session',{auth:a})).body;assert.equal(session.user.track_names,'Digital|Гостеприимство');
 const d=(await call('courses/Y2-METHOD',{auth:a})).body;assert.equal(d.assessment_type,'none');
 const e=(await call('exams?limit=50',{auth:a})).body.items;assert(!e.some(e=>e.subject_id==='Y2-METHOD'));assert(e.some(e=>e.date.startsWith('2026-12')));assert(e.some(e=>e.date.startsWith('2027-01')));
});
test('Bounded APIs and static allowlist never serve fixture snapshots or source files',async()=>{
 const a=await login();assert.equal((await call('courses?limit=1',{auth:a})).body.items.length,1);
 assert.equal((await call('courses/Y1-FIN/journal?limit=1',{auth:a})).body.items.length,1);
 for(const path of ['/assets/data.js','/seed/students.csv','/data/portal.sqlite','/server/api.mjs']){const r=await dispatch(new Request('https://portal.test'+path),env,{});assert.equal(r.status,404);}
});

const assignment=(id,max)=>({assignment_id:id,subject_id:'course',title:id,max_score:max,published_at:'2020-01-01T00:00:00Z',assessment_group:'coursework'});
const result=(id,score)=>({assignment_id:id,score,status:'graded',graded_at:'2020-01-02T00:00:00Z',feedback:'ok'});
const rule=(id,op,inputs,more={})=>({rule_id:id,subject_id:'course',title:id,operation:op,input_ids:inputs.join('|'),output_max:'100',missing_policy:'wait',visibility:'always',version:'1',...more});
test('Formula operators: normalized weights, nested sums, average, best N, threshold and precision',()=>{
 const a=[assignment('a',10),assignment('b',20),assignment('c',30)],r=[rule('sum','sum',['a','b']),rule('weighted','weighted',['sum','c'],{weights:'0.6|0.4'}),rule('avg','average',['a','b','c']),rule('best','best_n',['a','b','c'],{parameter:'2'}),rule('pass','threshold',['weighted'],{parameter:'60',output_max:'1'})];
 const x=calculate(a,r,[result('a',8),result('b',10),result('c',30)],now);
 assert.equal(x.get('sum').value,18);assert.equal(x.get('sum').max,30);assert.equal(x.get('weighted').value,76);assert.equal(x.get('best').value,90);assert.equal(x.get('pass').value,1);assert(Math.abs(x.get('avg').value-76.66666666666667)<1e-12);
});
test('Missing values follow policy, weighted partial does not redistribute missing weight',()=>{
 const a=[assignment('a',10),assignment('b',20)],r=[rule('wait','sum',['a','b']),rule('partial','sum',['a','b'],{missing_policy:'partial'}),rule('w','weighted',['a','b'],{weights:'0.6|0.4',missing_policy:'partial'})];
 const x=calculate(a,r,[result('a',10)],now);assert.equal(x.get('wait').value,null);assert.equal(x.get('partial').value,10);assert.equal(x.get('partial').complete,false);assert.equal(x.get('w').value,60);
});
test('Provided bonus recomputes from source, respects maximum and unknown calculations require recompute',async()=>{
 now='2027-02-01T09:30:00Z';const before=await courseGrades(db,'STU-002','Y2-STRATEGY',now);const bonus=before.items.find(r=>r.id==='strategy-result-with-bonus');assert(bonus.value>0);
 const a=data.assignments.find(a=>a.subject_id==='Y2-STRATEGY'&&a.assessment_group==='coursework');await run(db,'UPDATE results SET score=0,graded_at=?,version=version+1 WHERE student_id=? AND assignment_id=?',[now,'STU-002',a.assignment_id]);
 const after=await courseGrades(db,'STU-002','Y2-STRATEGY',now);assert(after.items.find(r=>r.id==='strategy-result-with-bonus').value<bonus.value);
 const x=calculate([assignment('a',10)],[rule('p','provided',['a'],{implementation:{kind:'normalized_weighted_bonus',weights:[1],bonus:2,cap:100}}),rule('unknown','provided',['a'])],[result('a',10)],now);assert.equal(x.get('p').value,100);assert.equal(x.get('unknown').value,null);assert.equal(x.get('unknown').status,'recalculation_required');
});
test('Invalid references, cycles, weights, ranges and N are rejected',()=>{
 const a=[assignment('a',10)];assert.throws(()=>validateGraph(a,[rule('x','sum',['missing'])]));assert.throws(()=>validateGraph(a,[rule('x','sum',['y']),rule('y','sum',['x'])]));assert.throws(()=>validateGraph(a,[rule('w','weighted',['a'],{weights:'0.5'})]));assert.throws(()=>validateGraph(a,[rule('n','best_n',['a'],{parameter:'2'})]));assert.throws(()=>calculate(a,[],[result('a',11)],now));
});

test('Concurrent teacher changes keep one winner and exactly one audit record',async()=>{
 const auth=await loginTeacher(),path='courses/Y1-FIN/grades/STU-001/A-Y1-FIN-01';
 const results=await Promise.all([call(path,{auth,method:'PUT',body:{score:2,feedback:'Первое исправление',version:1}}),call(path,{auth,method:'PUT',body:{score:3,feedback:'Второе исправление',version:1}})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal((await one(db,"SELECT count(*) n FROM grade_history WHERE assignment_id='A-Y1-FIN-01'")).n,1);
});
test('Removing a grade changes the saved calculation date, and reading leaves the date stable',async()=>{
 const auth=await loginTeacher();now='2026-11-21T11:11:00Z';
 await call('courses/Y1-FIN/grades/STU-001/A-Y1-FIN-01',{auth,method:'PUT',body:{score:null,feedback:'Перепроверка',version:1}});
 const a=await courseGrades(db,'STU-001','Y1-FIN',now);assert.equal(a.summary.find(r=>r.role==='progress').published_at,new Date(now).toISOString());
 const b=await courseGrades(db,'STU-001','Y1-FIN','2026-11-21T12:30:00Z');assert.equal(a.summary[0].published_at,b.summary[0].published_at);
});
test('A provided result obeys its own release time even when all inputs are already public',()=>{
 const r=rule('p','provided',['a'],{implementation:{kind:'normalized_weighted_bonus',weights:[1],bonus:2,cap:100},release_at:'2027-01-01T12:00:00Z'});
 const before=calculate([assignment('a',10)],[r],[result('a',10)],'2027-01-01T11:00:00Z');assert.equal(before.get('p').value,null);
 const after=calculate([assignment('a',10)],[r],[result('a',10)],'2027-01-01T12:01:00Z');assert.equal(after.get('p').value,100);assert.equal(after.get('p').published_at,r.release_at);
});
test('January exams cannot expose December fixture scores before the moved exam ends',async()=>{
 const reg=data.exams.find(e=>e.date.startsWith('2027-01'));assert(reg);
 const pre=await courseGrades(db,reg.student_id,reg.subject_id,'2026-12-31T12:00:00Z');assert(!pre.summary.some(r=>r.role==='exam'&&r.value!==null));
 const post=await courseGrades(db,reg.student_id,reg.subject_id,'2027-02-01T12:00:00Z');assert(post.summary.some(r=>r.role==='exam'&&r.value!==null));
});

const loginStaff=()=>login('dekanat','Dekanat26!A1');
test('Deanery has teacher capabilities across all courses, grades and schedules',async()=>{
 const staff=await loginStaff(),teacher=await loginTeacher();
 assert.equal((await call('courses?limit=50',{auth:staff})).body.items.length,20);
 assert.equal((await call('courses/Y1-ENG/manage',{auth:teacher})).status,403);
 assert.equal((await call('courses/Y1-ENG/manage',{auth:staff})).status,200);
 const journal=(await call('courses/Y1-ENG/journal?student_id=STU-001',{auth:staff})).body,a=journal.items.find(r=>r.type==='assignment');assert(a.edit);
 assert.equal((await call(`courses/Y1-ENG/grades/STU-001/${a.id}`,{auth:staff,method:'PUT',body:{score:1,feedback:'',version:a.edit.version}})).status,200);
 const lessons=(await call('schedule?from=2026-11-23&to=2026-11-23',{auth:staff})).body.items;assert(lessons.some(l=>l.course==='1')&&lessons.some(l=>l.course==='2'));
 assert.equal((await call('exams?limit=50',{auth:staff})).body.items.length,new Set(data.exams.map(e=>e.exam_id)).size);
 const created=await call('lessons',{auth:staff,method:'POST',body:{subject_id:'Y1-ENG',date:'2026-12-06',start_time:'09:00',end_time:'10:30',room:'601',student_ids:['STU-001']}});assert.equal(created.status,201,JSON.stringify(created.body));
});
test('Expanded accounts, richer schedules and teacher profiles have no display demo prefixes',async()=>{
 const a=await login(),accounts=(await call('accounts')).body.accounts;
 assert.equal(accounts.filter(a=>a.role==='student').length,18);assert.equal(accounts.filter(a=>a.role==='teacher').length,8);assert.equal(accounts.filter(a=>a.role==='deanery').length,1);
 assert(!/демо|demo/i.test(JSON.stringify(accounts)));
 const schedule=(await call('schedule?from=2026-11-23&to=2026-11-28&limit=50',{auth:a})).body.items;
 for(let day=23;day<=28;day++)assert(schedule.filter(l=>l.date===`2026-11-${day}`).length>=3);
 assert(!/демо/i.test(JSON.stringify(schedule)));
 const profile=(await call('teachers/TCH-001',{auth:a})).body;assert(profile.department&&profile.office&&profile.consultation&&profile.courses.length);
 const t=await loginTeacher();assert((await call('courses/Y1-FIN/students',{auth:t})).body.items.length>=6);
});
test('Deanery can read all requests, reply, close and reopen with audit; students and teachers cannot',async()=>{
 const staff=await loginStaff(),student=await login(),teacher=await loginTeacher();
 assert.equal((await call('deanery/overview',{auth:student})).status,403);
 const requests=(await call('requests?status=all&limit=50',{auth:staff})).body.items;assert(requests.some(r=>r.student_id==='STU-002')&&requests.some(r=>r.student_id==='STU-001'));
 let r=(await call('requests/REQ-001',{auth:staff})).body;assert(r.student.full_name);
 const payload={version:r.version,status:'closed',response:'Вопрос решен',next_action:'Обращение завершено.',delivery_method:'portal'};
 for(const auth of [student,teacher])assert.equal((await call('requests/REQ-001',{auth,method:'PATCH',body:payload})).status,403);
 assert.equal((await call('requests/REQ-001',{auth:staff,method:'PATCH',body:payload})).status,200);
 assert.equal((await call('requests/REQ-001',{auth:staff,method:'PATCH',body:payload})).status,409);
 r=(await call('requests/REQ-001',{auth:staff})).body;
 assert.equal((await call('requests/REQ-001',{auth:staff,method:'PATCH',body:{...payload,version:r.version,status:'in_progress',response:'Повторная проверка'}})).status,200);
 const h=(await call('requests/REQ-001/history',{auth:staff})).body.items;assert(h.some(h=>h.actor.includes('Крылова')&&h.message==='Вопрос решен'));
 assert((await call('notifications',{auth:student})).body.items.some(n=>n.body==='Вопрос решен'));
 const filtered=(await call('requests?status=in_progress&q=Морозова',{auth:staff})).body.items;assert(filtered.every(r=>r.status==='in_progress'&&r.student.full_name.includes('Морозова')));
});
test('Deanery asks for clarification and receives student reply in the same history',async()=>{
 const staff=await loginStaff(),student=await login(),r=(await call('requests/REQ-001',{auth:staff})).body;
 const changed=await call('requests/REQ-001',{auth:staff,method:'PATCH',body:{version:r.version,status:'needs_info',response:'Уточните язык',next_action:'Пришлите уточнение',required_clarification:'На каком языке нужен документ?'}});assert.equal(changed.status,200);
 assert.equal((await call('requests/REQ-001/reply',{auth:student,method:'POST',body:{fields:{reply:'На русском'}},headers:withKey()})).status,200);
 assert((await call('requests/REQ-001/history',{auth:staff})).body.items.some(x=>x.message.includes('На русском')));
});
test('Teacher creates and moves a lesson for enrolled students, rejects collisions, stale writes and foreign courses',async()=>{
 const teacher=await loginTeacher(),student=await login(),body={subject_id:'Y1-FIN',date:'2026-12-06',start_time:'09:00',end_time:'10:30',room:'501',topic:'Разбор проектов',student_ids:['STU-001','STU-004']};
 assert.equal((await call('lessons',{auth:student,method:'POST',body})).status,403);
 assert.equal((await call('lessons',{auth:teacher,method:'POST',body:{...body,subject_id:'Y1-ENG'}})).status,403);
 assert.equal((await call('lessons',{auth:teacher,method:'POST',body:{...body,student_ids:['STU-002']}})).status,400);
 const r=await call('lessons',{auth:teacher,method:'POST',body});assert.equal(r.status,201,JSON.stringify(r.body));
 assert.equal((await call('lessons',{auth:teacher,method:'POST',body})).status,409);
 const edited=await call('lessons/'+r.body.lesson_id,{auth:teacher,method:'PUT',body:{...body,start_time:'11:00',end_time:'12:30',room:'502',version:1}});assert.equal(edited.status,200,JSON.stringify(edited.body));
 assert.equal((await call('lessons/'+r.body.lesson_id,{auth:teacher,method:'PUT',body:{...body,version:1}})).status,409);
 const visible=(await call('lessons/'+r.body.lesson_id,{auth:student})).body;assert.equal(visible.room,'502');assert.equal(visible.changes.length,1);assert.equal(visible.changes[0].old_room,'501');
 assert.equal((await call('schedule?from=2026-12-06&to=2026-12-06',{auth:student})).body.items.filter(l=>l.lesson_id===r.body.lesson_id).length,1);
 assert.equal((await call('session',{auth:student})).body.schedule_range[1],'2026-12-06');
});
test('Concurrent lesson creation keeps one reservation and rolls the conflicting write back',async()=>{
 const auth=await loginTeacher(),body={subject_id:'Y1-FIN',date:'2026-12-06',start_time:'09:00',end_time:'10:30',room:'501',student_ids:['STU-001']};
 const results=await Promise.all([call('lessons',{auth,method:'POST',body}),call('lessons',{auth,method:'POST',body})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 assert.equal((await one(db,"SELECT count(*) AS n FROM lessons WHERE date='2026-12-06'")).n,1);
 assert.equal((await one(db,"SELECT count(*) AS n FROM management_history WHERE kind='lesson'")).n,1);
});
test('Course edits persist with safe resources, ownership checks and conflict detection',async()=>{
 const teacher=await loginTeacher(),student=await login();
 const c=(await call('courses/Y1-FIN',{auth:teacher})).body,b={...c,description:'Обновленная программа',consultation:'Пятница, 15:00',chat_url:'https://example.com/chat',materials_url:'https://example.com/course'};
 assert.equal((await call('courses/Y1-FIN',{auth:student,method:'PUT',body:b})).status,403);
 assert.equal((await call('courses/Y1-FIN',{auth:teacher,method:'PUT',body:{...b,chat_url:'javascript:alert(1)'}})).status,400);
 assert.equal((await call('courses/Y1-FIN',{auth:teacher,method:'PUT',body:b})).status,200);
 assert.equal((await call('courses/Y1-FIN',{auth:teacher,method:'PUT',body:b})).status,409);
 const updated=(await call('courses/Y1-FIN',{auth:student})).body;assert.equal(updated.description,b.description);assert.equal(updated.resources[1].url,b.materials_url);
 await seed(db,data,now);assert.equal((await call('courses/Y1-FIN',{auth:student})).body.description,b.description);
});
test('New work, grading and formula dependencies reach the student; invalid formula and reduced maximum are rejected',async()=>{
 const teacher=await loginTeacher(),student=await login();
 const added=await call('courses/Y1-FIN/assignments',{auth:teacher,method:'POST',body:{title:'Разбор кейса',kind:'Практика',assessment_group:'coursework',max_score:20}});assert.equal(added.status,201);
 const id=added.body.assignment_id;
 assert.equal((await call(`courses/Y1-FIN/grades/STU-001/${id}`,{auth:teacher,method:'PUT',body:{score:17,feedback:'',version:0}})).status,200);
 const rule={title:'Итог за кейс',operation:'sum',input_ids:id,weights:'',parameter:'',output_max:20,role:'additional',visibility:'always',missing_policy:'wait'};
 assert.equal((await call('courses/Y1-FIN/rules',{auth:teacher,method:'POST',body:{...rule,input_ids:'missing'}})).status,400);
 const computed=await call('courses/Y1-FIN/rules',{auth:teacher,method:'POST',body:rule});assert.equal(computed.status,201);
 const journal=(await call('courses/Y1-FIN/journal?limit=50',{auth:student})).body;
 assert.equal(journal.items.find(x=>x.id===id).value,17);assert.equal(journal.items.find(x=>x.id===computed.body.id).value,17);
 assert.equal((await call('courses/Y1-FIN/assignments/'+id,{auth:teacher,method:'PUT',body:{...added.body,max_score:10}})).status,400);
});
test('Exam edits preserve registrations and delay disclosure until the new exam ends',async()=>{
 const teacher=await loginTeacher(),student=await login(),m=(await call('courses/Y1-FIN/manage',{auth:teacher})).body,e=m.exams[0];
 assert(e.student_ids.length>=6);
 const changed=await call('courses/Y1-FIN/exam/'+e.id,{auth:teacher,method:'PUT',body:{...e,date:'2027-02-10',room:'601'}});assert.equal(changed.status,200,JSON.stringify(changed.body));
 const exams=(await call('exams?limit=50',{auth:student})).body.items;assert(exams.some(x=>x.exam_id===e.id&&x.date==='2027-02-10'));
 const before=await courseGrades(db,'STU-001','Y1-FIN','2027-01-31T12:00:00Z');assert(!before.items.some(x=>x.id==='A-Y1-FIN-EX-01'));
});

test('All roles edit only their own contacts, staff edit office hours, stale versions and bad input are rejected',async()=>{
 for(const auth of [await login(),await loginTeacher(),await loginStaff()]){
   const u=(await call('session',{auth})).body.user,b={email:'updated@example.com',phone:'+7 (999) 123-45-67',version:u.profile_version,...(u.role!=='student'?{consultation:'Среда 14:00–16:00'}:{})};
   assert.equal((await call('profile',{auth,method:'PUT',body:{...b,email:'bad'}})).status,400);
   assert.equal((await call('profile',{auth,method:'PUT',body:{...b,phone:'abc'}})).status,400);
   assert.equal((await call('profile',{auth,method:'PUT',body:{...b,role:'deanery',id:'STU-002'}})).status,200);
   assert.equal((await call('profile',{auth,method:'PUT',body:b})).status,409);
   const updated=(await call('session',{auth})).body.user;assert.equal(updated.email,b.email);assert.equal(updated.phone,b.phone);assert.equal(updated.role,u.role);assert.equal(updated.id,u.id);
   if(u.role!=='student')assert.equal(updated.consultation,b.consultation);
   await seed(db,data,now);assert.equal((await call('session',{auth})).body.user.email,b.email);
 }
 assert.notEqual(JSON.parse((await one(db,"SELECT profile FROM users WHERE id='STU-002'")).profile).email,'updated@example.com');
});
test('Past lesson edits are denied to teachers and deanery at the exact end, with no history writes',async()=>{
 const teacher=await loginTeacher(),staff=await loginStaff();
 const row=await one(db,"SELECT * FROM lessons WHERE subject_id='Y1-FIN' AND date<'2026-11-21' ORDER BY date LIMIT 1"),lesson=JSON.parse(row.data);
 now=new Date(`${lesson.date}T${lesson.end_time}:00+03:00`).toISOString();
 for(const auth of [teacher,staff]){
  assert.equal((await call('lessons/'+row.id,{auth})).body.editable,false);
  assert.equal((await call('lessons/'+row.id,{auth,method:'PUT',body:{...lesson,version:row.version,date:'2026-12-06',student_ids:['STU-001']}})).status,403);
 }
 assert.equal((await one(db,'SELECT version FROM lessons WHERE id=?',[row.id])).version,row.version);
 assert.equal((await one(db,"SELECT count(*) AS n FROM management_history WHERE kind='lesson'")).n,0);
});
test('Schedule filters intersect on the same attendee and never expand teacher or student authorization',async()=>{
 const staff=await loginStaff(),teacher=await loginTeacher(),student=await login();
 const base='schedule?from=2026-11-23&to=2026-11-29&limit=50';
 const options=(await call('schedule/options',{auth:staff})).body;assert(options.academic_group.length>=3);assert(options.track_names.length>=2);
 for(const auth of [staff,teacher]){
  const rows=(await call(base+'&course=1&language_group=1',{auth})).body.items;assert(rows.length);
  for(const l of rows){const attendees=await all(db,"SELECT u.profile FROM users u JOIN lesson_students ls ON ls.student_id=u.id WHERE ls.lesson_id=?",[l.lesson_id]);assert(attendees.some(r=>{const p=JSON.parse(r.profile);return String(p.course)==='1'&&String(p.language_group)==='1';}));}
  assert.equal((await call(base+'&course=1&language_group=3',{auth})).body.items.length,0);
 }
 assert.equal((await call(base+'&course=2',{auth:student})).status,403);
 assert.equal((await call('schedule/options',{auth:student})).status,403);
 const teacherRows=(await call(base+'&course=2',{auth:teacher})).body.items;for(const l of teacherRows)assert.equal((await one(db,'SELECT teacher_id FROM subjects WHERE id=?',[l.subject_id])).teacher_id,'TCH-001');
});
test('Text rules accept labels, survive renamed work, recalculate changed scores and reject cycles',async()=>{
 const auth=await loginTeacher(),student=await login(),ids=[];
 for(const [title,score] of [['Задание 1',80],['Задание 2',70]]){
   const a=(await call('courses/Y1-FIN/assignments',{auth,method:'POST',body:{title,kind:'Практика',assessment_group:'coursework',max_score:100}})).body;ids.push(a);
   assert.equal((await call(`courses/Y1-FIN/grades/STU-001/${a.assignment_id}`,{auth,method:'PUT',body:{score,feedback:'',version:0}})).status,200);
 }
 const b={title:'Расчет по формуле',operation:'expression',expression:'0.6*[Задание 1]+0.4*[Задание 2]',output_max:100,role:'additional',visibility:'always',missing_policy:'wait'};
 const created=await call('courses/Y1-FIN/rules',{auth,method:'POST',body:b});assert.equal(created.status,201,JSON.stringify(created.body));
 assert.equal((await call('courses/Y1-FIN/journal?limit=50',{auth:student})).body.items.find(r=>r.id===created.body.id).value,76);
 await call('courses/Y1-FIN/assignments/'+ids[0].assignment_id,{auth,method:'PUT',body:{...ids[0],title:'Новое название'}});
 assert.equal((await call('courses/Y1-FIN/rules/'+created.body.id,{auth,method:'PUT',body:{...b,version:1}})).status,200);
 await call(`courses/Y1-FIN/grades/STU-001/${ids[1].assignment_id}`,{auth,method:'PUT',body:{score:100,feedback:'',version:1}});
 assert.equal((await call('courses/Y1-FIN/journal?limit=50',{auth:student})).body.items.find(r=>r.id===created.body.id).value,88);
 for(const expression of ['[Unknown]','__import__(1)','[Задание 2].x'])assert.equal((await call('courses/Y1-FIN/rules',{auth,method:'POST',body:{...b,expression}})).status,400);
 const next=await call('courses/Y1-FIN/rules',{auth,method:'POST',body:{...b,title:'Цепочка',expression:'[Расчет по формуле]'}});assert.equal(next.status,201);
 const cycle=await call('courses/Y1-FIN/rules/'+created.body.id,{auth,method:'PUT',body:{...b,expression:'[Цепочка]',version:2}});assert.equal(cycle.status,400);assert.match(cycle.body.error,/Цикл/);
});
test('Courses and exams beyond the first 50 remain accessible across years with pagination',async()=>{
 const auth=await login();
 for(let i=0;i<65;i++){
  const id='SCALE-'+i,date=`${2027+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}-15`;
  await run(db,'INSERT INTO subjects(id,teacher_id,name,details) VALUES(?,?,?,?)',[id,'TCH-001','Новая дисциплина '+i,JSON.stringify({assessment_type:'exam'})]);
  await run(db,'INSERT INTO enrollments(student_id,subject_id) VALUES(?,?)',['STU-001',id]);
  await run(db,'INSERT INTO exams(id,subject_id,date,data) VALUES(?,?,?,?)',[id,id,date,JSON.stringify({exam_id:id,subject_id:id,subject_name:'Новая дисциплина '+i,date,start_time:'10:00',end_time:'11:30',room:'301'})]);
  await run(db,'INSERT INTO exam_students(id,exam_id,student_id) VALUES(?,?,?)',[id,id,'STU-001']);
 }
 for(const path of ['courses','exams']){let offset=0,rows=[],more;do{const r=await call(`${path}?limit=50&offset=${offset}`,{auth});assert.equal(r.status,200);rows.push(...r.body.items);offset=rows.length;more=r.body.has_more;}while(more);assert.equal(rows.filter(r=>(r.id||r.exam_id).startsWith('SCALE-')).length,65);assert.equal(new Set(rows.map(r=>r.id||r.exam_id)).size,rows.length);}
});

test('Concurrent graph edits cannot introduce a cycle across two different formulas',async()=>{
 const auth=await loginTeacher(),common={operation:'expression',output_max:100,role:'additional',visibility:'always',missing_policy:'wait'};
 const a=(await call('courses/Y1-FIN/manage',{auth})).body.assignments[0];
 const left=await call('courses/Y1-FIN/rules',{auth,method:'POST',body:{...common,title:'Левая',expression:`[${a.id}]`}});
 const right=await call('courses/Y1-FIN/rules',{auth,method:'POST',body:{...common,title:'Правая',expression:`[${a.id}]`}});
 const results=await Promise.all([call('courses/Y1-FIN/rules/'+left.body.id,{auth,method:'PUT',body:{...common,title:'Левая',expression:'[Правая]',version:1}}),call('courses/Y1-FIN/rules/'+right.body.id,{auth,method:'PUT',body:{...common,title:'Правая',expression:'[Левая]',version:1}})]);
 assert.equal(results.filter(r=>r.status===200).length,1);assert(results.some(r=>[400,409].includes(r.status)));
 const m=(await call('courses/Y1-FIN/manage',{auth})).body;assert.doesNotThrow(()=>validateGraph(m.assignments,m.rules));
});

test('Typed document full lifecycle: duplicate protection, profile snapshot, short number, privacy, reply, ready, close and persistence',async()=>{
 const a=await login(),b=await login2(),t=await loginTeacher(),staff=await loginStaff();
 const body={type:'enrollment_certificate',student_id:'STU-002',fields:{destination:'Студенческая конференция',document_language:'ru',copies:'2',preferred_delivery:'pickup'}};
 assert.equal((await call('requests',{auth:a,method:'POST',body:{...body,fields:{...body.fields,copies:'1.5'}},headers:withKey()})).status,400);
 assert.equal((await call('requests',{auth:a,method:'POST',body:{...body,fields:{...body.fields,destination:''}},headers:withKey()})).status,400);
 const created=await call('requests',{auth:a,method:'POST',body,headers:withKey()});assert.equal(created.status,201,JSON.stringify(created.body));let r=created.body;
 assert.equal(r.student_id,'STU-001');assert.equal(r.student_snapshot.full_name,'Морозова Анна Ильинична');assert(Number.isInteger(r.number));assert.equal(r.expected_ready_date,'');
 assert.equal((await call('requests',{auth:a,method:'POST',body,headers:withKey()})).body.id,r.id);
 for(const op of ['', '/history'])assert.equal((await call('requests/'+r.id+op,{auth:b})).status,404);
 assert.equal((await call('requests/'+r.id,{auth:t})).status,403);
 const transition=async status=>{const live=(await call('requests/'+r.id,{auth:staff})).body;const result=await call('requests/'+r.id,{auth:staff,method:'PATCH',body:{version:live.version,status,response:'Проверено сотрудником',next_action:status==='ready'?'Заберите документ в кабинете 102.':'Ожидайте ответа',delivery_method:'pickup',pickup_location:'Кабинет 102',pickup_hours:'10:00–17:00',required_clarification:'Укажите организацию'}});assert.equal(result.status,200,JSON.stringify(result.body));};
 await transition('in_progress');await transition('needs_info');
 assert((await call('home',{auth:a})).body.next_steps.some(x=>x.id==='request:'+r.id&&x.priority===0));
 const reply={fields:{reply:'Оргкомитет конференции'}};
 assert.equal((await call('requests/'+r.id+'/reply',{auth:a,method:'POST',body:reply,headers:withKey('reply-lifecycle-00001')})).status,200);
 assert.equal((await call('requests/'+r.id+'/reply',{auth:a,method:'POST',body:reply,headers:withKey('reply-lifecycle-00001')})).status,200);
 assert(!(await call('home',{auth:a})).body.next_steps.some(x=>x.id==='request:'+r.id));
 await transition('ready');assert((await call('home',{auth:a})).body.next_steps.some(x=>x.id==='request:'+r.id));
 const received=(await call('requests/'+r.id,{auth:a})).body;assert.equal(received.pickup_location,'Кабинет 102');assert.equal(received.fields.copies,'2');
 await transition('closed');assert(!(await call('home',{auth:a})).body.next_steps.some(x=>x.id==='request:'+r.id));
 db.close();db=localDb(dbPath);migrate(db);env.DB=db;const fresh=await login();const saved=(await call('requests/'+r.id,{auth:fresh})).body;assert.equal(saved.number,r.number);assert.equal(saved.status,'closed');
 assert((await call('requests/'+r.id+'/history',{auth:staff})).body.items.some(x=>x.message.includes('Оргкомитет')));
});
test('Latest transfer at 05:00 Moscow is first on home and consistent across schedule, lesson and notification; obsolete targets collapse',async()=>{
 const t=await loginTeacher(),a=await login(),b=await login2(),id='L-EXP-STU-001-2026-11-23-0';
 let l=(await call('lessons/'+id,{auth:t})).body;
 const payload={subject_id:l.subject_id,date:'2026-11-25',start_time:'05:00',end_time:'07:00',room:'402',student_ids:l.student_ids,version:l.version};
 assert.equal((await call('lessons/'+id,{auth:t,method:'PUT',body:payload})).status,200);
 const home=(await call('home',{auth:a})).body;assert.equal(home.changes[0].lesson_id,id);assert(home.changes_total>=3);
 const changes=(await call('changes',{auth:a})).body.items;assert.equal(changes[0].new_start_time,'05:00');assert.equal(changes[0].timezone,'Europe/Moscow');
 const schedule=(await call('schedule?from=2026-11-25&to=2026-11-25',{auth:a})).body.items.find(x=>x.lesson_id===id);assert.equal(schedule.transfer.new_start_time,'05:00');
 const n=(await call('notifications',{auth:a})).body.items.find(n=>n.route==='lesson/'+id);assert.match(n.body,/25 ноября 2026/);assert.match(n.body,/05:00–07:00/);assert.match(n.body,/Было:/);assert(!n.body.includes('2026-11-25'));
 assert(!(await call('changes',{auth:b})).body.items.some(x=>x.lesson_id===id));
 await run(db,"INSERT INTO notifications(id,user_id,kind,published_at,data) VALUES('invalid-date-text','STU-001','request',?,?)",[now,JSON.stringify({title:'Проверка',body:'В тексте указано 2026-99-99',route:'requests'})]);assert.equal((await call('notifications',{auth:a})).status,200);
 l=(await call('lessons/'+id,{auth:t})).body;
 assert.equal((await call('lessons/'+id,{auth:t,method:'PUT',body:{...payload,start_time:'06:00',end_time:'08:00',version:l.version}})).status,200);
 assert.equal((await call('changes',{auth:a})).body.items.filter(x=>x.lesson_id===id).length,1);
 assert.equal((await call('lessons/'+id,{auth:a})).body.changes[0].new_start_time,'06:00');
});
test('Slot suggestions respect access, room, teacher, students and saving rechecks collisions',async()=>{
 const t=await loginTeacher(),a=await login(),body={subject_id:'Y1-FIN',date:'2026-11-23',start_time:'09:00',end_time:'10:30',room:'401',student_ids:['STU-001']};
 assert.equal((await call('lessons/slots',{auth:a,method:'POST',body})).status,403);
 assert.equal((await call('lessons/slots',{auth:t,method:'POST',body:{...body,subject_id:'Y1-ENG'}})).status,403);
 const slots=(await call('lessons/slots',{auth:t,method:'POST',body})).body.slots;assert(slots.length>0);assert(!slots.some(s=>s.date===body.date&&s.start_time<'15:40'));
 const selected={...body,...slots[0]};assert.equal((await call('lessons',{auth:t,method:'POST',body:selected})).status,201);
 assert.equal((await call('lessons',{auth:t,method:'POST',body:selected})).status,409);
});
test('Forecast API is read-only, student-scoped and summary distinguishes pending, zero and ungraded across pages',async()=>{
 const a=await login(),b=await login2(),t=await loginTeacher();
 const before=JSON.stringify(await all(db,'SELECT * FROM results'));
 const f=(await call('courses/Y1-FIN/forecast',{auth:a})).body;assert.equal(f.available,true,JSON.stringify(f));assert(f.inputs.some(x=>!x.confirmed));
 const assumptions=Object.fromEntries(f.inputs.filter(x=>!x.confirmed).map(x=>[x.id,x.max]));const result=await call('courses/Y1-FIN/forecast',{auth:a,method:'POST',body:{assumptions}});assert.equal(result.status,200);assert(result.body.result!==null);
 assert.equal((await call('courses/Y1-FIN/forecast',{auth:b})).status,404);assert.equal((await call('courses/Y1-FIN/forecast',{auth:t})).status,403);
 assert.equal(JSON.stringify(await all(db,'SELECT * FROM results')),before);
 const j=(await call('courses/Y1-FIN/journal?limit=1',{auth:a})).body;assert.equal(j.items.length,1);assert(j.overview.graded>1);assert(j.overview.pending>0);assert(j.overview.ungraded>0);assert(j.overview.final_formula);
});
test('Next steps prioritize real deadlines, deduplicate the next moved lesson and remove completed events at Moscow boundary',async()=>{
 const t=await loginTeacher(),id='L-EXP-STU-001-2026-11-23-0',l=(await call('lessons/'+id,{auth:t})).body;
 assert.equal((await call('lessons/'+id,{auth:t,method:'PUT',body:{subject_id:l.subject_id,date:'2026-11-25',start_time:'05:00',end_time:'07:00',room:'402',student_ids:l.student_ids,version:l.version}})).status,200);
 now='2026-11-25T01:30:00.000Z';const a=await login(),home=(await call('home',{auth:a})).body;
 const steps=home.next_steps.filter(x=>x.id==='lesson:'+id);assert.equal(steps.length,1);assert.equal(steps[0].priority,1);assert.equal(steps[0].deadline,'2026-11-25T05:00:00+03:00');assert.equal(home.next.lesson_id,id);
 assert(home.next_steps.filter(x=>x.id.startsWith('request:')).every(x=>x.deadline===null));
 now='2026-11-25T04:00:00.000Z';assert(!(await call('home',{auth:a})).body.next_steps.some(x=>x.id==='lesson:'+id));
});


test('Journal includes all work and calculations, with real assessment/deadline dates and safe exam metadata',async()=>{
 const student=await login();const a=data.assignments.find(a=>a.subject_id==='Y1-FIN'&&a.assessment_group!=='exam');
 const record=await one(db,'SELECT data FROM assignments WHERE id=?',[a.assignment_id]);const stored=JSON.parse(record.data);stored.published_at='2026-11-20T11:00:00Z';stored.due_at='2026-11-23T20:59:00Z';await run(db,'UPDATE assignments SET data=? WHERE id=?',[JSON.stringify(stored),a.assignment_id]);
 await run(db,'UPDATE results SET graded_at=? WHERE assignment_id=? AND student_id=?',['2026-11-19T09:15:00Z',a.assignment_id,'STU-001']);
 const j=(await call('courses/Y1-FIN/journal?limit=50',{auth:student})).body;
 assert.equal(j.total,Number((await one(db,'SELECT COUNT(*) AS n FROM assignments WHERE subject_id=?',['Y1-FIN'])).n)+Number((await one(db,'SELECT COUNT(*) AS n FROM rules WHERE subject_id=?',['Y1-FIN'])).n));
 const row=j.items.find(r=>r.id===a.assignment_id);assert.equal(row.graded_at,'2026-11-19T09:15:00Z');assert.equal(row.published_at,'2026-11-20T11:00:00Z');assert.equal(row.due_at,'2026-11-23T20:59:00Z');
 const exam=j.items.find(r=>r.id===data.assignments.find(a=>a.subject_id==='Y1-FIN'&&a.assessment_group==='exam').assignment_id);assert(exam);assert.equal(exam.value,null);assert.equal(exam.graded_at,null);assert(!exam.feedback);
 assert(j.items.some(r=>r.role==='exam'&&r.value===null));
});

test('Inline scenarios respect access, fixed grades and preserve results/history/cache',async()=>{
 const student=await login(),teacher=await loginTeacher(),staff=await loginStaff();
 const tables=['results','grade_history','calculations'];const before=await Promise.all(tables.map(t=>all(db,'SELECT * FROM '+t+' ORDER BY rowid')));
 const context=(await call('courses/Y1-FIN/scenario',{auth:student})).body;
 const fixed=context.inputs.find(i=>i.confirmed),editable=context.inputs.find(i=>!i.confirmed);assert(fixed&&editable);
 const scenario=await call('courses/Y1-FIN/scenario',{auth:student,method:'POST',body:{assumptions:Object.fromEntries(context.inputs.filter(i=>!i.confirmed).map(i=>[i.id,i.max]))}});assert.equal(scenario.status,200,JSON.stringify(scenario.body));assert(scenario.body.rows.every(r=>r.value!==null));
 assert.equal((await call('courses/Y1-FIN/scenario',{auth:student,method:'POST',body:{assumptions:{[fixed.id]:0}}})).status,400);
 assert.equal((await call('courses/Y1-FIN/scenario?student_id=STU-002',{auth:student})).status,403);
 assert.equal((await call('courses/Y1-ENG/scenario?student_id=STU-001',{auth:teacher})).status,403);
 assert.equal((await call('courses/Y1-FIN/scenario?student_id=STU-002',{auth:teacher})).status,404);
 assert.equal((await call('courses/Y1-FIN/scenario?student_id=STU-001',{auth:teacher})).status,200);
 assert.equal((await call('courses/Y1-ENG/scenario?student_id=STU-001',{auth:staff})).status,200);
 const after=await Promise.all(tables.map(t=>all(db,'SELECT * FROM '+t+' ORDER BY rowid')));assert.deepEqual(after,before);
 // A score published after opening the calculator must not be overridden.
 await run(db,'INSERT INTO results(student_id,assignment_id,score,status,graded_at,version) VALUES(?,?,?,?,?,1) ON CONFLICT(student_id,assignment_id) DO UPDATE SET score=excluded.score,status=excluded.status,graded_at=excluded.graded_at',['STU-001',editable.id,1,'graded','2026-11-20T09:00:00Z']);
 const result=await call('courses/Y1-FIN/scenario',{auth:student,method:'POST',body:{assumptions:{[editable.id]:2}}});
 // An exam remains unpublished until the scheduled end; use an ordinary leaf above.
 if(!editable.id.includes('-EX-'))assert.equal(result.status,400);
});

test('Editing an assignment preserves its deadline when omitted and validates a supplied deadline',async()=>{
 const auth=await loginTeacher(),id='A-Y1-FIN-01',r=await one(db,'SELECT data,version FROM assignments WHERE id=?',[id]),a=JSON.parse(r.data);a.due_at='2026-11-23T20:59:00Z';await run(db,'UPDATE assignments SET data=? WHERE id=?',[JSON.stringify(a),id]);
 const b={title:a.title,assessment_group:a.assessment_group,kind:a.kind,max_score:a.max_score,version:r.version};const saved=await call('courses/Y1-FIN/assignments/'+id,{auth,method:'PUT',body:b});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(Date.parse(saved.body.due_at),Date.parse(a.due_at));
 assert.equal((await call('courses/Y1-FIN/assignments/'+id,{auth,method:'PUT',body:{...b,version:saved.body.version,due_at:'invalid'}})).status,400);
});


test('Assessment time is the real grade edit, not a deferred publication time',async()=>{
 const teacher=await loginTeacher();const journal=(await call('courses/Y1-FIN/journal?student_id=STU-001',{auth:teacher})).body;
 const row=journal.items.find(r=>r.id==='A-Y1-FIN-01'),assessed=now;
 assert.equal((await call('courses/Y1-FIN/grades/STU-001/'+row.id,{auth:teacher,method:'PUT',body:{score:5,feedback:'',published_at:'2026-11-23T10:00:00Z',version:row.edit.version}})).status,200);
 const student=await login();const before=(await call('courses/Y1-FIN/journal',{auth:student})).body.items.find(r=>r.id===row.id);assert.equal(before.graded_at,null);
 const teacherRow=(await call('courses/Y1-FIN/journal?student_id=STU-001',{auth:teacher})).body.items.find(r=>r.id===row.id);assert.equal(teacherRow.graded_at,assessed);
 now='2026-11-24T10:00:00Z';const fresh=await login();const visible=(await call('courses/Y1-FIN/journal',{auth:fresh})).body.items.find(r=>r.id===row.id);assert.equal(visible.graded_at,assessed);assert.equal(visible.published_at,'2026-11-23T10:00:00.000Z');
});
