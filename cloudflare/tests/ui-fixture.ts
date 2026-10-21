/** Local UI test fixture only. Never used by the deployment entrypoint. */
import worker from '../src/index';
import { hmac, hex } from '../src/auth';
import type { Env } from '../src/types';
export default {
 async fetch(request:Request,env:Env,ctx:ExecutionContext){
  const url=new URL(request.url);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return new Response('LOCAL_TEST_ONLY',{status:403});
  if(url.pathname==='/__test_telegram.js'){
   const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:1}),query_id:'local-ui-test'});
   const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
   const key=await hmac(new TextEncoder().encode('WebAppData'),env.BOT_TOKEN!);p.set('hash',hex(await hmac(key,check)));
   return new Response(`window.Telegram={WebApp:{initData:${JSON.stringify(p.toString())},ready(){},expand(){}}};`,{headers:{'Content-Type':'application/javascript','Cache-Control':'no-store'}});
  }
  if(url.pathname==='/'){
   const response=await env.ASSETS!.fetch(request);const html=(await response.text()).replace('<script type="module"','<script src="/__test_telegram.js"></script><script type="module"');
   return new Response(html,{headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'}});
  }
  return worker.fetch(request as any,env,ctx);
 }
};
