'use strict';
let courseManagement=null,editorContext=null;
const inputField=(key,label,value='',type='text',required=true)=>fieldHtml({key,label,type,required,max_length:type==='textarea'?4000:1000},value);
const selectField=(key,label,options,value)=>fieldHtml({key,label,type:'select',required:true,options:options.map(([value,label])=>({value,label}))},value);
const editorButtons=label=>`<div class="form-error" role="alert"></div><div class="button-row"><button class="btn primary" type="submit">${label}</button><button class="btn" type="button" data-action="close-editor">Отмена</button></div>`;
function openEditor(title,markup,context){
  document.querySelector('#manage-dialog')?.remove();editorContext=context;
  document.body.insertAdjacentHTML('beforeend',`<dialog id="manage-dialog" class="manage-dialog" aria-labelledby="manage-title"><div class="dialog-head"><h2 id="manage-title">${esc(title)}</h2><button class="icon-button" data-action="close-editor" aria-label="Закрыть">×</button></div><form id="manage-form">${markup}${editorButtons('Сохранить')}</form></dialog>`);
  $('#manage-dialog').showModal();
}
function rosterMarkup(students,selected=students.map(s=>s.id)){
  const groups=[...new Set(students.map(s=>s.academic_group))];
  return `<fieldset class="roster"><legend>Кто посещает занятие</legend><div class="button-row">${groups.map(g=>`<button type="button" class="btn quiet" data-roster-group="${esc(g)}">${esc(g)}</button>`).join('')}<button type="button" class="btn quiet" data-action="roster-clear">Снять выбор</button></div><div class="student-checks">${students.map(s=>`<label><input type="checkbox" name="student_ids" value="${esc(s.id)}" data-group="${esc(s.academic_group)}" ${selected.includes(s.id)?'checked':''}><span>${esc(s.full_name)}<small>${esc(s.academic_group)}</small></span></label>`).join('')}</div></fieldset>`;
}
async function loadEditorRoster(id,selected){
  const token=id;editorContext.courseId=id;
  const roster=await collection(`courses/${enc(id)}/students`,200);
  if(editorContext?.courseId!==token||!$('#editor-roster'))return;
  $('#editor-roster').innerHTML=rosterMarkup(roster.items,selected);
}
async function openLessonEditor(id){
  const l=id?await api('lessons/'+enc(id)):null,courses=await collection('courses',200),selected=l?.subject_id||currentCourse?.id||courses.items[0]?.id;
  if(l&&!l.editable)throw new Error('Прошедшее занятие нельзя редактировать.');
  if(!selected)throw new Error('Сначала нужна назначенная дисциплина.');
  openEditor(id?'Редактировать пару':'Добавить пару',selectField('subject_id','Дисциплина',courses.items.map(c=>[c.id,`${c.name} · ${c.course} курс`]),selected)+`<div class="form-grid">${inputField('date','Дата',l?.date||scheduleDate||session.today,'date')}${inputField('room','Аудитория',l?.room||'')}${inputField('start_time','Начало',l?.start_time||'09:00')}${inputField('end_time','Окончание',l?.end_time||'10:30')}</div>`+inputField('topic','Тема занятия',l?.topic||'','text',false)+'<section class="slot-picker"><h3>Подобрать свободное время</h3><p class="small muted">Сначала проверьте аудиторию, длительность и состав студентов. Время московское.</p><button type="button" class="btn spaced" data-action="find-slots">Найти ближайшие слоты</button><div id="slot-results" aria-live="polite"></div></section><div id="editor-roster" aria-live="polite">Загружаем студентов…</div>',{kind:'lesson',id:l?.lesson_id,version:l?.version,courseId:selected});
  for(const key of ['start_time','end_time'])$('#manage-form [name='+key+']').type='time';
  if(l)$('#manage-form [name=subject_id]').disabled=true;
  await loadEditorRoster(selected,l?.student_ids);
}
async function courseManageView(c){
  courseManagement=await api(`courses/${enc(c.id)}/manage`);
  return `<div class="management-grid"><section class="card manage-section"><div class="sectionhead"><h2>Данные курса</h2><button class="btn" data-action="edit-course">Редактировать</button></div><p class="muted">Название, описание, аттестация, консультации и ссылки на материалы.</p><button class="btn spaced" data-action="new-lesson">Добавить пару</button></section><section class="card manage-section"><div class="sectionhead"><h2>Задания и оценки</h2><button class="btn primary" data-action="new-assignment">Добавить работу</button></div><p class="small muted">Оценки выставляются в журнале выбранного студента.</p><div class="manage-records">${courseManagement.assignments.map(a=>`<div class="manage-record"><div><strong>${esc(a.title)}</strong><p class="small muted">${esc(a.kind)} · до ${number(a.max_score)} баллов</p></div><button class="btn quiet" data-edit-assignment="${esc(a.id)}" aria-label="Редактировать задание: ${esc(a.title)}">Изменить</button></div>`).join('')}</div></section><section class="card manage-section"><div class="sectionhead"><h2>Расчетные результаты</h2><button class="btn" data-action="new-rule">Добавить формулу</button></div><p class="small muted">Добавьте новую работу в нужную формулу, если она должна влиять на итог.</p><div class="manage-records">${courseManagement.rules.map(r=>`<div class="manage-record"><div><strong>${esc(r.title)}</strong><p class="small muted">${esc({sum:'Сумма',weighted:'Взвешенный результат',average:'Среднее',best_n:'Лучшие работы',threshold:'Зачет по порогу',provided:'Расчет с бонусом',expression:r.expression}[r.operation])}</p></div><button class="btn quiet" data-edit-rule="${esc(r.id)}" aria-label="Редактировать формулу: ${esc(r.title)}">Изменить</button></div>`).join('')}</div></section><section class="card manage-section"><div class="sectionhead"><h2>Экзамены и зачеты</h2><button class="btn" data-action="new-exam">Назначить</button></div><div class="manage-records">${courseManagement.exams.map(e=>`<div class="manage-record"><div><strong>${fmt(e.date)}</strong><p class="small muted">${esc(e.start_time)}–${esc(e.end_time)} · Ауд. ${esc(e.room)}</p></div><button class="btn quiet" data-edit-exam="${esc(e.id)}">Изменить</button></div>`).join('')||'<p class="muted">Аттестация пока не назначена.</p>'}</div></section></div>`;
}
function courseEditor(){
  const c=currentCourse;
  openEditor('Редактировать курс',inputField('name','Название',c.name)+inputField('description','О курсе',c.description||'','textarea',false)+selectField('assessment_type','Аттестация',[['exam','Экзамен'],['pass_fail','Зачет'],['none','Без экзамена']],c.assessment_type)+inputField('consultation','Консультации',c.consultation||'','text',false)+inputField('chat_url','Ссылка на чат',c.resources?.find(r=>r.icon==='chat')?.url||'','text',false)+inputField('materials_url','Ссылка на материалы',c.resources?.find(r=>r.icon==='book')?.url||'','text',false),{kind:'course',courseId:c.id,version:c.version});
}
async function assignmentEditor(id){
  courseManagement=await api(`courses/${enc(currentCourse.id)}/manage`);
  const a=courseManagement.assignments.find(a=>a.id===id);
  const due=a?.due_at?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(a.due_at)).replace(' ','T'):'';
  openEditor(a?'Редактировать работу':'Добавить работу',inputField('title','Наименование',a?.title||'')+selectField('assessment_group','Раздел',[['coursework','Работа в семестре'],['exam','Экзаменационная работа']],a?.assessment_group||'coursework')+inputField('kind','Вид работы',a?.kind||'Практическая работа')+inputField('max_score','Максимальный балл',a?.max_score||10,'number')+`<label class="field"><span>Дедлайн, московское время</span><input name="due_at" type="datetime-local" value="${esc(due)}"><small>Необязательно. Дата и время крайнего срока сдачи.</small></label><p class="form-help">Работа появится в журнале всех студентов курса. Выставьте оценки на вкладке «Студенты». Включить работу в расчет можно в разделе формул.</p>`,{kind:'assignment',courseId:currentCourse.id,id:a?.id,version:a?.version,published_at:a?.published_at});
  $('#manage-form [name=max_score]').step='any';
}
function structuredRuleEditor(id){
  const r=courseManagement.rules.find(x=>x.id===id),selected=(r?.input_ids||'').split('|'),allOptions=[...courseManagement.assignments.map(a=>[a.id,a.title]),...courseManagement.rules.filter(x=>x.id!==id).map(x=>[x.id,x.title])];
  const options=[...selected.map(id=>allOptions.find(([value])=>value===id)).filter(Boolean),...allOptions.filter(([id])=>!selected.includes(id))];
  openEditor(r?'Редактировать формулу':'Добавить формулу',inputField('title','Название результата',r?.title||'')+selectField('operation','Способ расчета',[['sum','Сумма'],['weighted','Взвешенный результат'],['average','Среднее'],['best_n','Лучшие N работ'],['threshold','Зачет по порогу'],...(r?.operation==='provided'?[['provided','Взвешенный результат с бонусом']]:[])],r?.operation||'sum')+`<fieldset class="roster"><legend>Работы и результаты в формуле</legend><div class="student-checks">${options.map(([value,label])=>`<label><input type="checkbox" name="input_ids" value="${esc(value)}" ${selected.includes(value)?'checked':''}><span>${esc(label)}</span></label>`).join('')}</div></fieldset>`+inputField('weights','Веса через | (например, 0.6|0.4)',r?.weights||r?.implementation?.weights?.join('|')||'','text',false)+inputField('parameter','N или порог зачета',r?.parameter||'','text',false)+(r?.operation==='provided'?inputField('bonus','Бонус',r.implementation?.bonus||0,'number'):'')+inputField('output_max','Максимум результата',r?.output_max||100,'number')+selectField('role','Назначение',[['additional','Дополнительный результат'],['progress','Текущий результат'],['final','Итог по дисциплине'],['exam','Экзамен']],r?.role||'additional')+selectField('missing_policy','Если не все оценки выставлены',[['partial','Показывать промежуточный результат'],['wait','Ждать все оценки']],r?.missing_policy||'partial')+selectField('visibility','Когда показывать',[['always','В течение семестра'],['after_exam','После экзамена']],r?.visibility||'always'),{kind:'rule',courseId:currentCourse.id,id:r?.id,version:r?.revision});
}
function ruleEditor(id){
  const r=courseManagement.rules.find(x=>x.id===id);
  if(r&&r.operation!=='expression'){structuredRuleEditor(id);return;}
  const options=[...courseManagement.assignments.map(a=>[a.id,a.title]),...courseManagement.rules.filter(x=>x.id!==id).map(x=>[x.id,x.title])];
  openEditor(r?'Редактировать формулу':'Добавить формулу',inputField('title','Название результата',r?.title||'')+inputField('expression','Формула',r?.expression||'','textarea')+`<p class="form-help">Например: 0.6 * [Задание 1] + 0.4 * [Задание 2]. Доступны +, −, *, /, скобки, sum, min и max: sum([Задание 1], [Задание 2]). Баллы используются как есть. Расчет появится после публикации всех входящих оценок.</p><details class="formula-references"><summary>Вставить оценку в формулу</summary><div class="formula-chips">${options.map(([value,label])=>`<button class="btn quiet" type="button" data-formula-ref="${esc(options.filter(x=>x[1]===label).length>1?value:label)}">${esc(label)}</button>`).join('')}</div></details>`+inputField('output_max','Максимум результата',r?.output_max||100,'number')+selectField('role','Назначение',[['additional','Дополнительный результат'],['progress','Текущий результат'],['final','Итог по дисциплине'],['exam','Экзамен']],r?.role||'additional')+selectField('visibility','Когда показывать',[['always','В течение семестра'],['after_exam','После экзамена']],r?.visibility||'always'),{kind:'rule',expression:true,courseId:currentCourse.id,id:r?.id,version:r?.revision});
  $('#manage-form [name=expression]').maxLength=2000;
  $('#manage-form [name=output_max]').step='any';
}
function profileEditor(){
  const u=session.user;
  openEditor('Редактировать профиль',inputField('email','Почта',u.email||'','email')+inputField('phone','Телефон',u.phone||'','tel',false)+(teacher()?inputField('consultation','Приемные часы',u.consultation||'','textarea',false):''),{kind:'profile',version:u.profile_version});
  $('#manage-form [name=email]').maxLength=254;$('#manage-form [name=phone]').maxLength=30;
  if(teacher())$('#manage-form [name=consultation]').maxLength=500;
}
async function examEditor(id){
  const e=courseManagement.exams.find(x=>x.id===id);
  openEditor(e?'Изменить аттестацию':'Назначить аттестацию',`<div class="form-grid">${inputField('date','Дата',e?.date||'','date')}${inputField('room','Аудитория',e?.room||'')}${inputField('start_time','Начало',e?.start_time||'10:00')}${inputField('end_time','Окончание',e?.end_time||'11:30')}</div><div id="editor-roster">Загружаем студентов…</div>`,{kind:'exam',courseId:currentCourse.id,id:e?.id,version:e?.version});
  for(const key of ['start_time','end_time'])$('#manage-form [name='+key+']').type='time';
  await loadEditorRoster(currentCourse.id,e?.student_ids);
}
async function teacherView(id){
  const t=await api('teachers/'+enc(id));
  return back('grades','К дисциплинам')+heading(t.full_name,t.position||'Преподаватель')+`<div class="profile-layout"><section class="card"><div class="profile-person"><span class="avatar profile-avatar">${esc(initial(t.full_name))}</span><div><h2>${esc(t.department)}</h2><p class="muted">${esc(t.faculty)}</p></div></div><p class="spaced">${esc(t.bio)}</p><dl class="facts spaced"><div><dt>Кабинет</dt><dd>${esc(t.office)}</dd></div><div><dt>Консультации</dt><dd>${esc(t.consultation)}</dd></div></dl><a class="contact-link" href="mailto:${esc(t.email)}">${icon('mail')}<span>${esc(t.email)}</span></a></section><section class="card"><h2>Дисциплины</h2><div class="teacher-courses">${t.courses.map(c=>`<p>${esc(c.name)}</p>`).join('')}</div></section></div>`;
}
async function deaneryHome(){
  const [d,r]=await Promise.all([api('deanery/overview'),api('requests?status=active&limit=5')]);
  return heading('Рабочий день деканата',fmt(session.today,{weekday:'long',day:'numeric',month:'long',year:'numeric'}),button('Все заявки','#requests',true))+`<div class="office-metrics">${[['submitted','Новые'],['in_progress','В работе'],['needs_info','Ждем уточнения'],['ready','Готовы']].map(([id,label],i)=>`<button class="card metric-card tone-${i}" data-office-filter="${id}"><span>${label}</span><strong>${d.counts.find(x=>x.status===id)?.count||0}</strong></button>`).join('')}</div><section class="spaced"><div class="sectionhead"><h2>Последние активные обращения</h2><span class="small muted">${d.students} студентов</span></div><div class="request-list">${r.items.map(requestRow).join('')||empty('Активных обращений нет')}</div></section>`;
}
function staffReplyForm(r){
  const d=draft('staff:'+r.id)||{};
  return `<section class="card"><h2>Ответить студенту</h2><form id="staff-reply-form" data-id="${esc(r.id)}" data-version="${r.version}" class="spaced">${selectField('status','Новый статус',r.allowed_statuses.map(id=>[id,statusLabel(id)]),d.status||r.status)}${inputField('response','Ответ деканата',d.response||'','textarea')}${inputField('next_action','Следующий шаг для студента',d.next_action||r.next_action,'textarea')}${inputField('expected_ready_date','Ожидаемая дата готовности',d.expected_ready_date??r.expected_ready_date??'','date',false)}${selectField('delivery_method','Способ получения',[['portal','Ответ в портале'],['pickup','Лично в деканате']],d.delivery_method||r.delivery_method)}<details class="spaced"><summary>Выдача документа и уточнения</summary><div class="spaced">${inputField('pickup_location','Место выдачи',d.pickup_location??r.pickup_location??'Кабинет 102','text',false)}${inputField('pickup_hours','Часы выдачи',d.pickup_hours??r.pickup_hours??'Пн–пт, 10:00–17:00','text',false)}${inputField('required_clarification','Что нужно уточнить',d.required_clarification??r.required_clarification??'','textarea',false)}</div></details><div class="form-error" role="alert"></div><button type="submit" class="btn primary spaced">Отправить ответ и сохранить статус</button></form></section>`;
}
async function managementSubmit(form){
  if(form.id==='staff-reply-form'){
    const values=Object.fromEntries(new FormData(form));draft('staff:'+form.dataset.id,values);
    await submitForm(form,async()=>{await mutate('requests/'+enc(form.dataset.id),{...values,version:Number(form.dataset.version)},'PATCH');draft('staff:'+form.dataset.id,null);success='Ответ отправлен. Статус заявки обновлен.';await render();});return true;
  }
  if(form.id!=='manage-form')return false;
  await submitForm(form,async()=>{
    const c=editorContext,f=new FormData(form),values=Object.fromEntries(f),b={...values,version:c.version};
    let path='',method=c.id?'PUT':'POST';
    if(c.kind==='profile'){path='profile';method='PUT';}
    if(c.kind==='course'){path='courses/'+enc(c.courseId);method='PUT';}
    if(c.kind==='lesson'){b.student_ids=f.getAll('student_ids');b.subject_id=c.courseId;path='lessons'+(c.id?'/'+enc(c.id):'');}
    if(c.kind==='assignment'){b.due_at=b.due_at?b.due_at+':00+03:00':'';b.max_score=Number(b.max_score);b.published_at=c.published_at;path=`courses/${enc(c.courseId)}/assignments${c.id?'/'+enc(c.id):''}`;}
    if(c.kind==='rule'){if(c.expression){b.operation='expression';b.missing_policy='wait';}b.input_ids=f.getAll('input_ids').join('|');b.output_max=Number(b.output_max);b.bonus=Number(b.bonus||0);path=`courses/${enc(c.courseId)}/rules${c.id?'/'+enc(c.id):''}`;}
    if(c.kind==='exam'){b.student_ids=f.getAll('student_ids');path=`courses/${enc(c.courseId)}/exam${c.id?'/'+enc(c.id):''}`;}
    await mutate(path,b,method);$('#manage-dialog').close();$('#manage-dialog').remove();editorContext=null;success='Изменения сохранены.';await render();
  });return true;
}
async function managementClick(el){
  const action=el.dataset.action;
  if(el.dataset.officeFilter){requestFilter=el.dataset.officeFilter;location.hash='requests';return true;}
  if(action==='find-slots'){const f=new FormData($('#manage-form'));el.disabled=true;try{const d=await mutate('lessons/slots',{...Object.fromEntries(f),student_ids:f.getAll('student_ids'),subject_id:editorContext.courseId,lesson_id:editorContext.id});$('#slot-results').innerHTML=`<p class="small muted spaced">${esc(d.note)}</p><div class="slot-options">${d.slots.map(s=>`<button type="button" class="btn" data-slot="${s.date}|${s.start_time}|${s.end_time}"><strong>${fmt(s.date)}</strong><span>${s.start_time}–${s.end_time}</span></button>`).join('')||'<p>Свободных слотов в этом диапазоне нет. Измените дату или аудиторию.</p>'}</div>`;}finally{el.disabled=false;}return true;}
  if(el.dataset.slot){const [date,start,end]=el.dataset.slot.split('|'),f=$('#manage-form');f.elements.date.value=date;f.elements.start_time.value=start;f.elements.end_time.value=end;$('#slot-results').innerHTML='<p class="success-note">Время перенесено в форму. Проверьте данные и сохраните.</p>';return true;}
  if(action==='close-editor'){$('#manage-dialog')?.close();$('#manage-dialog')?.remove();editorContext=null;return true;}
  if(el.dataset.rosterGroup){document.querySelectorAll('#editor-roster input[type=checkbox]').forEach(x=>{if(x.dataset.group===el.dataset.rosterGroup)x.checked=true;});return true;}
  if(action==='roster-clear'){document.querySelectorAll('#editor-roster input[type=checkbox]').forEach(x=>x.checked=false);return true;}
  if(action==='new-lesson'||el.dataset.editLesson){await openLessonEditor(el.dataset.editLesson);return true;}
  if(action==='edit-profile'){profileEditor();return true;}
  if(el.dataset.formulaRef){const input=$('#manage-form [name=expression]');input.setRangeText('['+el.dataset.formulaRef+']',input.selectionStart,input.selectionEnd,'end');input.focus();return true;}
  if(action==='edit-course'){courseEditor();return true;}
  if(action==='new-assignment'||el.dataset.editAssignment){await assignmentEditor(el.dataset.editAssignment);return true;}
  if(action==='new-rule'||el.dataset.editRule){ruleEditor(el.dataset.editRule);return true;}
  if(action==='new-exam'||el.dataset.editExam){await examEditor(el.dataset.editExam);return true;}
  return false;
}
document.addEventListener('input',event=>{if(event.target.form?.id==='staff-reply-form')draft('staff:'+event.target.form.dataset.id,Object.fromEntries(new FormData(event.target.form)));});
document.addEventListener('change',async event=>{
  if(event.target.form?.id==='manage-form'&&event.target.name==='subject_id'){
    try{await loadEditorRoster(event.target.value);}catch(e){$('#manage-form .form-error').textContent=e.message;}
  }
  if(event.target.form?.id==='staff-reply-form'&&event.target.name==='status'){
    const form=event.target.form,next={in_progress:'Обращение принято в работу. Ожидайте ответа деканата.',needs_info:'Отправьте уточнение через форму в этой заявке.',ready:'Результат готов. Ознакомьтесь с ответом деканата.',closed:'Обращение завершено.'};
    if(next[event.target.value])form.elements.next_action.value=next[event.target.value];
    if(event.target.value==='needs_info'){form.querySelector('details').open=true;form.elements.required_clarification.focus();}
    draft('staff:'+form.dataset.id,Object.fromEntries(new FormData(form)));
  }
});
