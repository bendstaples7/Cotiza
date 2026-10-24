#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,open,unlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
export const ORIGIN='https://secure.getjobber.com';
export const BILLING=ORIGIN+'/accounts/billing_info/account_and_billing';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function selectPayments(rows,month){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error('Use YYYY-MM.');
 const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 const out=[];
 for(const row of rows){
  const m=/^(\w{3}) (\d{2}), (\d{4})$/.exec(row.date.trim());
  if(!m||!months.includes(m[1]))throw Error('Unknown billing date format.');
  const date=m[3]+'-'+String(months.indexOf(m[1])+1).padStart(2,'0')+'-'+m[2];
  if(date.slice(0,7)!==month)continue;
  const amount=/^\$([\d,]+\.\d{2}) USD$/.exec(row.amount.trim());
  if(!amount||!row.paid)throw Error('Expected a paid USD subscription receipt.');
  out.push({...row,date,amount:Number(amount[1].replaceAll(',',''))});
 }
 if(!out.length)throw Error('No receipt for requested month yet.');
 return out;
}
export function receiptId(url){
 const u=new URL(url);
 if(u.origin!==ORIGIN||u.search||u.hash)throw Error('Unexpected receipt destination.');
 const m=/^\/accounts\/billing_info\/download_invoice\/transaction\/([a-zA-Z0-9_-]+)$/.exec(u.pathname);
 if(!m)throw Error('Unexpected receipt path.');
 return m[1];
}
export function validatePdf(bytes,type){
 if(!/^application\/pdf(?:;|$)/i.test(type??'')||bytes.length<100||bytes.subarray(0,5).toString()!=='%PDF-'||!bytes.subarray(-2048).includes(Buffer.from('%%EOF')))throw Error('Receipt was not a complete PDF.');
}
export async function saveReceipt({url,payment,outputDir,download}){
 const id=receiptId(url);await mkdir(outputDir,{recursive:true});
 const filename='Jobber_Subscription_'+payment.date+'_'+id+'.pdf';
 const path=join(outputDir,filename);
 try{
  const bytes=await readFile(path);validatePdf(bytes,'application/pdf');
  return {filename,skipped:true,sha256:createHash('sha256').update(bytes).digest('hex')};
 }catch(e){if(e.code!=='ENOENT')throw e;}
 const {bytes,contentType}=await download(url);validatePdf(bytes,contentType);
 const handle=await open(path,'wx',0o600);
 try{await handle.writeFile(bytes);}catch(e){await handle.close();await unlink(path);throw e;}
 await handle.close();
 return {filename,skipped:false,sha256:createHash('sha256').update(bytes).digest('hex')};
}
function readSession(){
 const executable=process.platform==='win32'?'npx.cmd':'npx';
 const raw=execFileSync(executable,['wrangler','d1','execute','DB','--remote','--json','--command',
  "SELECT cookies, expires_at FROM jobber_web_session WHERE id = 'default'"],
  {cwd:join(ROOT,'worker'),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000});
 const row=JSON.parse(raw)?.[0]?.results?.[0];
 if(!row?.cookies||!(Date.parse(row.expires_at)>Date.now()))throw Error('Jobber web session needs refresh.');
 return row.cookies;
}
// Read the semantic dt/dd payment rows; CSS module class names are unstable.
export function paymentRows(){
 const heading=Array.from(document.querySelectorAll('h3')).find(e=>e.textContent.trim()==='Payment history');
 let section=heading?.parentElement;
 while(section&&!section.querySelector('dl'))section=section.parentElement;
 return Array.from(section?.querySelectorAll('dl dd')??[]).map((dd,index)=>({
  index,date:dd.previousElementSibling?.textContent.trim()??'',
  amount:dd.textContent.replace(/Receipt/g,'').trim(),paid:!!dd.querySelector('[data-testid="paidInvoice"]')
 }));
}
export async function run({month,outputDir,session,launch,fetchImpl=fetch}){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error('Use YYYY-MM.');
 const browser=await launch();
 try{
  const context=browser.defaultBrowserContext();
  await context.setCookie(...session.split(';').map(part=>{
   const i=part.indexOf('=');if(i<=0)throw Error('Invalid stored Jobber session.');
   return {name:part.slice(0,i).trim(),value:part.slice(i+1).trim(),domain:'.getjobber.com',path:'/',secure:true};
  }));
  const page=await browser.newPage();
  await page.goto(BILLING,{waitUntil:'networkidle2',timeout:60000});
  if(!page.url().startsWith(BILLING))throw Error('Jobber login or billing access required.');
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('h3')).some(e=>e.textContent.trim()==='Payment history'),{timeout:30000});
  const payments=selectPayments(await page.evaluate(paymentRows),month);
  const files=[];
  for(const payment of payments){
   const pending=browser.waitForTarget(t=>{
    try{return t.opener()===page.target()&&!!receiptId(t.url());}catch{return false;}
   },{timeout:30000});
   // Handle rejection immediately while the click is pending.
   pending.catch(()=>{});
   await page.evaluate(index=>{
    const heading=Array.from(document.querySelectorAll('h3')).find(e=>e.textContent.trim()==='Payment history');
    let section=heading?.parentElement;while(section&&!section.querySelector('dl'))section=section.parentElement;
    const dd=section.querySelectorAll('dl dd')[index];
    const buttons=Array.from(dd.querySelectorAll('button')).filter(b=>b.textContent.trim()==='Receipt');
    if(buttons.length!==1)throw Error('Receipt control changed.');
    buttons[0].click();
   },payment.index);
   const target=await pending;
   const result=await saveReceipt({url:target.url(),payment,outputDir,download:async url=>{
    const response=await fetchImpl(url,{headers:{Cookie:session,Accept:'application/pdf'},redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw Error('Receipt download failed.');
    if(Number(response.headers.get('content-length'))>20000000)throw Error('Receipt too large.');
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>20000000)throw Error('Receipt too large.');
    return {bytes,contentType:response.headers.get('content-type')};
   }});
   files.push({...result,date:payment.date,amount:payment.amount,currency:'USD'});
   const popup=await target.page();if(popup)await popup.close();
  }
  await writeFile(join(outputDir,'manifest.json'),JSON.stringify({month,source:'jobber-subscription-receipt',files},null,2),{mode:0o600});
  return files;
 }finally{await browser.close();}
}
async function main(){
 const args=process.argv.slice(2);
 const value=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
 const month=value('--month')??new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit'}).format(new Date());
 const outputDir=resolve(value('--out')??'subscription-receipt-output');
 const session=readSession();
 const {default:puppeteer}=await import('puppeteer');
 const files=await run({month,outputDir,session,launch:()=>puppeteer.launch({headless:true})});
 console.log(JSON.stringify({month,files}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(()=>{console.error('Subscription receipt download failed. Check Jobber session, billing access, and receipt availability. No expense or payment was created.');process.exitCode=1;});
}
