import { activeBotEnv } from '../src/bot-installation';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectReplacementBot, refreshReplacementProbe } from '../src/bot-replacement';
import type { Env, Row } from '../src/types';
function fixture(){
 const saved:unknown[][]=[];
 const db={prepare(){return {bind(...values:unknown[]){return {async run(){saved.push(values);},async first(){return null;}};}};}} as unknown as D1Database;
 return {saved,env:{DB:db,APP_MODE:'demo',APP_URL:'https://demo.test/',BOT_TOKEN:'123456:TEST_OLD',NEXT_BOT_TOKEN:'654321:TEST_NEW',NEXT_BOT_USERNAME:'Barber37Bot'} as Env};
}
const bot={id:654321,is_bot:true,username:'Barber37Bot'};
test('replacement probe is inert without an inactive token and uses read methods only',async()=>{
 const {env,saved}=fixture(),methods:string[]=[];
 const read=async(_e:Env,m:string)=>{methods.push(m);return m==='getMe'?bot:{url:'',pending_update_count:0};};
 assert.equal(await inspectReplacementBot({...env,NEXT_BOT_TOKEN:''},read),null);assert.equal(methods.length,0);
 const result=await inspectReplacementBot(env,read);assert.equal(result!.ready,true);assert.deepEqual(methods,['getMe','getWebhookInfo']);
 assert.equal(saved.length,1);assert(!JSON.stringify(saved).includes('TEST_NEW'));assert.equal(env.BOT_TOKEN,'123456:TEST_OLD');
});
test('replacement probe rejects the wrong username token identity and already active bot',async()=>{
 for(const fake of [{...bot,username:'AnotherBot'},{...bot,id:7},{...bot,is_bot:false},{...bot,id:123456}]){
  const {env}=fixture();const result=await inspectReplacementBot({...env,NEXT_BOT_TOKEN:fake.id===123456?'123456:TEST_OLD':env.NEXT_BOT_TOKEN},async()=>fake);
  assert.equal(result!.ready,false);assert(['BOT_MISMATCH','SAME_BOT'].includes(result!.reason));
 }
});
test('replacement probe preserves pending updates and rejects another webhook without storing its private URL',async()=>{
 const {env,saved}=fixture();
 const result=await inspectReplacementBot(env,async(_e,m)=>m==='getMe'?bot:{url:'https://other.test/private?secret=TEST_PRIVATE',pending_update_count:7});
 assert.equal(result!.ready,false);assert.equal(result!.reason,'EXISTING_WEBHOOK');assert.equal(result!.pending_updates,7);assert(!JSON.stringify(saved).includes('TEST_PRIVATE'));
});
test('replacement probe reports an unavailable candidate and rejects unsafe app origins',async()=>{
 const {env}=fixture();assert.equal((await inspectReplacementBot(env,async()=>null))!.reason,'CANDIDATE_UNAVAILABLE');
 assert.equal((await inspectReplacementBot({...env,APP_URL:'http://demo.test/'},async(_e,m)=>m==='getMe'?bot:{url:''}))!.reason,'INVALID_APP_URL');
});
test('scheduled replacement probe leaves the current installation untouched when not configured',async()=>{
 const {env,saved}=fixture();await refreshReplacementProbe({...env,NEXT_BOT_TOKEN:undefined});assert.equal(saved.length,0);
});

test('explicit bot activation preserves original bindings and derives a separate webhook identity',()=>{
 const {env}=fixture();env.WEBHOOK_SECRET='OLD_TEST_SECRET_12345678901234567890';env.NEXT_WEBHOOK_SECRET='NEW_TEST_SECRET_12345678901234567890';env.MINI_APP_URL='https://t.me/OldTestBot/app';
 assert.equal(activeBotEnv(env),env);
 const active=activeBotEnv({...env,ACTIVE_BOT:'next'});
 assert.equal(active.BOT_TOKEN,env.NEXT_BOT_TOKEN);assert.equal(active.BOT_USERNAME,'Barber37Bot');assert.equal(active.WEBHOOK_SECRET,env.NEXT_WEBHOOK_SECRET);assert.equal(active.PREVIOUS_WEBHOOK_SECRET,env.WEBHOOK_SECRET);
 assert.equal(active.TELEGRAM_UPDATE_NAMESPACE,'654321');assert.equal(active.MINI_APP_URL,undefined);assert.equal(active.LEGACY_CALLBACK_FORWARDING_ENABLED,'false');
 assert.equal(env.BOT_TOKEN,'123456:TEST_OLD');assert.equal(env.WEBHOOK_SECRET,'OLD_TEST_SECRET_12345678901234567890');
});
test('bot activation fails closed if inactive secrets are missing reused or belong to the current bot',()=>{
 const {env}=fixture();const ready={...env,ACTIVE_BOT:'next',WEBHOOK_SECRET:'OLD_TEST_SECRET_12345678901234567890',NEXT_WEBHOOK_SECRET:'NEW_TEST_SECRET_12345678901234567890'};
 for(const changed of [{NEXT_WEBHOOK_SECRET:undefined},{NEXT_WEBHOOK_SECRET:ready.WEBHOOK_SECRET},{NEXT_BOT_TOKEN:ready.BOT_TOKEN},{ACTIVE_BOT:'other'},{NEXT_BOT_USERNAME:'bad/name'}])assert.throws(()=>activeBotEnv({...ready,...changed}),/BOT_INSTALLATION_NOT_READY/);
});
