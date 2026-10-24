import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {selectPayments,receiptId,validatePdf,saveReceipt,run,BILLING} from '../../scripts/jobber-subscription-receipts.mjs';
const url='https://secure.getjobber.com/accounts/billing_info/download_invoice/transaction/abc123';
const bytes=Buffer.from('%PDF-1.4\n'+('fixture '.repeat(30))+'\n%%EOF');
const rows=[{index:0,date:'Oct 24, 2026',amount:'$169.00 USD',paid:true},{index:1,date:'Sep 24, 2026',amount:'$169.00 USD',paid:true}];
test('selects the month and actual amount, including multiple receipts',()=>{
 assert.equal(selectPayments(rows,'2026-10')[0].date,'2026-10-24');
 assert.equal(selectPayments([...rows,{...rows[0],index:2,amount:'$19.00 USD'}],'2026-10').length,2);
 assert.equal(selectPayments([{...rows[0],amount:'$1,169.25 USD'}],'2026-10')[0].amount,1169.25);
});
test('missing month, unpaid records, invalid dates and foreign currency fail',()=>{
 assert.throws(()=>selectPayments(rows,'2026-11'),/No receipt/);
 assert.throws(()=>selectPayments(rows,'2026-13'));
 assert.throws(()=>selectPayments([{...rows[0],paid:false}],'2026-10'));
 assert.throws(()=>selectPayments([{...rows[0],amount:'$169.00 CAD'}],'2026-10'));
 assert.throws(()=>selectPayments([{...rows[0],date:'unknown'}],'2026-10'));
});
test('receipt destinations cannot redirect credentials to another origin or path',()=>{
 assert.equal(receiptId(url),'abc123');
 for(const bad of ['https://evil.example/a',url+'?next=bad',url+'#fragment','https://secure.getjobber.com/login','https://secure.getjobber.com.evil.example/accounts/billing_info/download_invoice/transaction/a']){
  assert.throws(()=>receiptId(bad));
 }
});
test('HTML login pages and truncated PDFs are rejected',()=>{
 validatePdf(bytes,'application/pdf');
 assert.throws(()=>validatePdf(Buffer.from('<html>login</html>'),'text/html'));
 assert.throws(()=>validatePdf(bytes.subarray(0,100),'application/pdf'));
});
test('download persists original PDF; rerun skips by transaction ID',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jobber-receipt-'));
 try{
  let count=0;const download=async()=>{count++;return {bytes,contentType:'application/pdf'};};
  const opts={url,payment:{date:'2026-10-24'},outputDir:dir,download};
  const first=await saveReceipt(opts);const second=await saveReceipt(opts);
  assert.equal(count,1);assert.equal(first.skipped,false);assert.equal(second.skipped,true);
  assert.deepEqual(await readFile(join(dir,first.filename)),bytes);
  assert.equal(first.sha256,second.sha256);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('invalid download is never persisted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jobber-receipt-'));
 try{
  await assert.rejects(saveReceipt({url,payment:{date:'2026-10-24'},outputDir:dir,download:async()=>({bytes:Buffer.from('login'),contentType:'text/html'})}));
  await assert.rejects(readFile(join(dir,'Jobber_Subscription_2026-10-24_abc123.pdf')),e=>e.code==='ENOENT');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('runner closes browser, downloads PDF and emits manifest without session',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jobber-receipt-'));
 let closed=false;let clicked=false;let received;
 const pageTarget={};const popup={close:async()=>{}};
 const target={opener:()=>pageTarget,url:()=>url,page:async()=>popup};
 const page={goto:async()=>{},url:()=>BILLING,waitForFunction:async()=>{},target:()=>pageTarget,evaluate:async(fn,arg)=>arg===undefined?rows:(clicked=true)};
 const browser={defaultBrowserContext:()=>({setCookie:async()=>{}}),newPage:async()=>page,waitForTarget:async predicate=>{assert.equal(predicate(target),true);return target;},close:async()=>{closed=true;}};
 try{
  const files=await run({month:'2026-10',outputDir:dir,session:'session=private-value',launch:async()=>browser,fetchImpl:async(u,opts)=>{received=opts;return new Response(bytes,{headers:{'content-type':'application/pdf'}});}});
  assert.equal(files.length,1);assert.equal(clicked,true);assert.equal(closed,true);assert.equal(received.redirect,'error');
  assert.equal(received.headers.Cookie,'session=private-value');
  const manifest=await readFile(join(dir,'manifest.json'),'utf8');assert.ok(!manifest.includes('private-value'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('runner refuses login redirect and closes browser',async()=>{
 let closed=false;
 const browser={defaultBrowserContext:()=>({setCookie:async()=>{}}),newPage:async()=>({goto:async()=>{},url:()=> 'https://secure.getjobber.com/login'}),close:async()=>{closed=true;}};
 await assert.rejects(run({month:'2026-10',outputDir:'.',session:'s=x',launch:async()=>browser}),/login/);
 assert.equal(closed,true);
});
