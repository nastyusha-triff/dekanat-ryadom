// Stable additions to the original fixture set. Original source CSVs remain intact.
export function cleanText(value) {
  if (typeof value === 'string') return value.replace(/демонстрационная/gi, 'Учебная').replace(/демонстрационный/gi, 'предварительный').replace(/демо[-:\s]*/gi, '').replace(/demo_/gi, '').replace(/ё/g, 'е');
  if (Array.isArray(value)) return value.map(cleanText);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,cleanText(v)]));
  return value;
}

export function expandFixtures(input, extra) {
  const d=cleanText(input);
  const names=[
    ['Кузнецов Артем Сергеевич','Алексеева Полина Дмитриевна','Смирнов Никита Олегович','Орлова София Андреевна','Павлова Дарья Романовна'],
    ['Волков Дмитрий Алексеевич','Новикова Алиса Павловна','Федоров Иван Максимович','Михайлова Ева Денисовна','Попов Кирилл Ильич'],
    ['Васильева Ксения Олеговна','Семенов Михаил Андреевич','Захарова Виктория Игоревна','Лебедев Матвей Сергеевич','Соколова Вероника Павловна']
  ];
  const originals=d.students.slice();
  originals.forEach((s,i)=>{
    Object.assign(s,cleanText(extra.student_profiles[s.student_id]));
    s.initial_password=`Campus26!${['A1','B2','C3'][i]}`;
    s.track_names||='Маркетинг и управление';
    s.faculty='Факультет маркетинга и управления';
    s.program='Организация международного туризма и цифровой маркетинг';
  });
  const teacherFor=id=>d.catalog.course_details.find(c=>c.subject_id===id).teacher_id;
  const dates=[];
  for(let day=new Date('2026-11-02T12:00:00Z');day<=new Date('2026-12-05T12:00:00Z');day.setUTCDate(day.getUTCDate()+1))if(day.getUTCDay()!==0)dates.push(day.toISOString().slice(0,10));
  const slots=[['09:00','10:30'],['10:40','12:10'],['12:30','14:00'],['14:10','15:40'],['15:50','17:20'],['17:30','19:00']];
  for(const [dayIndex,date] of dates.entries())for(const [groupIndex,s] of originals.entries()){
    const subjectIds=[...new Set(d.grades.filter(g=>g.student_id===s.student_id).map(g=>g.subject_id))];
    let count=d.schedule.filter(l=>l.student_id===s.student_id&&l.date===date).length;
    const target=dayIndex%3===0?4:3;
    for(const [slotIndex,[start,end]] of slots.entries()){
      if(count>=target)break;
      const occupied=d.schedule.filter(l=>l.date===date&&l.start_time<end&&l.end_time>start);
      if(occupied.some(l=>l.student_id===s.student_id))continue;
      const candidates=subjectIds.slice((dayIndex+slotIndex)%subjectIds.length).concat(subjectIds.slice(0,(dayIndex+slotIndex)%subjectIds.length));
      const id=candidates.find(id=>!occupied.some(l=>teacherFor(l.subject_id)===teacherFor(id))&&!d.schedule.some(l=>l.student_id===s.student_id&&l.date===date&&l.subject_id===id));
      if(!id)continue;
      const subject=d.subjects.find(c=>c.subject_id===id),lessonId=`L-EXP-${s.student_id}-${date}-${slotIndex}`;
      d.schedule.push({schedule_id:`${s.student_id}__${lessonId}`,lesson_id:lessonId,student_id:s.student_id,subject_id:id,subject_name:subject.subject_name,date,start_time:start,end_time:end,timezone:'Europe/Moscow',room:String(401+groupIndex),status:'scheduled',course:s.course,language_group:s.language_group,track_code:subject.track_code,original_date:date,original_start_time:start,original_end_time:end,original_room:String(401+groupIndex),change_id:''});
      count++;
    }
  }
  const baseSchedule=d.schedule.slice(),baseExams=d.exams.slice(),baseGrades=d.grades.slice(),baseResults=d.assignment_results.slice(),basePublications=d.rule_publications.slice();
  for(const [groupIndex,s] of originals.entries())for(const [i,name] of names[groupIndex].entries()){
    const n=4+groupIndex*5+i,id='STU-'+String(n).padStart(3,'0');
    d.students.push({...s,student_id:id,full_name:name,username:`student${String(n).padStart(2,'0')}`,email:`student${n}@example.com`,initial_password:`Campus26!S${String(n).padStart(2,'0')}`});
    d.schedule.push(...baseSchedule.filter(l=>l.student_id===s.student_id).map(l=>({...l,student_id:id,schedule_id:`${id}__${l.lesson_id}`})));
    d.exams.push(...baseExams.filter(e=>e.student_id===s.student_id).map(e=>({...e,student_id:id,exam_registration_id:`${id}__${e.exam_id}`})));
    d.grades.push(...baseGrades.filter(g=>g.student_id===s.student_id).map(g=>({...g,student_id:id})));
    d.assignment_results.push(...baseResults.filter(r=>r.student_id===s.student_id).map(r=>{
      const max=Number(d.assignments.find(a=>a.assignment_id===r.assignment_id).max_score);
      return {...r,student_id:id,score:r.score===''?'':String(Math.max(0,Math.min(max,Number(r.score)+(i-2)))),feedback:''};
    }));
    d.rule_publications.push(...basePublications.filter(r=>r.student_id===s.student_id).map(r=>({...r,student_id:id})));
    for(const c of d.schedule_changes)if(c.affected_student_ids.split('|').includes(s.student_id))c.affected_student_ids+='|'+id;
    for(const a of d.catalog.announcements)if(a.student_ids.includes(s.student_id))a.student_ids.push(id);
    const requestId=`REQ-EXP-${String(n).padStart(3,'0')}`,statuses=['submitted','in_progress','needs_info','ready','closed'],status=statuses[i],date=`2026-11-${String(17+i).padStart(2,'0')}T10:00:00+03:00`;
    const base=d.catalog.requests[0];
    d.catalog.requests.push({...base,request_id:requestId,student_id:id,title:i%2?'Справка об обучении':'Выписка с оценками',request_type:i%2?'enrollment_certificate':'academic_transcript',description:'Прошу подготовить документ для участия в студенческой программе.',status,created_at:date,updated_at:date,response:status==='ready'?'Документ готов к выдаче.':'Обращение зарегистрировано.',expected_ready_date:'2026-11-25',next_action:status==='needs_info'?'Укажите язык документа.':status==='ready'?'Заберите документ в кабинете 102.':status==='closed'?'Обращение завершено.':'Ожидайте ответа деканата.',delivery_method:'pickup',delivery_label:'Лично в деканате',pickup_location:'Кабинет 102',pickup_hours:'Пн–пт, 10:00–17:00',required_clarification:status==='needs_info'?'Укажите язык документа.':'',clarification_fields:status==='needs_info'?[{key:'reply',label:'Язык документа',type:'textarea',required:true,max_length:2000}]:[],links:[],fields:{}});
    d.request_history.push({history_id:`H-EXP-${n}`,request_id:requestId,occurred_at:date,status,message:status==='ready'?'Документ готов к выдаче.':'Обращение зарегистрировано.'});
  }
  d.range=['2026-11-01','2026-12-05'];
  d.catalog.course_details.forEach(c=>{
    const subject=d.subjects.find(s=>s.subject_id===c.subject_id);
    c.description=`Курс «${subject.subject_name}»: теория, практические занятия и работа над проектами. Материалы и результаты доступны в личном кабинете.`;
    c.consultation='По средам, 16:00–17:00, по предварительной записи';
  });
  d.teachers.forEach((t,i)=>Object.assign(t,{department:i===2?'Кафедра иностранных языков':'Кафедра маркетинга и управления',position:i%2?'Старший преподаватель':'Доцент',office:String(210+i),consultation:'Среда, 16:00–17:00',bio:'Ведет лекции, практические занятия и консультации по учебным проектам.',faculty:'Факультет маркетинга и управления'}));
  return d;
}
