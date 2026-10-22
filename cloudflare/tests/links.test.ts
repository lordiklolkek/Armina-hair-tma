import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { bookingLink, linkedBarber, qrPixels } from '../public/links.js';
test('personal links select only available barbers and cannot grant a role',()=>{
 assert.equal(linkedBarber('?barber=demo-a',null,['demo-a']),'demo-a');
 assert.equal(linkedBarber('','barber_demo-a',['demo-a']),'demo-a');
 assert.equal(linkedBarber('?barber=archived','owner_1',['demo-a']),null);
 assert.equal(linkedBarber('?barber=%3Cscript%3E',null,['demo-a']),null);
});
test('web and configured Telegram links preserve the selected barber',()=>{
 assert.equal(bookingLink('https://demo.example/nested','', 'demo-a'),'https://demo.example/?barber=demo-a');
 assert.equal(bookingLink('https://demo.example','https://t.me/Demo37Bot/app','demo-a'),'https://t.me/Demo37Bot/app?startapp=barber_demo-a');
 assert.equal(bookingLink('https://demo.example','https://t.me/Demo37Bot','demo-a'),'https://t.me/Demo37Bot?startapp=barber_demo-a');
 assert.equal(bookingLink('https://demo.example','javascript:alert(1)'),'https://demo.example/');
 assert.throws(()=>bookingLink('https://demo.example','','<script>'));
});
test('independent QR decoder reads exact general and personal URLs from generated pixels',()=>{
 for(const url of [bookingLink('https://barbershop-37-demo.barbershop-37.workers.dev'),bookingLink('https://demo.example','', '12345678-1234-1234-1234-123456789012'),bookingLink('https://demo.example','https://t.me/Demo37Bot/app','demo-a')]){
  const image=qrPixels(url);const decoded=jsQR(image.data,image.size,image.size);assert.equal(decoded?.data,url);
 }
});
test('bot start links work without a BotFather Main Mini App and fit Telegram payload limits',()=>{
 const general=bookingLink('https://demo.test','',null,'Demo37Bot');assert.equal(general,'https://t.me/Demo37Bot?start=booking');
 const personal=bookingLink('https://demo.test','','demo-a','Demo37Bot');assert.equal(personal,'https://t.me/Demo37Bot?start=barber_demo-a');
 const pixels=qrPixels(personal);assert.equal(jsQR(pixels.data,pixels.size,pixels.size)?.data,personal);
 const long='a'.repeat(80);assert.equal(bookingLink('https://demo.test','',long,'Demo37Bot'),'https://demo.test/?barber='+long);
});
