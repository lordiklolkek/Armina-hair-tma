/** Local UI test fixture only. Never used by the deployment entrypoint. */
import worker from '../src/index';
import { hmac, hex } from '../src/auth';
import type { Env } from '../src/types';
export default {
 async fetch(request:Request,env:Env,ctx:ExecutionContext){
  const url=new URL(request.url);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return new Response('LOCAL_TEST_ONLY',{status:403});
  if(url.pathname==='/__preview'){
   return new Response(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>37 · Local responsive QA</title><style>body{margin:0;background:#060b0b;color:#c6d9d6;font:13px system-ui}header{display:flex;gap:12px;justify-content:center;align-items:center;padding:12px;flex-wrap:wrap}button,select{background:#182622;color:#dcf7ef;border:1px solid #3c6157;border-radius:8px;padding:8px}iframe{display:block;width:390px;height:min(844px,calc(100svh - 80px));border:1px solid #36504a;border-radius:20px;margin:0 auto 30px;max-width:100%;background:#0d1010}</style><header><span>LOCAL · fictional data only</span><output id="metrics">Checking layout…</output><label>Width <select id="width"><option>320</option><option>360</option><option selected>390</option><option>430</option><option>768</option></select></label><label>Telegram theme <select id="theme"><option>dark</option><option>light</option></select></label><label><input id="insets" type="checkbox"> Safe areas</label></header><iframe title="37 mobile preview" src="/?qa_theme=dark"></iframe><script>const frame=document.querySelector('iframe');document.getElementById('width').onchange=e=>frame.style.width=e.target.value+'px';function reload(){frame.src='/?qa_theme='+document.getElementById('theme').value+'&qa_safe='+Number(document.getElementById('insets').checked);}document.getElementById('theme').onchange=reload;document.getElementById('insets').onchange=reload;window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==frame.contentWindow||e.data?.kind!=='37-qa')return;document.getElementById('metrics').textContent=e.data.width+'px · horizontal overflow: '+e.data.overflow+'px';});</script></html>`,{headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'}});
  }
  if(url.pathname==='/__test_telegram.js'){
   const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:1}),query_id:'local-ui-test'});
   const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
   const key=await hmac(new TextEncoder().encode('WebAppData'),env.BOT_TOKEN!);p.set('hash',hex(await hmac(key,check)));
   return new Response(`window.Telegram={WebApp:{initData:${JSON.stringify(p.toString())},colorScheme:${JSON.stringify(url.searchParams.get('qa_theme')==='light'?'light':'dark')},safeAreaInset:{bottom:${url.searchParams.get('qa_safe')==='1'?24:0}},contentSafeAreaInset:{top:${url.searchParams.get('qa_safe')==='1'?32:0}},ready(){},expand(){}}};window.addEventListener('DOMContentLoaded',()=>{let pending=false;const report=()=>{if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;parent.postMessage({kind:'37-qa',width:document.documentElement.clientWidth,overflow:Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth)},location.origin);});};new MutationObserver(report).observe(document.body,{childList:true,subtree:true,attributes:true});window.addEventListener('resize',report);report();});`,{headers:{'Content-Type':'application/javascript','Cache-Control':'no-store'}});
  }
  if(url.pathname==='/'){
   const response=await env.ASSETS!.fetch(request);const html=(await response.text()).replace('<script type="module"',`<script src="/__test_telegram.js?qa_theme=${url.searchParams.get('qa_theme')==='light'?'light':'dark'}&qa_safe=${url.searchParams.get('qa_safe')==='1'?'1':'0'}"></script><script type="module"`);
   return new Response(html,{headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'}});
  }
  return worker.fetch(request as any,env,ctx);
 }
};
