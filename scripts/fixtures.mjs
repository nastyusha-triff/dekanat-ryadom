import {readFile} from 'node:fs/promises';
import {hashPassword} from '../server/security.mjs';
import {expandFixtures,cleanText} from './expanded-fixtures.mjs';
import {validateGraph} from '../server/grading.mjs';
const root=new URL('../seed/',import.meta.url);
export function csv(text){
  const rows=[];let row=[],cell='',quoted=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell='';}else cell+=c;}
  if(cell||row.length){row.push(cell);rows.push(row);}const headers=rows.shift();return rows.map(r=>Object.fromEntries(headers.map((k,i)=>[k,r[i]??''])));
}
export async function fixtures(){
  const names=['students','teachers','subjects','schedule','schedule_changes','assignments','assignment_results','grading_rules','grades','exams','request_history'];
  let data=Object.fromEntries(await Promise.all(names.map(async n=>[n,csv(await readFile(new URL(n+'.csv',root),'utf8'))])));
  const catalog=JSON.parse(await readFile(new URL('portal_catalog.json',root),'utf8'));
  const extra=JSON.parse(await readFile(new URL('synthetic.json',root),'utf8'));
  data.catalog=catalog;data.range=extra.schedule_range;
  data.rule_publications=JSON.parse(await readFile(new URL('calculated_results.json',root),'utf8')).map(r=>({student_id:r.student_id,rule_id:r.rule_id,release_at:r.published_at}));
  data=expandFixtures(data,extra);
  data.users=[];
  for(const s of data.students){const {initial_password,...profile}=s;data.users.push({id:s.student_id,username:s.username,role:'student',profile,password_hash:await hashPassword(initial_password)});}
  const teacherAccounts=extra.teacher_accounts.map(a=>({...a,username:a.username.replace('demo_',''),initial_password:a.initial_password.replace('DemoTeacher','Teacher')}));
  for(const t of data.teachers){const a=teacherAccounts.find(a=>a.id===t.teacher_id);data.users.push({id:t.teacher_id,username:a.username,role:'teacher',profile:t,password_hash:await hashPassword(a.initial_password)});}
  const staff={id:'STAFF-001',username:'dekanat',role:'deanery',profile:{full_name:'Крылова Наталья Сергеевна',position:'Специалист деканата',department:'Учебный отдел',faculty:'Факультет маркетинга и управления',email:'dekanat@example.com',office:'102',consultation:'Пн–пт, 10:00–17:00'},password_hash:await hashPassword('Dekanat26!A1')};
  data.users.push(staff);
  data.demo_accounts=[...data.students.map(s=>({username:s.username,password:s.initial_password,full_name:s.full_name,role:'student',description:`${s.course} курс · ${s.academic_group} · Языковая группа ${s.language_group}`})),...teacherAccounts.map(a=>({username:a.username,password:a.initial_password,full_name:data.teachers.find(t=>t.teacher_id===a.id).full_name,role:'teacher',description:'Преподаватель · дисциплины и расписание'})),{username:staff.username,password:'Dekanat26!A1',full_name:staff.profile.full_name,role:'deanery',description:'Деканат · обращения студентов'}];
  for(const r of data.grading_rules)if(extra.provided_implementations[r.rule_id])r.implementation=extra.provided_implementations[r.rule_id];
  validateGraph(data.assignments,data.grading_rules);
  delete data.students;delete data.teachers;
  return data;
}
