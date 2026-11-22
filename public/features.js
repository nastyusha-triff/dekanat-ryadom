'use strict';
const prototypeNotice='Конкурсный прототип. Все данные вымышлены. Не является официальным сервисом вуза';
const requestNumber=r=>r.number?'№ '+String(r.number).padStart(4,'0'):r.id||r.request_id;
const courseTabsMemory=new Map();
let journalScenarioState=null, journalScenarioTimer;
const returnRoutes=new Map();
function nextStepsHtml(items){return `<section class="card next-steps"><h2>Мой следующий шаг</h2>${items.length?`<ol class="next-step-list">${[...items].sort((a,b)=>a.priority-b.priority).map(a=>`<li><a href="#${esc(a.route)}"><span class="step-kind">${esc(a.title)}</span><strong>${esc(a.reason)}</strong>${a.deadline?`<time datetime="${esc(a.deadline)}">${stamp(a.deadline)}</time>`:''}</a></li>`).join('')}</ol>`:'<p class="muted spaced">Срочных действий нет</p>'}</section>`;}

async function changesView(){const d=await collection('changes');return back('today','На главную')+heading('Изменения расписания','Последний перенос каждого актуального занятия. Сначала недавно объявленные. Время московское.')+`<div class="change-list">${d.items.map(changeCard).join('')}</div>`+(d.items.length?'':empty('Актуальных переносов нет'))+(d.has_more?'<button class="btn load-more" data-action="more">Показать еще</button>':'');}
function journalDate(value){return value?`<time datetime="${esc(value)}" title="Московское время"><span>${fmt(value,{day:'2-digit',month:'2-digit'})}<span class="date-year"><span class="date-separator">.</span>${fmt(value,{year:'numeric'}).replace(/[^0-9]/g,'')}</span></span><span>${fmt(value,{hour:'2-digit',minute:'2-digit'})}</span></time>`:'—';}
function journalScore(row){
 const state=journalScenarioState,input=state?.inputs.find(i=>i.id===row.id);
 if(state&&input){
  if(input.confirmed)return `<span title="Оценка зафиксирована">${number(input.value)} / ${number(input.max)}</span>`;
  return `<input class="scenario-score" data-scenario-input="${esc(row.id)}" type="number" inputmode="decimal" step="any" min="0" max="${input.max}" value="${esc(state.assumptions[row.id]??'')}" placeholder="—" aria-label="Предполагаемая оценка: ${esc(row.title)}" aria-describedby="journal-scenario-status"><small>из ${number(input.max)}</small>`;
 }
 if(!state&&teacher()&&row.type==='assignment')return `<button class="edit-score" data-edit="${esc(row.id)}" aria-label="Изменить оценку: ${esc(row.title)}">${row.edit.score===null?'Оценить':`${number(row.edit.score)} / ${number(row.max)}`}</button>${row.edit.graded_at&&Date.parse(row.edit.graded_at)>Date.parse(session.now)?'<small>Запланировано</small>':''}`;
 const r=state&&row.type==='calculated'?{...row,...state.rows.find(r=>r.id===row.id)}:row;
 return esc(points(r))+(r.status==='partial'?'<small>Промежуточный</small>':'')+(r.formula_error?`<small class="formula-error">${esc(r.formula_error)}</small>`:'');
}
function paintScenario(){
 const state=journalScenarioState;if(!state)return;
 for(const row of currentJournal.items.filter(r=>r.type==='calculated')){const cell=document.querySelector(`[data-scenario-result="${CSS.escape(row.id)}"]`);if(cell)cell.innerHTML=journalScore(row);}
}
function scenarioStatus(text){const el=$('#journal-scenario-status');if(el)el.textContent=text;}
async function updateJournalScenario(state,version){
 if(journalScenarioState!==state||version!==state.version)return;
 try{
  const result=await mutate(state.path,{assumptions:{...state.assumptions}});
  if(journalScenarioState!==state||version!==state.version)return;
  state.rows=result.rows;state.inputs=result.inputs;paintScenario();scenarioStatus('Прогноз · не сохраняется');
 }catch(error){if(journalScenarioState===state&&version===state.version)scenarioStatus(error.message);}
}
document.addEventListener('click',async e=>{
 const button=e.target.closest('[data-action="journal-calculator"]');if(!button)return;
 if(journalScenarioState){journalScenarioState=null;clearTimeout(journalScenarioTimer);$('#journal-table-wrap').innerHTML=journalTable(currentJournal);$('#journal-calculator').focus();return;}
 const journal=currentJournal,course=currentCourse,container=$('#journal-table-wrap');button.disabled=true;
 try{
  const path=`courses/${enc(course.id)}/scenario${teacher()?'?student_id='+enc(journal.student.id):''}`,data=await api(path);
  if(currentJournal!==journal||!container.isConnected)return;
  journalScenarioState={...data,path,assumptions:{},version:0};container.innerHTML=journalTable(journal);$('#journal-calculator').focus();
 }catch(error){if(container.isConnected){scenarioStatus(error.message);button.disabled=false;}}
});
document.addEventListener('input',e=>{
 const input=e.target.closest('[data-scenario-input]'),state=journalScenarioState;if(!input||!state)return;
 clearTimeout(journalScenarioTimer);const version=++state.version;
 // Do not leave a previous forecast visible while invalid/new inputs are pending.
 state.rows=state.rows.map(r=>({...r,value:null,status:'pending',formula_error:null}));paintScenario();
 const inputs=[...document.querySelectorAll('[data-scenario-input]')],invalid=inputs.find(el=>!el.validity.valid);
 if(invalid){scenarioStatus(`Укажите число от 0 до ${invalid.max}.`);invalid.setAttribute('aria-invalid','true');return;}
 state.assumptions=Object.fromEntries(inputs.filter(el=>el.value!=='').map(el=>[el.dataset.scenarioInput,Number(el.value)]));
 scenarioStatus('Пересчитываем прогноз…');journalScenarioTimer=setTimeout(()=>updateJournalScenario(state,version),200);
});
window.addEventListener('hashchange',()=>{journalScenarioState=null;clearTimeout(journalScenarioTimer);});
function reviewRequest(form){
  const d=draft('new'),t=session.ui.request_types.find(t=>t.id===d.type),p=session.user;
  $('#request-review').innerHTML=`<h2 tabindex="-1">Проверьте обращение</h2><p class="spaced"><strong>${esc(t.label)}</strong></p><p>${esc(p.full_name)} · ${esc(p.academic_group)}</p><dl class="request-info">${t.fields.map(f=>`<div><dt>${esc(f.label)}</dt><dd>${esc(f.options?.find(o=>o.value===d.fields[f.key])?.label||d.fields[f.key]||f.default||'Не указано')}</dd></div>`).join('')}</dl><p class="form-help">Точный срок пока неизвестен. Деканат укажет его в карточке после проверки обращения.</p><button type="button" class="btn quiet" data-action="edit-request">Изменить данные</button>`;
  $('#request-review').hidden=false;$('#request-review h2').focus();form.dataset.reviewed='yes';form.querySelector('button[type=submit]').textContent='Подтвердить и отправить';
}
document.addEventListener('input',e=>{e.target.setCustomValidity?.('');e.target.removeAttribute?.('aria-invalid');if(e.target.form?.id==='request-form'){delete e.target.form.dataset.reviewed;$('#request-review').hidden=true;e.target.form.querySelector('button[type=submit]').textContent='Проверить обращение';}});
document.addEventListener('invalid',e=>{const el=e.target;if(el.validity.valueMissing)el.setCustomValidity('Заполните это поле.');else if(el.validity.rangeUnderflow||el.validity.rangeOverflow)el.setCustomValidity(`Укажите число от ${el.min} до ${el.max}.`);else if(el.validity.typeMismatch)el.setCustomValidity('Проверьте формат значения.');},true);
document.addEventListener('click',e=>{const el=e.target.closest('button,a');if(!el)return;if(el.dataset.tab&&currentCourse)courseTabsMemory.set(currentCourse.id,el.dataset.tab);if(el.dataset.action==='edit-request'){const f=$('#request-form');delete f.dataset.reviewed;$('#request-review').hidden=true;f.querySelector('button[type=submit]').textContent='Проверить обращение';$('#request-type').focus();}});

function requestFieldsHtml(r){const type=session.ui.request_types.find(t=>t.id===r.request_type);return `<dl class="request-info">${Object.entries(r.fields||{}).map(([key,value])=>{const f=type?.fields.find(f=>f.key===key);return `<div><dt>${esc(f?.label||key)}</dt><dd>${esc(f?.options?.find(o=>o.value===value)?.label||value)}</dd></div>`;}).join('')}</dl>`;}

document.addEventListener('click',e=>{const link=e.target.closest('a[href^="#"]');if(link&&!link.classList.contains('back')&&link.hash.slice(1)!==route())returnRoutes.set(decodeURI(link.hash.slice(1)),route());});
