import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {uploadReceipts,googleAccessToken} from '../../scripts/upload-subscription-receipts.mjs';
const bytes=Buffer.from('%PDF-1.4\n'+('original receipt '.repeat(20))+'\n%%EOF');
const filename='Jobber_Subscription_2026-10-24_abc123.pdf';
const checksum=createHash('sha256').update(bytes).digest('hex');
const folder={id:'folder123',driveId:'shared123',mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}};
const remote={id:'file123',name:filename,mimeType:'application/pdf',parents:['folder123'],size:String(bytes.length),md5Checksum:createHash('md5').update(bytes).digest('hex')};
async function fixture(fn){
 const directory=await mkdtemp(join(tmpdir(),'drive-receipts-'));
 try{
  await writeFile(join(directory,filename),bytes);
  await writeFile(join(directory,'manifest.json'),JSON.stringify({month:'2026-10',source:'jobber-subscription-receipt',files:[{filename,date:'2026-10-24',sha256:checksum}]}));
  await fn(directory);
 }finally{await rm(directory,{recursive:true,force:true});}
}
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
test('uploads original PDF only to designated folder and verifies readback',()=>fixture(async directory=>{
 let posts=0;
 const fetchImpl=async(url,opts)=>{
  assert.equal(opts.headers.Authorization,'Bearer secret');
  assert.equal(opts.redirect,'error');
  if(url.includes('/upload/')){
   posts++;assert.equal(opts.method,'POST');assert.ok(opts.body.includes(bytes));
   const body=opts.body.toString();assert.ok(body.includes('"parents":["folder123"]'));assert.ok(!body.includes('"permissions"'));
   return response({id:'file123'});
  }
  if(url.includes('/files?'))return response({files:[]});
  return response(url.includes('/file123?')?remote:folder);
 };
 assert.deepEqual(await uploadReceipts({directory,folderId:'folder123',accessToken:'secret',fetchImpl}),{uploaded:1,skipped:0});
 assert.equal(posts,1);
 assert.ok(!(await readFile(join(directory,'drive-delivery.json'),'utf8')).includes('secret'));
}));
test('existing identical receipt is skipped without any write',()=>fixture(async directory=>{
 const fetchImpl=async(url,opts)=>{
  assert.equal(opts.method,undefined);
  return response(url.includes('/files?')?{files:[remote]}:folder);
 };
 assert.deepEqual(await uploadReceipts({directory,folderId:'folder123',accessToken:'secret',fetchImpl}),{uploaded:0,skipped:1});
}));
test('conflicting remote receipt fails without overwrite',()=>fixture(async directory=>{
 let posts=0;
 await assert.rejects(uploadReceipts({directory,folderId:'folder123',accessToken:'secret',fetchImpl:async(url,opts)=>{
  if(opts.method)posts++;
  return response(url.includes('/files?')?{files:[{...remote,md5Checksum:'bad'}]}:folder);
 }}),/verification/);
 assert.equal(posts,0);
}));
test('duplicate candidates and incomplete listings fail',()=>fixture(async directory=>{
 for(const listing of [{files:[remote,remote]},{files:[],nextPageToken:'more'}]){
  await assert.rejects(uploadReceipts({directory,folderId:'folder123',accessToken:'secret',fetchImpl:async url=>response(url.includes('/files?')?listing:folder)}),/Ambiguous/);
 }
}));
test('invalid local checksum fails before any API call',()=>fixture(async directory=>{
 await writeFile(join(directory,filename),Buffer.from('%PDF-1.4\n'+'changed '.repeat(30)+'%%EOF'));
 let calls=0;
 await assert.rejects(uploadReceipts({directory,folderId:'folder123',accessToken:'secret',fetchImpl:async()=>{calls++;}}),/checksum/);
 assert.equal(calls,0);
}));
test('uncertain upload is not retried',()=>fixture(async directory=>{
 let posts=0;
 await assert.rejects(uploadReceipts({directory,folderId:'folder123',accessToken:'secret',fetchImpl:async(url,opts)=>{
  if(opts.method==='POST'){posts++;throw Error('timeout');}
  return response(url.includes('/files?')?{files:[]}:folder);
 }}),/timeout/);
 assert.equal(posts,1);
}));
test('inaccessible folder stops before upload',()=>fixture(async directory=>{
 for(const dest of [{...folder,capabilities:{canAddChildren:false}}]){
  await assert.rejects(uploadReceipts({directory,folderId:'folder123',accessToken:'secret',fetchImpl:async()=>response(dest)}));
 }
}));
test('manifest traversal filename is rejected before any remote access',()=>fixture(async directory=>{
 await writeFile(join(directory,'manifest.json'),JSON.stringify({month:'2026-10',source:'jobber-subscription-receipt',files:[{filename:'../credential.json',date:'2026-10-24'}]}));
 let calls=0;
 await assert.rejects(uploadReceipts({directory,folderId:'folder123',accessToken:'secret',fetchImpl:async()=>{calls++;}}),/Invalid/);
 assert.equal(calls,0);
}));

test('My Drive folders are supported using user OAuth',()=>fixture(async directory=>{
 const fetchImpl=async url=>response(url.includes('/files?')?{files:[remote]}:{...folder,driveId:undefined});
 assert.deepEqual(await uploadReceipts({directory,folderId:'folder123',accessToken:'secret',fetchImpl}),{uploaded:0,skipped:1});
}));
test('OAuth refresh uses fixed Google endpoint and keeps credentials in request body',async()=>{
 const token=await googleAccessToken({clientId:'client',clientSecret:'private',refreshToken:'refresh',fetchImpl:async(url,opts)=>{
  assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(opts.redirect,'error');
  assert.equal(opts.body.get('client_secret'),'private');return response({access_token:'token'});
 }});
 assert.equal(token,'token');
 await assert.rejects(googleAccessToken({}));
 await assert.rejects(googleAccessToken({clientId:'c',clientSecret:'s',refreshToken:'r',fetchImpl:async()=>new Response('',{status:401})}));
});
