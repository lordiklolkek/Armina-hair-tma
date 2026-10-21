import {words} from './i18n.js';
const tg=window.Telegram?.WebApp;tg?.ready();tg?.expand();
const $=id=>document.getElementById(id),root=$('content');
let language=localStorage.getItem('37-language')==='ru'?'ru':'hy';
const state={view:'services',step:1,config:{},catalog:{services:[],barbers:[],links:[],absences:[]},me:null,service:null,barber:null,date:null,time:null,key:null,editing:null,manual:false,staffId:null,request:0};
const t=k=>words[language][k]||k;
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined&&text!==null)node.textContent=text;if(cls)node.className=cls;return node;};
const title=s=>s[`title_${language}`];
const amd=v=>new Intl.NumberFormat(language==='hy'?'hy-AM':'ru-RU').format(v)+' ֏';
const price=s=>s.price_min===s.price_max?amd(s.price_min):`${amd(s.price_min)} – ${amd(s.price_max)}`;
const timeText=v=>new Intl.DateTimeFormat(language==='hy'?'hy-AM':'ru-RU',{timeZone:'Asia/Yerevan',hour:'2-digit',minute:'2-digit',hour12:false}).format(v*1000);
const dateText=v=>new Intl.DateTimeFormat(language==='hy'?'hy-AM':'ru-RU',{timeZone:'Asia/Yerevan',day:'numeric',month:'long',weekday:'short'}).format(v*1000);
const today=()=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Yerevan',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
let toastTimer;
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
async function api(path,method='GET',body,key){
 const response=await fetch('/api'+path,{method,headers:{...(tg?.initData?{'X-Telegram-Init-Data':tg.initData}:{}),...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});
 const data=await response.json().catch(()=>({}));
 if(!response.ok){const error=new Error(words[language].errors[data.error]||t('error'));error.code=data.error;error.data=data;throw error;}
 return data;
}
function button(label,action,cls='secondary'){const b=el('button',label,cls);b.type='button';b.addEventListener('click',async()=>{b.disabled=true;try{await action();}catch(error){toast(error.message);}finally{b.disabled=false;}});return b;}
function input(form,label,name,value='',type='text'){const id='field-'+crypto.randomUUID(),l=el('label',label),node=el(type==='textarea'?'textarea':'input');node.id=id;node.name=name;if(type!=='textarea')node.type=type;if(type==='checkbox')node.checked=Boolean(value);else node.value=value??'';l.htmlFor=id;form.append(l,node);return node;}
function select(form,label,name,items,value){const id='select-'+crypto.randomUUID(),l=el('label',label),node=el('select');node.id=id;node.name=name;l.htmlFor=id;for(const [id,text]of items){const option=el('option',text);option.value=id;node.append(option);}if(value!=null)node.value=value;form.append(l,node);return node;}
function formSave(form,action){const b=el('button',t('save'),'primary');b.type='submit';form.append(b);form.addEventListener('submit',async e=>{e.preventDefault();if(!form.reportValidity())return;b.disabled=true;try{await action(new FormData(form));toast(t('saved'));}catch(error){toast(error.message);}finally{b.disabled=false;}});}
const heading=(name,copy)=>{root.append(el('h2',name));if(copy)root.append(el('p',copy,'muted'));};
function chrome(){
 $('hero').hidden=state.view!=='services';
 document.documentElement.lang=language;$('language').textContent=language==='hy'?'RU':'ՀԱՅ';
 $('demo').textContent=t('demo');$('hero-label').textContent=t('heroLabel');$('hero-title').textContent=t('heroTitle');$('hero-copy').textContent=t('heroCopy');$('address').textContent=state.config.address||'Շահումյան 33, Կապան, Հայաստան';$('city').textContent=language==='hy'?'ԿԱՊԱՆ · ՀԱՅԱՍՏԱՆ':'КАПАН · АРМЕНИЯ';
 $('footer').replaceChildren(el('span','37 BARBERSHOP'),el('span',t('timezone')));
 if(state.config.logo_url){const image=el('img');image.src=state.config.logo_url;image.alt=state.config.name;image.style.cssText='max-width:52px;max-height:52px';$('logo').replaceChildren(image);}
 const nav=$('nav');nav.replaceChildren();
 for(const view of ['services','my',...(state.me?.barberId?['staff']:[]),...(state.me?.owner?['owner']:[])]){
  const b=button(t(view),()=>{state.view=view;state.editing=null;state.manual=false;return render();});b.className=state.view===view?'active':'';nav.append(b);
 }
}
async function refreshCatalog(){state.catalog=await api('/catalog');}
function newFlow(){Object.assign(state,{view:'services',step:1,service:null,barber:null,date:null,time:null,key:null,editing:null,manual:false});return render();}
async function render(){chrome();root.replaceChildren();state.request++;try{if(state.view==='services')renderBooking();else if(state.view==='my')await renderBookings('mine');else if(state.view==='staff')await renderStaff(state.me.barberId);else await renderOwner();}catch(error){root.append(el('p',error.message,'notice'));}}
function renderBooking(){
 if(state.step===1){
  const top=el('div',null,'section-head'),labels=el('div');labels.append(el('h2',t('choose')),el('p',t('chooseCopy'),'muted'));top.append(labels,el('span',String(state.catalog.services.length).padStart(2,'0'),'count'));root.append(top);
  state.catalog.services.forEach((service,i)=>{
   const b=button('',()=>{state.service=service;state.step=state.manual?3:2;if(state.manual)state.barber=state.staffId;state.key=null;return render();},'service');
   b.append(el('span',String(i+1).padStart(2,'0'),'service-icon'));const info=el('div');info.append(el('strong',title(service)));const meta=el('div',null,'meta');meta.append(el('span',price(service)),el('span',`${service.duration} ${t('min')}`));info.append(meta);b.append(info,el('span','↗','arrow'));root.append(b);
  });root.append(el('p',t('durationNote'),'muted'));return;
 }
 if(state.step===2){
  root.append(button('‹ '+t('back'),()=>{state.step=1;return render();},'plain'));heading(t('barber'),title(state.service));
  const choices=state.manual?state.catalog.barbers.filter(b=>b.id===state.staffId):state.catalog.barbers.filter(b=>state.catalog.links.some(l=>l.barber_id===b.id&&l.service_id===state.service.id));
  const grid=el('div',null,'barbers');
  for(const barber of [...(!state.manual?[{id:null,name:t('any')}]:[]),...choices]){
   const b=button('',()=>{state.barber=barber.id;state.step=3;state.time=null;state.key=null;return render();},'barber');b.append(el('span',barber.id?'37':'↗','avatar'),el('strong',barber.name));
   const link=state.catalog.links.find(l=>l.barber_id===barber.id&&l.service_id===state.service.id);b.append(el('small',barber.id?`${link?.duration||state.service.duration} ${t('min')}`:t('anyCopy')));
   const away=state.catalog.absences.find(a=>a.barber_id===barber.id&&a.starts_at<=Date.now()/1000&&a.ends_at>Date.now()/1000);if(away)b.append(el('small',away.kind==='vacation'?`${t('vacation')} · ${dateText(away.ends_at)}`:t('unavailable')));
   grid.append(b);
  }root.append(grid);return;
 }
 if(state.step===3){
  root.append(button('‹ '+t('back'),()=>{state.step=2;return render();},'plain'));heading(state.editing?t('move'):t('date'),title(state.service));
  const date=input(root,t('date'),'day',state.date||today(),'date');date.min=today();date.max=new Date(Date.parse(today()+'T12:00:00Z')+(state.config.advance_days||30)*86400000).toISOString().slice(0,10);
  const slots=el('div',null,'slots'),caption=el('p',t('time'),'muted');root.append(caption,slots);
  const next=button(t('continue')+' ↗',()=>{state.step=4;return render();},'primary');next.disabled=true;root.append(next);
  const load=async()=>{
   const requestId=++state.request;state.date=date.value;state.time=null;next.disabled=true;slots.replaceChildren(el('p',t('loading'),'muted'));
   if(!tg?.initData){slots.replaceChildren();root.append(el('p',t('openTelegram'),'notice'));return;}
   try{
    const query=new URLSearchParams({date:state.date,service_id:state.service.id});if(state.barber)query.set('barber_id',state.barber);if(state.editing)query.set('booking_id',state.editing.id);if(state.manual)query.set('manual','1');
    const result=await api('/slots?'+query);if(requestId!==state.request)return;slots.replaceChildren();
    if(!result.slots.length){slots.append(el('p',t('noSlots'),'muted'));return;}
    result.slots.forEach(slot=>{const b=button(timeText(slot.starts_at),()=>{state.time=slot.starts_at;state.key=null;for(const node of slots.children)node.classList.remove('selected');b.classList.add('selected');next.disabled=false;},'slot');slots.append(b);});
   }catch(error){if(requestId===state.request){slots.replaceChildren();root.append(el('p',error.message,'notice'));}}
  };date.addEventListener('change',load);void load();return;
 }
 if(state.step===4){
  root.append(button('‹ '+t('back'),()=>{state.step=3;return render();},'plain'));heading(t('confirm'));
  const card=el('div',null,'card'),master=state.catalog.barbers.find(b=>b.id===state.barber);card.append(el('h3',title(state.service)),el('p',master?.name||t('any')),el('p',`${dateText(state.time)} · ${timeText(state.time)}`),el('h3',price(state.service)));root.append(card);
  if(state.service.price_min!==state.service.price_max)root.append(el('p',t('rangeNote'),'notice'));
  root.append(el('p',t('privacy'),'muted'));
  root.append(button(t('confirm')+' ↗',async()=>{
   state.key??=crypto.randomUUID();
   if(state.editing)await api('/bookings/'+state.editing.id,'PATCH',{version:state.editing.version,starts_at:state.time});
   else await api(state.manual?'/manual-bookings':'/bookings','POST',{service_id:state.service.id,barber_id:state.barber,starts_at:state.time},state.key);
   state.step=5;await render();
  },'primary'));return;
 }
 root.append(el('div','✓','success-mark'));heading(t('done'),t('doneCopy'));root.append(button(t('my'),()=>{state.view='my';return render();},'primary'),button(t('newBooking'),newFlow,'plain'));
}
async function renderBookings(scope,target=root,barberId=null){
 if(target===root)heading(scope==='all'?t('allBookings'):scope==='staff'?t('staff'):t('my'));
 const records=await api('/bookings?scope='+scope),bookings=barberId?records.filter(b=>b.barber_id===barberId):records;if(!bookings.length)target.append(el('p',t('empty'),'muted'));
 for(const booking of bookings){
  const card=el('article',null,'card');card.append(el('span',t(booking.status),'status'),el('h3',title(booking)),el('p',`${dateText(booking.starts_at)} · ${timeText(booking.starts_at)}`),el('p',booking.barber_name,'muted'),el('p',price(booking),'muted'));if(scope!=='mine')card.append(el('p',booking.client_name));
  const actions=el('div',null,'actions');
  if(['confirmed','pending'].includes(booking.status)){
   actions.append(button(t('cancel'),async()=>{if(!window.confirm(t('deleteConfirm')))return;await api('/bookings/'+booking.id,'PATCH',{version:booking.version,status:'cancelled'});await render();}));
   actions.append(button(t('move'),()=>{state.editing=booking;state.manual=false;state.service={...booking,id:booking.service_id,duration:(booking.ends_at-booking.starts_at)/60};state.barber=booking.barber_id;state.view='services';state.step=3;return render();}));
   if(scope!=='mine')for(const status of [...(booking.status==='pending'?['confirmed']:[]),'completed','no_show'])actions.append(button(t(status),async()=>{await api('/bookings/'+booking.id,'PATCH',{version:booking.version,status});await render();}));
  }
  if(scope==='mine')actions.append(button(t('repeat'),()=>{state.service=state.catalog.services.find(s=>s.id===booking.service_id);if(!state.service)return newFlow();state.view='services';state.step=2;state.editing=null;state.manual=false;return render();}));
  card.append(actions);
  if(scope!=='mine'&&['confirmed','pending'].includes(booking.status)){
   const details=el('details');details.append(el('summary',t('edit')));const f=el('form');input(f,t('finalPrice'),'final_price',booking.final_price??'','number');const extra=input(f,t('extraTime'),'extra_minutes',0,'number');extra.min='0';extra.max='120';extra.step='5';formSave(f,async d=>{await api('/bookings/'+booking.id,'PATCH',{version:booking.version,extra_minutes:Number(d.get('extra_minutes')),...(d.get('final_price')!==''?{final_price:Number(d.get('final_price'))}:{})});await render();});details.append(f);card.append(details);
  }
  target.append(card);
 }
}
async function renderOwner(){
 heading(t('owner'));const subnav=el('div',null,'actions');root.append(subnav);const panel=el('div');root.append(panel);
 async function show(action){panel.replaceChildren();try{await action();}catch(e){panel.append(el('p',e.message,'notice'));}}
 subnav.append(button(t('selectBarber'),()=>show(()=>ownerBarbers(panel))),button(t('prices'),()=>show(()=>ownerServices(panel))),button(t('allBookings'),()=>show(()=>renderBookings('all',panel))),button(t('settings'),()=>show(()=>ownerSettings(panel))));
 await show(()=>ownerBarbers(panel));
}
async function ownerBarbers(panel){
 const barbers=await api('/owner/barbers');
 const add=el('form',null,'card');input(add,t('name'),'name').required=true;formSave(add,async f=>{await api('/owner/barbers','POST',{name:f.get('name')});panel.replaceChildren();await ownerBarbers(panel);});panel.append(el('h2',t('addBarber')),add);
 for(const barber of barbers){
  const card=el('article',null,'card');card.append(el('h3',barber.name),el('p',`${barber.archived?t('archived'):barber.active?t('active'):t('unavailable')} · ${t('future')}: ${barber.future_count}`,'muted'));
  const actions=el('div',null,'actions');actions.append(button(t('edit'),()=>{panel.replaceChildren();return editBarber(panel,barber);}));
  actions.append(button(t('staff'),async()=>{state.staffId=barber.id;root.replaceChildren();await renderStaff(barber.id);}));
  actions.append(button(barber.archived?t('restore'):t('archive'),async()=>{
   const data={version:barber.version,archived:!barber.archived};if(!barber.archived&&barber.future_count){if(!window.confirm(`${t('future')}: ${barber.future_count}. ${t('keep')}?`))return;data.future_action='keep';}
   await api('/owner/barbers/'+barber.id,'PATCH',data);await refreshCatalog();panel.replaceChildren();await ownerBarbers(panel);
  }));card.append(actions);panel.append(card);
 }
}
async function editBarber(panel,barber){
 const f=el('form',null,'card');input(f,t('name'),'name',barber.name).required=true;input(f,t('description'),'description',barber.description,'textarea');input(f,t('photo'),'photo_url',barber.photo_url,'url');input(f,t('active'),'active',barber.active,'checkbox');input(f,t('online'),'online',barber.online_enabled,'checkbox');
 formSave(f,async d=>{if(barber.future_count&&!d.has('active')&&!window.confirm(`${t('future')}: ${barber.future_count}. ${t('keep')}?`))return;await api('/owner/barbers/'+barber.id,'PATCH',{version:barber.version,name:d.get('name'),description:d.get('description'),photo_url:d.get('photo_url')||null,active:d.has('active'),online_enabled:d.has('online'),...(barber.future_count&&!d.has('active')?{future_action:'keep'}:{})});await refreshCatalog();panel.replaceChildren();await ownerBarbers(panel);});panel.append(f);
 panel.append(button(t('invite'),async()=>{const result=await api('/owner/barbers/'+barber.id+'/invitation','POST',{});const link=el('a',result.url,'link');link.href=result.url;panel.append(link);}));
 panel.append(button(t('revoke'),async()=>{await api('/owner/barbers/'+barber.id,'PATCH',{version:barber.version,revoke_access:true});panel.replaceChildren();await ownerBarbers(panel);}));
}
async function ownerServices(panel){
 const services=await api('/owner/services');
 function edit(service={}){
  panel.replaceChildren();panel.append(el('h2',service.id?title(service):t('addService')));const f=el('form',null,'card');
  for(const [label,key,type,value]of [['titleHy','title_hy','text',''],['titleRu','title_ru','text',''],['priceMin','price_min','number',0],['priceMax','price_max','number',0],['duration','duration','number',30]]){const field=input(f,t(label),key,service[key]??value,type);field.required=true;if(type==='number'){field.min='0';field.max=key==='duration'?'480':'20000000';field.step=key==='duration'?'5':'1';}}
  input(f,t('active'),'active',service.active??true,'checkbox');
  formSave(f,async d=>{const body={title_hy:d.get('title_hy'),title_ru:d.get('title_ru'),price_min:Number(d.get('price_min')),price_max:Number(d.get('price_max')),duration:Number(d.get('duration')),active:d.has('active')};await api('/owner/services'+(service.id?'/'+service.id:''),service.id?'PUT':'POST',body);await refreshCatalog();panel.replaceChildren();await ownerServices(panel);});panel.append(f);
 }
 panel.append(button(t('addService'),()=>edit(), 'primary'));
 for(const service of services){const card=el('div',null,'card');card.append(el('h3',title(service)),el('p',`${price(service)} · ${service.duration} ${t('min')}`),button(t('edit'),()=>edit(service)));panel.append(card);}
}
async function ownerSettings(panel){
 const config=await api('/config'),f=el('form',null,'card');
 input(f,t('name'),'name',config.name);input(f,t('address'),'address',config.address);input(f,t('logo'),'logo_url',config.logo_url,'url');input(f,t('advance'),'advance_days',config.advance_days,'number');input(f,t('notice'),'notice_minutes',config.notice_minutes,'number');
 formSave(f,async d=>{await api('/owner/settings','PUT',{name:d.get('name'),address:d.get('address'),logo_url:d.get('logo_url')||null,advance_days:Number(d.get('advance_days')),notice_minutes:Number(d.get('notice_minutes'))});state.config=await api('/config');chrome();});panel.append(f);
 const diagnostics=await api('/owner/diagnostics');const note=el('div',null,'notice');for(const row of diagnostics)note.append(el('p',`${t(row.state)}: ${row.count}`));if(diagnostics.length)panel.append(note);
}
async function renderStaff(id){
 state.staffId=id;heading(t('staff'));const nav=el('div',null,'actions'),panel=el('div');root.append(nav,panel);
 const show=async action=>{panel.replaceChildren();try{await action();}catch(e){panel.append(el('p',e.message,'notice'));}};
 nav.append(button(t('my'),()=>show(()=>staffBookings(panel,id))),button(t('schedule'),()=>show(()=>staffSchedule(panel,id))),button(t('duration'),()=>show(()=>staffServices(panel,id))),button(t('clients'),()=>show(()=>staffClients(panel,id))),button(t('manual'),()=>{state.view='services';state.manual=true;state.editing=null;state.step=1;state.staffId=id;return render();}));
 await show(()=>staffBookings(panel,id));
}
async function staffBookings(panel,id){
 const scope=state.me.owner?'all':'staff';const list=el('div');await renderBookings(scope,list,id);
 panel.append(list);
}
const minute=time=>time?Number(time.slice(0,2))*60+Number(time.slice(3)):null;
const clock=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
async function staffSchedule(panel,id){
 const data=await api('/staff/'+id+'/schedule'),f=el('form',null,'card');panel.append(el('p',t('hoursHint'),'muted'));
 const rows=[];
 for(let day=0;day<7;day++)for(let interval=0;interval<2;interval++){
  const h=data.hours.filter(h=>h.weekday===day)[interval],row=el('div',null,'hours-row');row.append(el('span',interval?'↳':t('weekdays')[day]));
  const start=el('input'),end=el('input');start.type=end.type='time';start.step=end.step='300';start.value=h?clock(h.start_minute):'';end.value=h?clock(h.end_minute):'';start.setAttribute('aria-label',`${t('weekdays')[day]} ${t('start')} ${interval+1}`);end.setAttribute('aria-label',`${t('weekdays')[day]} ${t('end')} ${interval+1}`);row.append(start,end);rows.push({day,start,end});f.append(row);
 }
 formSave(f,async()=>{const hours=[];for(const {day,start,end}of rows){if(!start.value&&!end.value)continue;if(!start.value||!end.value)throw Error(t('errors').INVALID_INPUT);hours.push({weekday:day,start_minute:minute(start.value),end_minute:minute(end.value)});}await api('/staff/'+id+'/schedule','PUT',{hours});});panel.append(f);
 const away=el('form',null,'card');select(away,t('absence'),'kind',[['vacation',t('vacation')],['unavailable',t('unavailable')],['break',t('break')]]);input(away,t('start'),'start','','datetime-local').required=true;input(away,t('end'),'end','','datetime-local').required=true;
 formSave(away,async d=>{await api('/staff/'+id+'/absences','POST',{starts_at:Date.parse(d.get('start')+':00+04:00')/1000,ends_at:Date.parse(d.get('end')+':00+04:00')/1000,kind:d.get('kind')});panel.replaceChildren();await staffSchedule(panel,id);});panel.append(away);
 for(const a of data.absences){const card=el('div',null,'card');card.append(el('p',`${t(a.kind)} · ${dateText(a.starts_at)} ${timeText(a.starts_at)} → ${dateText(a.ends_at)} ${timeText(a.ends_at)}`),button(t('remove'),async()=>{await api(`/staff/${id}/absences/${a.id}`,'DELETE');panel.replaceChildren();await staffSchedule(panel,id);}));panel.append(card);}
}
async function staffServices(panel,id){
 const assigned=await api('/staff/'+id+'/services'),services=state.me.owner?await api('/owner/services'):assigned;
 for(const service of services){const link=assigned.find(s=>s.id===service.id),f=el('form',null,'card');f.append(el('h3',title(service)));input(f,`${t('duration')} (${t('min')})`,'duration',link?.individual_duration??service.duration,'number').step='5';if(state.me.owner)input(f,t('active'),'enabled',Boolean(link),'checkbox');formSave(f,async d=>{await api(`/staff/${id}/services/${service.id}`,'PUT',{duration:Number(d.get('duration')),enabled:state.me.owner?d.has('enabled'):true});await refreshCatalog();});panel.append(f);}
}
async function staffClients(panel,id){
 const clients=await api('/staff/'+id+'/clients');if(!clients.length)panel.append(el('p',t('empty'),'muted'));
 for(const client of clients){const f=el('form',null,'card');f.append(el('h3',client.name));input(f,t('note'),'note',client.note||'','textarea');formSave(f,async d=>{await api(`/staff/${id}/notes/${client.id}`,'PUT',{text:d.get('note')});});panel.append(f);}
}
$('language').addEventListener('click',async()=>{language=language==='hy'?'ru':'hy';localStorage.setItem('37-language',language);if(state.me)await api('/me/language','PUT',{language}).catch(()=>{});await render();});
async function start(){chrome();root.append(el('div',t('loading'),'loading'));try{state.config=await api('/config');await refreshCatalog();if(tg?.initData){try{state.me=await api('/me');}catch(e){toast(e.message);}}const startParam=new URLSearchParams(location.search).get('barber')||tg?.initDataUnsafe?.start_param;if(startParam){const candidate=startParam.replace(/^barber_/,'');if(state.catalog.barbers.some(b=>b.id===candidate))state.barber=candidate;}await render();}catch(error){root.replaceChildren(el('p',error.message,'notice'));}}
void start();
