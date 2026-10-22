// Presentation only: no credentials, API routes or role decisions live here.
export function icon(name){
 const paths={
 services:'M12 8v4l3 2 M8 2v3 M16 2v3 M3 9h18 M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2',
 my:'M8 3h8v3H8z M7 4H5v17h14V4h-2 M7 11h10 M7 15h7',
 staff:'M9 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M3 20v-3a6 6 0 0 1 12 0v3 M17 4a3 3 0 0 1 0 6 M18 13a5 5 0 0 1 3 5v2',
 owner:'M9 3h6v3l3 2 3-1v6l-3 1-2 3 1 3h-6l-1-3-3-2-3 1v-6l3-1 2-3z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
 clock:'M12 7v5l3 2 M22 12a10 10 0 1 0-20 0 10 10 0 0 0 20 0',
 arrow:'M5 12h14 M13 6l6 6-6 6'
 };
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 for(const [key,value]of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'}))svg.setAttribute(key,value);
 const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[name]||paths.arrow);svg.append(path);return svg;
}
export function setupTelegramAppearance(tg){
 for(const method of ['setHeaderColor','setBackgroundColor','setBottomBarColor']){try{tg?.[method]?.('#0D1010');}catch{/* Older Telegram clients may not support bar colors. */}}
 const apply=()=>{
  const css=document.documentElement.style;
  for(const [prefix,inset]of [['tg-safe',tg?.safeAreaInset],['tg-content',tg?.contentSafeAreaInset]])for(const side of ['top','right','bottom','left'])css.setProperty(`--${prefix}-${side}`,`${Math.max(0,Number(inset?.[side])||0)}px`);
 };
 apply();for(const event of ['safeAreaChanged','contentSafeAreaChanged','viewportChanged','themeChanged'])tg?.onEvent?.(event,apply);
 let baseline=innerHeight;
 const keyboard=()=>{const focused=document.activeElement?.matches('input,textarea,select');if(!focused)baseline=innerHeight;document.body.classList.toggle('keyboard-open',Boolean(focused&&baseline-(window.visualViewport?.height||innerHeight)>120));};
 window.visualViewport?.addEventListener('resize',keyboard);document.addEventListener('focusin',keyboard);document.addEventListener('focusout',()=>requestAnimationFrame(keyboard));
}
export function askConfirmation(message,confirmLabel,cancelLabel){
 const previous=document.activeElement;
 return new Promise(resolve=>{
  const dialog=document.createElement('dialog');dialog.className='confirm-dialog';
  if(typeof dialog.showModal!=='function'){resolve(window.confirm(message));return;}
  const text=document.createElement('h2');text.id='confirm-'+crypto.randomUUID();text.textContent=message;dialog.setAttribute('aria-labelledby',text.id);
  const actions=document.createElement('div');actions.className='actions';
  const cancel=document.createElement('button'),confirm=document.createElement('button');cancel.type=confirm.type='button';cancel.className='secondary';confirm.className='primary';cancel.textContent=cancelLabel;confirm.textContent=confirmLabel;
  let settled=false;const done=value=>{if(settled)return;settled=true;dialog.close();dialog.remove();if(previous?.isConnected)previous.focus();resolve(value);};
  cancel.addEventListener('click',()=>done(false));confirm.addEventListener('click',()=>done(true));dialog.addEventListener('cancel',event=>{event.preventDefault();done(false);});
  actions.append(cancel,confirm);dialog.append(text,actions);document.body.append(dialog);dialog.showModal();cancel.focus();
 });
}
