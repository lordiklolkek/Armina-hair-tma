import {words} from './i18n.js';
import {bookingLink,linkedBarber,qrPixels} from './links.js';
const tg=window.Telegram?.WebApp;tg?.ready();tg?.expand();
const $=id=>document.getElementById(id),root=$('content');
let language=localStorage.getItem('37-language')==='ru'?'ru':'hy';
const state={view:'services',step:1,config:{},catalog:{services:[],barbers:[],links:[],absences:[]},me:null,service:null,barber:null,preferredBarber:null,date:null,time:null,key:null,editing:null,manual:false,staffId:null,request:0};
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
 $('demo').textContent=t(state.config.contact_verification?'demoWithContact':'demo');$('hero-label').textContent=t('heroLabel');$('hero-title').textContent=t('heroTitle');$('hero-copy').textContent=t('heroCopy');$('address').textContent=state.config.address||'Շահումյան 33, Կապան, Հայաստան';$('city').textContent=language==='hy'?'ԿԱՊԱՆ · ՀԱՅԱՍՏԱՆ':'КАПАН · АРМЕНИЯ';
 $('footer').replaceChildren(el('span','37 BARBERSHOP'),el('span',t('timezone')));
 if(state.config.logo_url){const image=el('img');image.src=state.config.logo_url;image.alt=state.config.name;image.style.cssText='max-width:52px;max-height:52px';$('logo').replaceChildren(image);}
 const nav=$('nav');nav.replaceChildren();
 for(const view of ['services','my',...(state.me?.barberId?['staff']:[]),...(state.me?.owner?['owner']:[])]){
  const b=button(t(view),()=>{if(view==='services')return newFlow();state.view=view;state.editing=null;state.manual=false;return render();});b.className=state.view===view?'active':'';nav.append(b);
 }
}
async function refreshCatalog(){state.catalog=await api('/catalog');}
function newFlow(){Object.assign(state,{view:'services',step:1,service:null,barber:null,date:null,time:null,key:null,editing:null,manual:false});return render();}
async function render(){chrome();root.replaceChildren();state.request++;try{if(state.view==='services')renderBooking();else if(state.view==='my')await renderBookings('mine');else if(state.view==='staff')await renderStaff(state.me.barberId);else await renderOwner();}catch(error){root.append(el('p',error.message,'notice'));}}
function renderBooking(){
 if(state.step===1){
  const top=el('div',null,'section-head'),labels=el('div');labels.append(el('h2',t('choose')),el('p',t('chooseCopy'),'muted'));top.append(labels,el('span',String(state.catalog.services.length).padStart(2,'0'),'count'));root.append(top);
  state.catalog.services.forEach((service,i)=>{
   const b=button('',()=>{state.service=service;const preferred=state.preferredBarber&&state.catalog.links.some(l=>l.barber_id===state.preferredBarber&&l.service_id===service.id);state.barber=state.manual?state.staffId:preferred?state.preferredBarber:null;state.step=state.manual||preferred?3:2;state.time=null;state.key=null;return render();},'service');
   b.append(el('span',String(i+1).padStart(2,'0'),'service-icon'));const info=el('div');info.append(el('strong',title(service)));const meta=el('div',null,'meta');meta.append(el('span',price(service)),el('span',`${service.duration} ${t('min')}`));info.append(meta);if(service['description_'+language])info.append(el('p',service['description_'+language],'muted'));b.append(info,el('span','↗','arrow'));root.append(b);
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
  root.append(button('‹ '+t('back'),()=>{state.step=2;return render();},'plain'));const selected=[...state.catalog.barbers,...(state.transferBarbers||[])].find(b=>b.id===state.barber);heading(state.editing?t('move'):t('date'),[title(state.service),selected?.name].filter(Boolean).join(' · '));
  if(state.editing&&state.me?.owner){const choices=(state.transferBarbers||state.catalog.barbers).filter(b=>b.id===state.editing.barber_id||b.active&&!b.archived&&state.catalog.links.some(l=>l.barber_id===b.id&&l.service_id===state.service.id));const master=select(root,t('transferBarber'),'transfer_barber',choices.map(b=>[b.id,b.name]),state.barber);master.addEventListener('change',()=>{state.barber=master.value;state.time=null;void render();});root.append(el('p',t('transferHint'),'muted'));}
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
  const card=el('div',null,'card'),master=[...state.catalog.barbers,...(state.transferBarbers||[])].find(b=>b.id===state.barber);card.append(el('h3',title(state.service)),el('p',master?.name||t('any')),el('p',`${dateText(state.time)} · ${timeText(state.time)}`),el('h3',price(state.service)));root.append(card);
  if(state.service.price_min!==state.service.price_max)root.append(el('p',t('rangeNote'),'notice'));
  root.append(el('p',t(state.config.contact_verification?'privacyWithContact':'privacy'),'muted'));
  const confirmation=button(t('confirm')+' ↗',async()=>{
   state.key??=crypto.randomUUID();
   if(state.editing)await api('/bookings/'+state.editing.id,'PATCH',{version:state.editing.version,starts_at:state.time,...(state.barber!==state.editing.barber_id?{barber_id:state.barber}:{})});
   else await api(state.manual?'/manual-bookings':'/bookings','POST',{service_id:state.service.id,barber_id:state.barber,starts_at:state.time},state.key);
   state.step=5;await render();
  },'primary');
  if(state.config.contact_verification&&!state.manual&&!state.editing){confirmation.disabled=true;const check=el('section',null,'card');root.append(check);void renderContactCheck(check,confirmation).catch(error=>toast(error.message));}
  root.append(confirmation);return;
 }
 root.append(el('div','✓','success-mark'));heading(t('done'),t('doneCopy'));root.append(button(t('my'),()=>{state.view='my';return render();},'primary'),button(t('newBooking'),newFlow,'plain'));
}
async function renderContactCheck(panel,confirmation){
 const current=await api('/me/contact');if(!panel.isConnected)return;
 panel.replaceChildren(el('p',t(current.verified?'phoneVerified':'phoneConsent'),'notice'));confirmation.disabled=!current.verified;
 if(current.verified)return;
 panel.append(button(t('verifyPhone'),async()=>{
  if(typeof tg?.requestContact!=='function')throw new Error(t('phoneTelegramRequired'));
  await api('/me/contact-challenge','POST',{});
  await new Promise(resolve=>tg.requestContact(()=>{void renderContactCheck(panel,confirmation).catch(error=>toast(error.message)).finally(resolve);}));
 }),button(t('refresh'),()=>renderContactCheck(panel,confirmation)));
}
async function renderBookings(scope,target=root,barberId=null){
 if(target===root)heading(scope==='all'?t('allBookings'):scope==='staff'?t('staff'):t('my'));
 const records=await api('/bookings?scope='+scope),bookings=barberId?records.filter(b=>b.barber_id===barberId):records;if(!bookings.length)target.append(el('p',t('empty'),'muted'));
 for(const booking of bookings)target.append(bookingCard(booking,scope));
}
function bookingCard(booking,scope,refresh=render){
  const card=el('article',null,'card');card.append(el('span',t(booking.status),'status'),el('h3',title(booking)),el('p',`${dateText(booking.starts_at)} · ${timeText(booking.starts_at)}`),el('p',booking.barber_name,'muted'),el('p',price(booking),'muted'));if(scope!=='mine')card.append(el('p',booking.client_name));
  const actions=el('div',null,'actions');
  if(['confirmed','pending'].includes(booking.status)){
   actions.append(button(t('cancel'),async()=>{if(!window.confirm(t('deleteConfirm')))return;await api('/bookings/'+booking.id,'PATCH',{version:booking.version,status:'cancelled'});await refresh();}));
   actions.append(button(t('move'),async()=>{state.transferBarbers=state.me?.owner?await api('/owner/barbers'):null;state.editing=booking;state.manual=false;state.service={...booking,id:booking.service_id,duration:(booking.ends_at-booking.starts_at)/60};state.barber=booking.barber_id;state.date=new Date((booking.starts_at+14400)*1000).toISOString().slice(0,10);state.time=null;state.view='services';state.step=3;return render();}));
   if(scope!=='mine')for(const status of [...(booking.status==='pending'?['confirmed']:[]),'completed','no_show'])actions.append(button(t(status),async()=>{await api('/bookings/'+booking.id,'PATCH',{version:booking.version,status});await refresh();}));
  }
  if(scope==='mine')actions.append(button(t('repeat'),()=>{state.service=state.catalog.services.find(s=>s.id===booking.service_id);if(!state.service)return newFlow();state.view='services';state.step=2;state.editing=null;state.manual=false;return render();}));
  card.append(actions);
  if(scope!=='mine'&&['confirmed','pending'].includes(booking.status)){
   const details=el('details');details.append(el('summary',t('edit')));const f=el('form');input(f,t('finalPrice'),'final_price',booking.final_price??'','number');const extra=input(f,t('extraTime'),'extra_minutes',0,'number');extra.min='0';extra.max='120';extra.step='5';formSave(f,async d=>{await api('/bookings/'+booking.id,'PATCH',{version:booking.version,extra_minutes:Number(d.get('extra_minutes')),...(d.get('final_price')!==''?{final_price:Number(d.get('final_price'))}:{})});await refresh();});details.append(f);card.append(details);
  }
  return card;
}
async function renderOwner(){
 heading(t('owner'));const subnav=el('div',null,'actions');root.append(subnav);const panel=el('div');root.append(panel);
 async function show(action){panel.replaceChildren();try{await action();}catch(e){panel.append(el('p',e.message,'notice'));}}
 subnav.append(button(t('selectBarber'),()=>show(()=>ownerBarbers(panel))),button(t('prices'),()=>show(()=>ownerServices(panel))),button(t('calendar'),()=>show(()=>renderCalendar(panel))),button(t('clients'),()=>show(()=>ownerClients(panel))),button(t('linksQr'),()=>show(()=>renderLinks(panel))),button(t('settings'),()=>show(()=>ownerSettings(panel))));
 await show(()=>ownerBarbers(panel));
}
async function ownerBarbers(panel){
 const barbers=await api('/owner/barbers');
 const add=el('form',null,'card');input(add,t('name'),'name').required=true;formSave(add,async f=>{await api('/owner/barbers','POST',{name:f.get('name')});panel.replaceChildren();await ownerBarbers(panel);});panel.append(el('h2',t('addBarber')),add);
 for(const barber of barbers){
  const card=el('article',null,'card');card.append(el('h3',barber.name),el('p',`${barber.archived?t('archived'):barber.active?t('active'):t('unavailable')} · ${t('scheduledVisits')}: ${barber.future_count}`,'muted'));
  const actions=el('div',null,'actions');actions.append(button(t('edit'),()=>{panel.replaceChildren();return editBarber(panel,barber);}));
  actions.append(button(t('staff'),async()=>{state.staffId=barber.id;root.replaceChildren();await renderStaff(barber.id);}));
  actions.append(button(barber.archived?t('restore'):t('archive'),async()=>{
   if(!barber.archived)return retireBarber(panel,barber,'archive');const data={version:barber.version,archived:false};
   await api('/owner/barbers/'+barber.id,'PATCH',data);await refreshCatalog();panel.replaceChildren();await ownerBarbers(panel);
  }));card.append(actions);panel.append(card);
 }
}
async function editBarber(panel,barber){
 const f=el('form',null,'card');input(f,t('name'),'name',barber.name).required=true;input(f,t('description'),'description',barber.description,'textarea');input(f,t('photo'),'photo_url',barber.photo_url,'url');input(f,t('active'),'active',barber.active,'checkbox');input(f,t('online'),'online',barber.online_enabled,'checkbox');
 formSave(f,async d=>{const body={version:barber.version,name:d.get('name'),description:d.get('description'),photo_url:d.get('photo_url')||null,active:d.has('active'),online_enabled:d.has('online')};if(!d.has('active')&&barber.active)return retireBarber(panel,barber,'disable',body);await api('/owner/barbers/'+barber.id,'PATCH',body);await refreshCatalog();panel.replaceChildren();await ownerBarbers(panel);});panel.append(f);
 panel.append(button(t('invite'),async()=>{const result=await api('/owner/barbers/'+barber.id+'/invitation','POST',{});const link=el('a',result.url,'link');link.href=result.url;panel.append(link);}));
 panel.append(button(t('revoke'),async()=>{await api('/owner/barbers/'+barber.id,'PATCH',{version:barber.version,revoke_access:true});panel.replaceChildren();await ownerBarbers(panel);}));
}
async function retireBarber(panel,barber,mode='archive',changes=null){
 const first=await api('/owner/barbers/'+barber.id+'/future-bookings'),snapshot=first.barber;
 if(changes&&changes.version!==snapshot.version)throw new Error(words[language].errors.STATE_CONFLICT);
 panel.replaceChildren(el('h2',`${t(mode==='archive'?'archive':'disableBarber')} · ${snapshot.name}`),el('p',`${t('scheduledVisits')}: ${snapshot.future_count}`,'notice'),el('p',t('retireHint'),'muted'));
 const actions=el('div',null,'actions'),confirmation=el('div'),list=el('div');panel.append(actions,confirmation,list);
 async function apply(action){await api('/owner/barbers/'+barber.id,'PATCH',{...(changes||{}),version:snapshot.version,...(mode==='archive'?{archived:true}:{active:false}),future_action:action,expected_future_count:snapshot.future_count,expected_bookings_revision:snapshot.bookings_revision});await refreshCatalog();panel.replaceChildren();await ownerBarbers(panel);}
 actions.append(button(t('keepVisits'),()=>apply('keep')),button(t('cancelAllVisits'),()=>{confirmation.replaceChildren(el('p',`${t('cancelAllConfirm')} (${snapshot.future_count})`,'notice'),button(t('confirmCancelAll'),()=>apply('cancel')),button(t('back'),()=>confirmation.replaceChildren()));}),button(t('refresh'),()=>retireBarber(panel,snapshot,mode,changes)),button(t('back'),()=>{panel.replaceChildren();return ownerBarbers(panel);}));
 let cursor=first.next_cursor;const more=button(t('loadMore'),async()=>{const page=await api('/owner/barbers/'+barber.id+'/future-bookings?cursor='+encodeURIComponent(cursor));if(page.barber.bookings_revision!==snapshot.bookings_revision)throw new Error(words[language].errors.STATE_CONFLICT);draw(page.items);cursor=page.next_cursor;more.hidden=!cursor;});panel.append(more);more.hidden=!cursor;
 function draw(items){for(const booking of items)list.append(bookingCard(booking,'all',()=>retireBarber(panel,snapshot,mode,changes)));}
 draw(first.items);if(!first.items.length)list.append(el('p',t('empty'),'muted'));
}
async function ownerServices(panel){
 const services=await api('/owner/services');
 function edit(service={}){
  panel.replaceChildren();panel.append(el('h2',service.id?title(service):t('addService')));const f=el('form',null,'card');
  for(const [label,key,type,value]of [['titleHy','title_hy','text',''],['titleRu','title_ru','text',''],['priceMin','price_min','number',0],['priceMax','price_max','number',0],['duration','duration','number',30]]){const field=input(f,t(label),key,service[key]??value,type);field.required=true;if(type==='number'){field.min='0';field.max=key==='duration'?'480':'20000000';field.step=key==='duration'?'5':'1';}}
  input(f,t('descriptionHy'),'description_hy',service.description_hy||'','textarea').maxLength=500;input(f,t('descriptionRu'),'description_ru',service.description_ru||'','textarea').maxLength=500;input(f,t('sortOrder'),'sort_order',service.sort_order??0,'number').step='1';
  input(f,t('active'),'active',service.active??true,'checkbox');
  formSave(f,async d=>{const body={title_hy:d.get('title_hy'),title_ru:d.get('title_ru'),description_hy:d.get('description_hy'),description_ru:d.get('description_ru'),sort_order:Number(d.get('sort_order')),price_min:Number(d.get('price_min')),price_max:Number(d.get('price_max')),duration:Number(d.get('duration')),active:d.has('active')};await api('/owner/services'+(service.id?'/'+service.id:''),service.id?'PUT':'POST',body);await refreshCatalog();panel.replaceChildren();await ownerServices(panel);});panel.append(f);
 }
 panel.append(button(t('addService'),()=>edit(), 'primary'));
 for(const service of services){const card=el('div',null,'card');card.append(el('h3',title(service)),el('p',`${price(service)} · ${service.duration} ${t('min')}`),button(t('edit'),()=>edit(service)));panel.append(card);}
}
async function ownerSettings(panel){
 const config=await api('/config'),f=el('form',null,'card');
 input(f,t('name'),'name',config.name);input(f,t('address'),'address',config.address);input(f,t('logo'),'logo_url',config.logo_url,'url');input(f,t('advance'),'advance_days',config.advance_days,'number');input(f,t('notice'),'notice_minutes',config.notice_minutes,'number');
 formSave(f,async d=>{await api('/owner/settings','PUT',{name:d.get('name'),address:d.get('address'),logo_url:d.get('logo_url')||null,advance_days:Number(d.get('advance_days')),notice_minutes:Number(d.get('notice_minutes'))});state.config=await api('/config');chrome();});panel.append(f);
 const notifications=el('section');panel.append(notifications);await ownerNotifications(notifications);
}
async function ownerNotifications(panel){
 panel.replaceChildren(el('h2',t('notifications')),el('p',t('notificationsHint'),'muted'));
 const summary=el('p',null,'notice'),actions=el('div',null,'actions'),confirm=el('div');panel.append(summary,actions,confirm);
 const connection=el('p',null,'notice');panel.append(connection);actions.append(button(t('botConnection'),async()=>{const status=await api('/owner/telegram-status');connection.textContent=[status.ok?(status.webhook_matches?t('botConnected'):t('botStillLegacy')):t('botUnavailable'),status.bot_username?'@'+status.bot_username:'',status.webhook_origin||'',status.pending_updates!==null&&status.pending_updates!==undefined?`${t('pendingTelegramUpdates')}: ${status.pending_updates}`:''].filter(Boolean).join(' · ');}));
 actions.append(button(t('refresh'),()=>ownerNotifications(panel)),button(t('checkNotifications'),()=>{confirm.replaceChildren(el('p',t('selfTestHint'),'notice'),button(t('sendSelfTest'),async()=>{const job=await api('/owner/notifications/self-test','POST',{});confirm.replaceChildren(el('p',`${t('selfTestQueued')} · ${t(job.state)}`,'notice'));await load(true);}),button(t('back'),()=>confirm.replaceChildren()));}));
 const filter=select(panel,t('deliveryState'),'notification_state',['failed','pending','sending','sent'].map(s=>[s,t(s)]),'failed'),list=el('div'),more=button(t('loadMore'),()=>load(false));panel.append(list,more);more.hidden=true;let cursor=null,generation=0;
 async function load(reset=true){const ticket=reset?++generation:generation;if(reset){cursor=null;list.replaceChildren();}const query=new URLSearchParams({state:filter.value});if(cursor)query.set('cursor',cursor);more.hidden=true;const page=await api('/owner/notifications?'+query);if(ticket!==generation||!panel.isConnected)return;
  const counts=Object.fromEntries(page.summary.map(s=>[s.state,s.count]));summary.textContent=['pending','sending','sent','failed'].map(s=>`${t(s)}: ${counts[s]||0}`).join(' · ');
  for(const job of page.items){const card=el('article',null,'card');card.append(el('h3',title(job)||t('systemMessage')),el('p',`${t(job.state)} · ${t('deliveryAttempts')}: ${job.attempts}`,'muted'));if(job.audience)card.append(el('p',t(job.audience==='barber'?'toBarber':'toClient'),'muted'));if(job.last_error)card.append(el('p',words[language].deliveryErrors[job.last_error]||t('deliveryUnknown'),'notice'));
   if(job.can_retry){const retry=button(t('retryDelivery'),()=>{retry.hidden=true;const confirmation=el('div',null,'notice');confirmation.append(el('p',t('retryHint')),button(t('confirmAction'),async()=>{await api('/owner/notifications/'+encodeURIComponent(job.id)+'/retry','POST',{});await load();toast(t('retryQueued'));}),button(t('back'),()=>{confirmation.remove();retry.hidden=false;}));card.append(confirmation);});card.append(retry);}list.append(card);
  }cursor=page.next_cursor;more.hidden=!cursor;if(reset&&!page.items.length)list.append(el('p',t('noNotifications'),'muted'));
 }
 filter.addEventListener('change',()=>{void load().catch(error=>toast(error.message));});await load();
}
async function renderStaff(id){
 state.staffId=id;heading(t('staff'));const nav=el('div',null,'actions'),panel=el('div');root.append(nav,panel);
 const show=async action=>{panel.replaceChildren();try{await action();}catch(e){panel.append(el('p',e.message,'notice'));}};
 nav.append(button(t('calendar'),()=>show(()=>renderCalendar(panel,id))),button(t('schedule'),()=>show(()=>staffSchedule(panel,id))),button(t('duration'),()=>show(()=>staffServices(panel,id))),button(t('clients'),()=>show(()=>staffClients(panel,id))),button(t('linksQr'),()=>show(()=>renderLinks(panel,id))),button(t('manual'),()=>{state.view='services';state.manual=true;state.editing=null;state.step=1;state.staffId=id;return render();}));
 await show(()=>renderCalendar(panel,id));
}
async function renderCalendar(panel,barberId=null){
 panel.append(el('h2',t('calendar')),el('p',t('calendarHint'),'muted'));
 const filters=el('form',null,'card'),dates=el('div',null,'two');filters.append(dates);
 const from=input(dates,t('dateFrom'),'from',today(),'date'),to=input(dates,t('dateTo'),'to',new Date(Date.parse(today()+'T12:00:00Z')+6*86400000).toISOString().slice(0,10),'date');from.required=to.required=true;
 let master=null;
 if(state.me.owner&&!barberId){const barbers=await api('/owner/barbers');master=select(filters,t('selectBarber'),'barber_id',[['',t('allBarbers')],...barbers.map(b=>[b.id,b.name+(b.archived?' · '+t('archived'):'')])]);}
 const status=select(filters,t('visitStatus'),'status',[['',t('allStatuses')],...['pending','confirmed','completed','no_show','cancelled'].map(s=>[s,t(s)])]);
 const submit=el('button',t('showCalendar'),'primary');submit.type='submit';filters.append(submit);
 const count=el('p',null,'muted'),list=el('div'),more=button(t('loadMore'),()=>load(false));more.hidden=true;panel.append(filters,count,list,more);
 let cursor=null,query=null,shown=0,lastDay=null,generation=0;
 async function load(reset=true){
  const ticket=reset?++generation:generation;
  if(reset){query=new URLSearchParams({from:from.value,to:to.value});const selected=barberId||master?.value;if(selected)query.set('barber_id',selected);if(status.value)query.set('status',status.value);cursor=null;shown=0;lastDay=null;list.replaceChildren();count.textContent=t('loading');}
  const params=new URLSearchParams(query);if(cursor)params.set('cursor',cursor);submit.disabled=true;more.disabled=true;more.hidden=true;
  try{
   const result=await api('/calendar?'+params);if(ticket!==generation||!panel.isConnected)return;
   for(const booking of result.items){const day=new Date((booking.starts_at+14400)*1000).toISOString().slice(0,10);if(day!==lastDay){list.append(el('h3',dateText(booking.starts_at),'calendar-day'));lastDay=day;}list.append(bookingCard(booking,state.me.owner?'all':'staff',()=>load(true)));}
   shown+=result.items.length;cursor=result.next_cursor;count.textContent=`${t('shownVisits')}: ${shown}`;if(!shown)list.append(el('p',t('empty'),'muted'));more.hidden=!cursor;
  }catch(error){if(ticket===generation){count.textContent=error.message;more.hidden=!cursor;}throw error;}
  finally{if(ticket===generation){submit.disabled=false;more.disabled=false;}}
 }
 filters.addEventListener('submit',async event=>{event.preventDefault();if(!filters.reportValidity())return;try{await load();}catch(error){toast(error.message);}});
 await load();
}
async function ownerClients(panel){
 panel.append(el('h2',t('clients')),el('p',t('blockHint'),'notice'),button(t('refresh'),()=>{panel.replaceChildren();return ownerClients(panel);}));
 const list=el('div'),more=button(t('loadMore'),()=>load());more.hidden=true;panel.append(list,more);let cursor=null,first=true;
 async function load(){
  const page=await api('/owner/clients'+(cursor?'?cursor='+encodeURIComponent(cursor):''));if(!panel.isConnected)return;
  if(first&&!page.items.length)list.append(el('p',t('noClients'),'muted'));first=false;
  for(const client of page.items){
   const card=el('article',null,'card');list.append(card);
   function draw(){
    card.replaceChildren(el('h3',client.name),el('p',`${t('completed')}: ${client.completed_count} · ${t('no_show')}: ${client.no_show_count}`,'muted'));
    if(!client.has_telegram){card.append(el('p',t('manualClient'),'muted'));return;}
    const action=button(client.blocked?t('unblockClient'):t('blockClient'),()=>{
     const confirmation=el('div',null,'notice');confirmation.append(el('p',client.blocked?t('unblockConfirm'):t('blockConfirm')));
     confirmation.append(button(t('confirmAction'),async()=>{const blocked=!Boolean(client.blocked);await api('/owner/clients/'+encodeURIComponent(client.id)+'/access','PATCH',{blocked,expected_blocked:Boolean(client.blocked)});client.blocked=Number(blocked);draw();toast(t('saved'));}),button(t('back'),()=>{confirmation.remove();action.hidden=false;}));action.hidden=true;card.append(confirmation);
    });card.append(el('span',client.blocked?t('blocked'):t('accessAllowed'),'status'),el('div',null,'actions'));card.lastChild.append(action);
   }draw();
  }
  cursor=page.next_cursor;more.hidden=!cursor;
 }
 await load();
}
const minute=time=>time?Number(time.slice(0,2))*60+Number(time.slice(3)):null;
const clock=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const endClock=m=>m===1440?'00:00':clock(m);
async function staffSchedule(panel,id){
 const data=await api('/staff/'+id+'/schedule'),f=el('form'),weekly=el('details',null,'card');weekly.append(el('summary',t('weeklySchedule')),el('p',t('hoursHint'),'muted'));panel.append(weekly);
 const rows=[];
 for(let day=0;day<7;day++)for(let interval=0;interval<2;interval++){
  const h=data.hours.filter(h=>h.weekday===day)[interval],row=el('div',null,'hours-row');row.append(el('span',interval?'↳':t('weekdays')[day]));
  const start=el('input'),end=el('input');start.type=end.type='time';start.step=end.step='300';start.value=h?clock(h.start_minute):'';end.value=h?endClock(h.end_minute):'';start.setAttribute('aria-label',`${t('weekdays')[day]} ${t('start')} ${interval+1}`);end.setAttribute('aria-label',`${t('weekdays')[day]} ${t('end')} ${interval+1}`);row.append(start,end);rows.push({day,start,end});f.append(row);
 }
 formSave(f,async()=>{const hours=[];for(const {day,start,end}of rows){if(!start.value&&!end.value)continue;if(!start.value||!end.value)throw Error(t('errors').INVALID_INPUT);hours.push({weekday:day,start_minute:minute(start.value),end_minute:minute(end.value)||1440});}await api('/staff/'+id+'/schedule','PUT',{hours});});weekly.append(f);
 renderDateSchedule(panel,id,data);
 const away=el('form',null,'card');select(away,t('absence'),'kind',[['vacation',t('vacation')],['unavailable',t('unavailable')],['break',t('break')]]);input(away,t('start'),'start','','datetime-local').required=true;input(away,t('end'),'end','','datetime-local').required=true;
 formSave(away,async d=>{await api('/staff/'+id+'/absences','POST',{starts_at:Date.parse(d.get('start')+':00+04:00')/1000,ends_at:Date.parse(d.get('end')+':00+04:00')/1000,kind:d.get('kind')});panel.replaceChildren();await staffSchedule(panel,id);});panel.append(away);
 for(const a of data.absences){const card=el('div',null,'card');card.append(el('p',`${t(a.kind)} · ${dateText(a.starts_at)} ${timeText(a.starts_at)} → ${dateText(a.ends_at)} ${timeText(a.ends_at)}`),button(t('remove'),async()=>{await api(`/staff/${id}/absences/${a.id}`,'DELETE');panel.replaceChildren();await staffSchedule(panel,id);}));panel.append(card);}
}
function renderDateSchedule(panel,id,data){
 const section=el('section');section.append(el('h3',t('dateSchedule')),el('p',t('dateScheduleHint'),'muted'));const f=el('form',null,'card');
 const day=input(f,t('date'),'override_day',today(),'date');day.required=true;day.min=today();day.max=new Date(Date.parse(today()+'T12:00:00Z')+365*86400000).toISOString().slice(0,10);
 const intervals=el('div');f.append(intervals);const rows=[];
 function add(h={}){
  if(rows.length>=8)return;const row=el('div',null,'hours-row');row.append(el('span',String(rows.length+1)));
  const start=el('input'),end=el('input');start.type=end.type='time';start.step=end.step='300';start.value=h.start_minute!=null?clock(h.start_minute):'';end.value=h.end_minute!=null?clock(h.end_minute):'';
  if(h.end_minute===1440)end.value='00:00';start.setAttribute('aria-label',`${t('dateSchedule')} ${t('start')} ${rows.length+1}`);end.setAttribute('aria-label',`${t('dateSchedule')} ${t('end')} ${rows.length+1}`);row.append(start,end);rows.push({start,end});intervals.append(row);
 }
 function load(){
  rows.length=0;intervals.replaceChildren();const override=data.overrides.find(o=>o.day===day.value);
  const weekday=(new Date(day.value+'T12:00:00Z').getUTCDay()+6)%7;
  const hours=override?override.hours:data.hours.filter(h=>h.weekday===weekday);hours.forEach(add);while(rows.length<2)add();
 }
 day.addEventListener('change',load);load();
 const actions=el('div',null,'actions');actions.append(button(t('addInterval'),()=>add()),button(t('dayOff'),()=>{for(const row of rows)row.start.value=row.end.value='';}));f.append(actions);
 formSave(f,async()=>{
  const hours=[];for(const {start,end}of rows){if(!start.value&&!end.value)continue;if(!start.value||!end.value)throw Error(t('errors').INVALID_INPUT);hours.push({start_minute:minute(start.value),end_minute:minute(end.value)||1440});}
  const old=data.overrides.find(o=>o.day===day.value);await api(`/staff/${id}/schedule/dates/${day.value}`,'PUT',{hours,version:old?.version??null});panel.replaceChildren();await staffSchedule(panel,id);
 });section.append(f);
 for(const override of data.overrides){
  const card=el('div',null,'card');card.append(el('strong',override.day),el('p',override.hours.length?override.hours.map(h=>`${clock(h.start_minute)}–${clock(h.end_minute)}`).join(' · '):t('dayOff')));
  const actions=el('div',null,'actions');actions.append(button(t('edit'),()=>{day.value=override.day;load();day.focus();}),button(t('weeklyAgain'),async()=>{if(!window.confirm(t('weeklyAgainConfirm')))return;await api(`/staff/${id}/schedule/dates/${override.day}`,'DELETE',{version:override.version});panel.replaceChildren();await staffSchedule(panel,id);}));card.append(actions);section.append(card);
 }panel.append(section);
}
async function staffServices(panel,id){
 const assigned=await api('/staff/'+id+'/services'),services=state.me.owner?await api('/owner/services'):assigned;
 for(const service of services){const link=assigned.find(s=>s.id===service.id),f=el('form',null,'card');f.append(el('h3',title(service)));input(f,`${t('duration')} (${t('min')})`,'duration',link?.individual_duration??service.duration,'number').step='5';if(state.me.owner)input(f,t('active'),'enabled',Boolean(link),'checkbox');formSave(f,async d=>{await api(`/staff/${id}/services/${service.id}`,'PUT',{duration:Number(d.get('duration')),enabled:state.me.owner?d.has('enabled'):true});await refreshCatalog();});panel.append(f);}
}
async function staffClients(panel,id){
 const clients=await api('/staff/'+id+'/clients');if(!clients.length)panel.append(el('p',t('empty'),'muted'));
 for(const client of clients){const f=el('form',null,'card');f.append(el('h3',client.name));input(f,t('note'),'note',client.note||'','textarea');formSave(f,async d=>{await api(`/staff/${id}/notes/${client.id}`,'PUT',{text:d.get('note')});});panel.append(f);}
}
function renderLinks(panel,barberId=null){
 panel.append(el('h3',t('linksQr')),el('p',state.config.telegram_app_url||state.config.telegram_bot_username?t('telegramLinksHint'):t('browserLinksHint'),'notice'));
 if(barberId&&!state.catalog.barbers.some(b=>b.id===barberId)){panel.append(el('p',t('errors').BARBER_UNAVAILABLE,'notice'));return;}
 let choice;if(!barberId){choice=select(panel,t('selectBarber'),'link_barber',[['',t('wholeShop')],...state.catalog.barbers.map(b=>[b.id,b.name])]);}
 const box=el('div',null,'card');panel.append(box);
 function draw(){
  box.replaceChildren();const id=barberId||choice.value||null,url=bookingLink(location.origin,state.config.telegram_app_url,id,state.config.telegram_bot_username);
  const field=input(box,t('bookingLink'),'booking_link',url);field.readOnly=true;
  const canvas=el('canvas');const pixels=qrPixels(url);canvas.width=canvas.height=pixels.size;canvas.style.cssText='display:block;width:240px;max-width:100%;height:auto;margin:20px auto;background:white';canvas.setAttribute('role','img');canvas.setAttribute('aria-label',t('linksQr'));canvas.getContext('2d').putImageData(new ImageData(pixels.data,pixels.size,pixels.size),0,0);box.append(canvas);
  const actions=el('div',null,'actions');actions.append(button(t('copyLink'),async()=>{try{await navigator.clipboard.writeText(url);toast(t('copied'));}catch{field.focus();field.select();toast(t('copyManually'));}}));
  const download=el('a',t('downloadQr'),'secondary link');download.href=canvas.toDataURL('image/png');download.download=`37-${id||'barbershop'}-qr.png`;actions.append(download);box.append(actions);
 }choice?.addEventListener('change',draw);draw();
}
$('language').addEventListener('click',async()=>{const control=$('language');control.disabled=true;try{const next=language==='hy'?'ru':'hy';if(state.me)await api('/me/language','PUT',{language:next});language=next;localStorage.setItem('37-language',language);await render();}catch(error){toast(error.message);}finally{control.disabled=false;}});
async function start(){chrome();root.append(el('div',t('loading'),'loading'));try{state.config=await api('/config');await refreshCatalog();if(tg?.initData){try{state.me=await api('/me');language=state.me.language==='ru'?'ru':'hy';localStorage.setItem('37-language',language);}catch(e){toast(e.message);}}state.preferredBarber=linkedBarber(location.search,tg?.initDataUnsafe?.start_param,state.catalog.barbers.map(b=>b.id));await render();}catch(error){root.replaceChildren(el('p',error.message,'notice'));}}
void start();
