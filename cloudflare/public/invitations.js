// Invitation URLs stay in this screen's memory. Never persist tokens or log them.
export function invitationUrl(raw,bot){
 try{
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.hostname!=='t.me'||url.port||url.username||url.password||url.hash||!bot||url.pathname.toLowerCase()!=='/'+bot.toLowerCase())return null;
  const entries=[...url.searchParams];
  return entries.length===1&&entries[0][0]==='start'&&/^join_[a-f0-9]{32}$/.test(entries[0][1])?url.toString():null;
 }catch{return null;}
}
export function remainingSeconds(ticket,wall=Date.now(),mono=performance.now()){
 if(!ticket)return 0;
 const elapsed=Math.max(0,wall-ticket.wall,mono-ticket.mono);
 return Math.max(0,Math.ceil((ticket.ttl*1000-elapsed)/1000));
}
export function invitationShareUrl(url,text){
 return 'https://t.me/share/url?'+new URLSearchParams({url,text});
}
export function selectInvitation(field){
 field.focus({preventScroll:true});field.select();field.setSelectionRange(0,field.value.length);
}
export async function copyInvitation(url,field,nav=navigator,doc=document){
 // Start the protected API immediately inside the click, before any await/API request.
 try{if(nav.clipboard?.writeText){await nav.clipboard.writeText(url);return true;}}catch{}
 try{selectInvitation(field);return doc.execCommand?.('copy')===true;}catch{return false;}
}

