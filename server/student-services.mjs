import {all,one,json} from './db.mjs';

export const dateRu = date => new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric'}).format(new Date(date+'T12:00:00+03:00'));
export const lessonEnd = l => Date.parse(`${l.date}T${l.end_time}:00+03:00`);
export const transferText = c => `Было: ${dateRu(c.old_date)}, ${c.old_start_time}–${c.old_end_time}, ауд. ${c.old_room} → Стало: ${dateRu(c.new_date)}, ${c.new_start_time}–${c.new_end_time}, ауд. ${c.new_room}. Время московское.`;
export async function currentTransfers(db,user,now,{future=true,lessonId=null}={}) {
  const scope=user.role==='deanery'?'1=1':user.role==='teacher'?'s.teacher_id=?':'EXISTS (SELECT 1 FROM lesson_students ls WHERE ls.lesson_id=l.id AND ls.student_id=?)';
  const rows=await all(db,`SELECT c.data,l.data AS lesson,s.name FROM changes c JOIN lessons l ON l.id=c.lesson_id JOIN subjects s ON s.id=l.subject_id WHERE ${scope} AND julianday(c.announced_at)<=julianday(?) ${lessonId?'AND l.id=?':''} ORDER BY julianday(c.announced_at) DESC,c.rowid DESC`,[...(user.role==='deanery'?[]:[user.id]),now,...(lessonId?[lessonId]:[])]);
  const seen=new Set(),out=[];
  for(const r of rows){const c=json(r.data),l=json(r.lesson);if(seen.has(l.lesson_id))continue;seen.add(l.lesson_id);if(future&&lessonEnd(l)<=Date.parse(now))continue;
    out.push({...c,subject_name:r.name,new_date:l.date,new_start_time:l.start_time,new_end_time:l.end_time,new_room:l.room,timezone:'Europe/Moscow'});
  }
  return out;
}
const language={key:'document_language',label:'Язык документа',type:'select',required:true,default:'ru',options:[{value:'ru',label:'Русский'},{value:'en',label:'Английский'}]};
const destination={key:'destination',label:'Организация или цель предоставления',type:'text',required:true,max_length:300,placeholder:'Например, для участия в студенческой конференции',hint:'Укажите получателя или напишите «По месту требования».'};
const delivery={key:'preferred_delivery',label:'Предпочтительный способ получения',type:'select',required:true,default:'pickup',options:[{value:'pickup',label:'Лично в деканате'},{value:'portal',label:'Электронный ответ в портале'}],hint:'Окончательный способ подтвердит сотрудник деканата.'};
const description=(label,placeholder)=>({key:'description',label,type:'textarea',required:true,max_length:2000,placeholder});
export const requestTypes=[
  {id:'enrollment_certificate',label:'Справка об обучении',fields:[destination,language,{key:'copies',label:'Количество экземпляров',type:'number',required:true,default:'1',min:1,max:10,integer:true,hint:'От 1 до 10 экземпляров.'},delivery]},
  {id:'academic_transcript',label:'Выписка с оценками',fields:[description('Для чего нужна выписка','Например, для перевода в другой вуз'),language,delivery]},
  {id:'certificate_correction',label:'Исправление справки',fields:[{key:'document_number',label:'Номер или дата справки',type:'text',required:true,max_length:100,placeholder:'Например, справка от 20 ноября 2026 года'},description('Что нужно исправить','Укажите ошибочный текст и правильный вариант')]},
  {id:'schedule_question',label:'Вопрос в деканат',fields:[description('Ваш вопрос','Укажите дисциплину, дату или ситуацию, с которой нужна помощь')]}
];
export async function nextSteps(db,user,now,next,changes,exams){
  if(user.role!=='student')return [];
  const items=[],time=Date.parse(now),horizon=time+14*86400000;
  for(const row of await all(db,"SELECT * FROM requests WHERE student_id=? AND status IN ('needs_info','ready')",[user.id])){
    const r=json(row.data),clarify=row.status==='needs_info';
    items.push({id:'request:'+row.id,priority:clarify?0:2,at:row.updated_at,title:clarify?'Деканату нужно уточнение':'Документ готов',reason:r.title,detail:clarify?r.required_clarification:r.next_action,deadline:null,route:'request/'+row.id,cta:clarify?'Ответить деканату':'Как получить'});
  }
  const change=changes.find(c=>c.lesson_id===next?.lesson_id);
  if(change)items.push({id:'lesson:'+next.lesson_id,priority:3,at:`${next.date}T${next.start_time}:00+03:00`,title:'Ближайшее занятие перенесено',reason:next.subject_name,detail:transferText(change),deadline:`${next.date}T${next.start_time}:00+03:00`,route:'lesson/'+next.lesson_id,cta:'Открыть занятие'});
  for(const e of exams){const at=`${e.date}T${e.start_time}:00+03:00`;if(Date.parse(at)<time||Date.parse(at)>horizon)continue;items.push({id:'exam:'+e.exam_id,priority:3,at,title:'Приближается аттестация',reason:e.subject_name,detail:`${e.start_time}–${e.end_time} · Ауд. ${e.room}`,deadline:at,route:'subject/'+e.subject_id,cta:'Открыть дисциплину'});}
  const due=await all(db,"SELECT a.data,s.name,r.status,r.score,r.submitted_at FROM assignments a JOIN subjects s ON s.id=a.subject_id JOIN enrollments e ON e.subject_id=s.id LEFT JOIN results r ON r.assignment_id=a.id AND r.student_id=e.student_id WHERE e.student_id=? AND json_extract(a.data,'$.due_at')<>'' AND julianday(json_extract(a.data,'$.published_at'))<=julianday(?)",[user.id,now]);
  for(const r of due){const a=json(r.data),at=Date.parse(a.due_at);if(!Number.isFinite(at)||at<time||at>horizon||r.submitted_at||r.status==='graded'||r.status==='submitted')continue;items.push({id:'assignment:'+a.assignment_id,priority:3,at:a.due_at,title:a.title,reason:r.name,detail:'Для работы указан срок. Проверьте условия в дисциплине.',deadline:a.due_at,route:'subject/'+a.subject_id,cta:'Открыть дисциплину'});}
  for(const item of items)if(item.deadline&&Date.parse(item.deadline)-time<=86400000)item.priority=1;
  return items.sort((a,b)=>a.priority-b.priority||(a.deadline?Date.parse(a.at)-Date.parse(b.at):Date.parse(b.at)-Date.parse(a.at))||a.id.localeCompare(b.id));
}
