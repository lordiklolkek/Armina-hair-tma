import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Browser ES module is exercised directly, without a copied implementation.
import {invitationUrl,remainingSeconds,invitationShareUrl,copyInvitation,mountInvitationPanel} from '../public/invitations.js';
const url='https://t.me/TestOnly_Bot?start=join_'+ 'a'.repeat(32);
test('invitation validation permits only the current bot and a single opaque start token',()=>{
 assert.equal(invitationUrl(url,'TestOnly_Bot'),url);
 for(const bad of [url.replace('https:','http:'),url.replace('t.me','evil.test'),url+'&extra=1',url+'#fragment',url.replace('join_','booking_'),url.replace('TestOnly_Bot','Other_Bot'),url.replace('https://','https://user:pass@')])assert.equal(invitationUrl(bad,'TestOnly_Bot'),null);
 assert.equal(invitationUrl(url,''),null);
});
test('countdown expires at 15 minutes and uses both clocks across backgrounding and wall-clock rollback',()=>{
 const ticket={wall:100000,mono:5000,ttl:900};
 assert.equal(remainingSeconds(ticket,100000,5000),900);
 assert.equal(remainingSeconds(ticket,999999,5000),1);
 assert.equal(remainingSeconds(ticket,1000000,5000),0);
 assert.equal(remainingSeconds(ticket,1,905000),0);
 assert.equal(remainingSeconds(null),0);
});
test('Telegram sharing preserves the exact invitation and localized message as separate encoded fields',()=>{
 const share=new URL(invitationShareUrl(url,'37 · Հրավեր & приглашение'));
 assert.equal(share.origin,'https://t.me');assert.equal(share.pathname,'/share/url');assert.equal(share.searchParams.get('url'),url);assert.equal(share.searchParams.get('text'),'37 · Հրավեր & приглашение');
});
test('clipboard starts immediately in user activation and reports success only after the write resolves',async()=>{
 let written='',resolve:any;const pending=new Promise<void>(r=>resolve=r);
 const copying=copyInvitation(url,{}, {clipboard:{writeText:(value:string)=>{written=value;return pending;}}},{});
 assert.equal(written,url);resolve();assert.equal(await copying,true);
});
test('restricted or absent Clipboard API selects the complete URL and checks legacy copy result',async()=>{
 const calls:string[]=[];const field={value:url,focus(){calls.push('focus');},select(){calls.push('select');},setSelectionRange(a:number,b:number){calls.push(a+':'+b);}};
 assert.equal(await copyInvitation(url,field,{}, {execCommand:(command:string)=>command==='copy'}),true);
 assert.deepEqual(calls,['focus','select','0:'+url.length]);
 assert.equal(await copyInvitation(url,field,{clipboard:{writeText(){return Promise.reject(Error('denied'));}}},{execCommand:()=>false}),false);
 assert.equal(await copyInvitation(url,field,{},{execCommand(){throw Error('unsupported');}}),false);
});

// Small event-driven DOM fixture checks actual controls, not a replica of the state machine.
class Element extends EventTarget{
 children:Element[]=[];attributes:Record<string,string>={};dataset:Record<string,string>={};textContent='';value='';hidden=false;disabled=false;isConnected=true;href='';tag:string;
 constructor(tag:string){super();this.tag=tag;}
 append(...nodes:Element[]){this.children.push(...nodes);}
 replaceChildren(...nodes:Element[]){this.children=nodes;}
 setAttribute(k:string,v:string){this.attributes[k]=v;}
 removeAttribute(k:string){delete this.attributes[k];if(k==='href')this.href='';}
 focus(){} select(){} setSelectionRange(){}
}
const flush=async()=>{await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));};
test('invitation controls rotate links expire disable share and refresh binding without persisting tokens',async()=>{
 const descriptors=new Map<string,PropertyDescriptor|undefined>();for(const key of ['document','window','setInterval','clearInterval'])descriptors.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
 const doc=Object.assign(new EventTarget(),{createElement:(tag:string)=>new Element(tag),visibilityState:'visible'}),win=new EventTarget();
 let tick:()=>void=()=>{},now=Date.now(),creates=0,linked=false,fail=false;const realNow=Date.now;
 Object.defineProperty(globalThis,'document',{configurable:true,value:doc});Object.defineProperty(globalThis,'window',{configurable:true,value:win});
 Object.defineProperty(globalThis,'setInterval',{configurable:true,value:(fn:()=>void)=>{tick=fn;return 1;}});Object.defineProperty(globalThis,'clearInterval',{configurable:true,value:()=>{}});Date.now=()=>now;
 try{
  const panel=new Element('div'),barber={id:'test',name:'TEST',active:1,archived:0,version:1,telegram_id:null};let shared='';
  mountInvitationPanel({panel,barber,t:(key:string)=>key,toast:()=>{},botUsername:'TestOnly_Bot',tg:{openTelegramLink:(value:string)=>shared=value},confirm:async()=>true,api:async(_path:string,method:string)=>{
   if(method==='POST'){creates++;if(fail)throw Error('network');return {url:url.replace('a'.repeat(32),String(creates).repeat(32)),expires_in:900};}
   return [{...barber,version:linked?2:1,telegram_id:linked?99:null}];
  }});
  const all=():Element[]=>{const walk=(n:Element):Element[]=>[n,...n.children.flatMap(walk)];return walk(panel);};
  const control=(label:string)=>all().find(n=>n.textContent===label)!;
  const click=async(n:Element)=>{assert(!n.disabled);n.dispatchEvent(new Event('click',{cancelable:true}));await flush();};
  await flush();assert.equal(creates,0);assert(control('telegramUnlinked'));
  await click(control('inviteCreateLink'));const field=all().find(n=>n.tag==='textarea')!;assert(field.value.includes('1'.repeat(32)));
  await click(control('inviteSend'));assert(new URL(shared).searchParams.get('url')!.includes('1'.repeat(32)));
  await click(control('inviteNewLink'));assert(field.value.includes('2'.repeat(32)));assert(!field.value.includes('1'.repeat(32)));
  now+=900001;tick();assert(control('inviteCopy').disabled);assert(control('inviteSelect').disabled);assert.equal(control('inviteSend').href,'');assert.equal(field.value,'');assert(control('inviteExpired'));
  fail=true;await click(control('inviteNewLink'));assert.equal(field.value,'');assert(control('inviteCreateFailed'));assert(control('inviteCopy').disabled);
  fail=false;await click(control('inviteCreateLink'));linked=true;await click(control('inviteRefreshStatus'));assert(control('telegramLinked'));assert.equal(field.value,'');
  panel.children[0].isConnected=false;tick();
 }finally{
  Date.now=realNow;for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
 }
});