export function mountInvitationPanel({panel,barber,api,t,toast,tg,botUsername,confirm}){
 const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
 const card=node('section',null,'card invitation-card'),top=node('div',null,'invitation-top');
 const heading=node('h3',t('invitePanelTitle')),badge=node('span',null,'invitation-status');badge.setAttribute('role','status');
 top.append(heading,badge);card.append(top,node('p',t('invitePrivateHint'),'muted'));
 const controls=node('div',null,'invitation-actions'),linkBox=node('div',null,'invitation-link-box');
 const timer=node('p',null,'invitation-timer'),message=node('p',null,'muted');message.setAttribute('role','status');
 const label=node('label',t('inviteLink')),field=node('textarea',null,'invitation-link');
 field.id='invite-'+crypto.randomUUID();label.htmlFor=field.id;field.readOnly=true;field.rows=3;field.spellcheck=false;field.autocomplete='off';
 const linkActions=node('div',null,'invitation-actions');linkBox.append(timer,label,field,linkActions,message);
 let profile=barber,ticket=null,busy=false,refreshing=false,closed=false,lastRefresh=0;
 const active=()=>Boolean(ticket&&remainingSeconds(ticket)>0&&!profile.telegram_id&&profile.active&&!profile.archived);
 function control(text,action,cls='secondary'){
  const b=node('button',text,cls);b.type='button';
  b.addEventListener('click',()=>{try{Promise.resolve(action()).catch(error=>{if(card.isConnected)toast(error.message);});}catch(error){toast(error.message);}});return b;
 }
 function dispose(){closed=true;ticket=null;field.value='';clearInterval(interval);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('focus',focus);}
 function draw(){
  if(closed)return;
  const linked=Boolean(profile.telegram_id),available=Boolean(profile.active&&!profile.archived),valid=active();
  badge.textContent=t(linked?'telegramLinked':'telegramUnlinked');badge.dataset.linked=String(linked);
  create.hidden=linked;create.disabled=busy||refreshing||!available;create.textContent=t(ticket?'inviteNewLink':'inviteCreateLink');
  create.setAttribute('aria-busy',String(busy));refresh.disabled=refreshing||busy;refresh.setAttribute('aria-busy',String(refreshing));
  revoke.hidden=!linked;revoke.disabled=busy||refreshing;
  linkBox.hidden=!ticket||linked;copy.disabled=!valid||busy||refreshing;select.disabled=copy.disabled;
  share.setAttribute('aria-disabled',String(!valid||busy||refreshing));share.tabIndex=valid&&!busy&&!refreshing?0:-1;
  if(valid&&!busy&&!refreshing)share.href=invitationShareUrl(ticket.url,t('inviteShareText')+' '+profile.name);else share.removeAttribute('href');
  if(ticket){
   const seconds=remainingSeconds(ticket);timer.textContent=seconds?t('inviteTimeLeft')+' '+String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0'):t('inviteExpired');
   timer.dataset.expired=String(!seconds);const value=valid?ticket.url:'';if(field.value!==value)field.value=value;field.disabled=!valid;
   if(!seconds)message.textContent=t('inviteExpiredHint');
  }
  unavailable.hidden=available;unavailable.textContent=t('inviteInactive');
 }
 async function refreshStatus(){
  if(closed||busy||refreshing||!card.isConnected)return;
  refreshing=true;draw();
  try{
   const rows=await api('/owner/barbers'),current=rows.find(row=>row.id===barber.id);
   if(!card.isConnected||closed)return;
   if(!current){dispose();card.replaceChildren(node('p',t('inviteUnavailable'),'notice'));return;}
   if(ticket&&profile.version!==current.version){ticket=null;field.value='';message.textContent=t('inviteChanged');}
   profile=current;lastRefresh=Date.now();if(profile.telegram_id||!profile.active||profile.archived){ticket=null;field.value='';message.textContent=t(profile.telegram_id?'inviteLinkedHint':'inviteInactive');}
  }finally{refreshing=false;draw();}
 }
 async function generate(){
  if(busy||refreshing||closed)return;
  // A new request may invalidate the previous token even if its response is lost.
  busy=true;ticket=null;field.value='';message.textContent='';draw();
  const wall=Date.now(),mono=performance.now();
  try{
   const result=await api('/owner/barbers/'+encodeURIComponent(barber.id)+'/invitation','POST',{});
   if(closed||!card.isConnected)return;
   const url=invitationUrl(result.url,botUsername);
   if(!url||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw Error(t('inviteInvalidResponse'));
   ticket={url,wall,mono,ttl:Math.min(900,result.expires_in)};message.textContent=t('inviteOneUse');
  }catch(error){message.textContent=t('inviteCreateFailed');throw error;}
  finally{busy=false;draw();}
 }
 const create=control(t('inviteCreateLink'),generate,'primary');
 const refresh=control(t('inviteRefreshStatus'),refreshStatus);
 const revoke=control(t('revoke'),async()=>{
  if(busy||refreshing||!profile.telegram_id)return;
  if(!await confirm(t('inviteRevokeConfirm'),t('revoke'),t('back')))return;
  busy=true;ticket=null;field.value='';draw();
  try{await api('/owner/barbers/'+encodeURIComponent(barber.id),'PATCH',{version:profile.version,revoke_access:true});}
  finally{busy=false;await refreshStatus();draw();}
 });
 const copy=control(t('inviteCopy'),async()=>{
  draw();if(!active()||busy||refreshing)return;
  const url=ticket.url;
  const copied=await copyInvitation(url,field);
  draw();if(!active()||ticket.url!==url)return;
  if(copied)toast(t('inviteCopied'));else{selectInvitation(field);message.textContent=t('inviteCopyManual');toast(t('inviteCopyManual'));}
 });
 const select=control(t('inviteSelect'),()=>{draw();if(active()&&!busy&&!refreshing){selectInvitation(field);message.textContent=t('inviteCopyManual');}});
 const share=node('a',t('inviteSend'),'secondary invitation-share');share.target='_blank';share.rel='noopener noreferrer';
 share.addEventListener('click',event=>{
  draw();if(!active()||busy||refreshing){event.preventDefault();return;}
  if(typeof tg?.openTelegramLink==='function'){
   event.preventDefault();try{tg.openTelegramLink(share.href);}catch{message.textContent=t('inviteShareFailed');toast(t('inviteShareFailed'));}
  }
 });
 const unavailable=node('p',null,'notice');controls.append(create,refresh,revoke);linkActions.append(copy,share,select);card.append(controls,unavailable,message,linkBox);panel.append(card);
 const focus=()=>{if(!closed&&card.isConnected&&Date.now()-lastRefresh>5000)void refreshStatus().catch(error=>toast(error.message));};
 const visibility=()=>{draw();if(document.visibilityState==='visible')focus();};
 document.addEventListener('visibilitychange',visibility);window.addEventListener('focus',focus);
 const interval=setInterval(()=>{if(!card.isConnected){dispose();return;}draw();},1000);
 draw();void refreshStatus().catch(error=>toast(error.message));
 return dispose;
}
