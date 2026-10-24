#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {validatePdf} from './jobber-subscription-receipts.mjs';

const API='https://www.googleapis.com/drive/v3';
const FIELDS='id,name,mimeType,parents,md5Checksum,size,appProperties,webViewLink';
const hash=(algorithm,bytes)=>createHash(algorithm).update(bytes).digest('hex');
export function verifyRemote(file,item,folderId){
 if(!file?.id||file.name!==item.filename||file.mimeType!=='application/pdf'||
    !file.parents?.includes(folderId)||file.md5Checksum!==hash('md5',item.bytes)||
    Number(file.size)!==item.bytes.length)throw Error('Drive receipt verification failed.');
}
export async function googleAccessToken({clientId,clientSecret,refreshToken,fetchImpl=fetch}){
 if(!clientId||!clientSecret||!refreshToken)throw Error('Google Drive OAuth authorization is not configured.');
 const response=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',
  headers:{'Content-Type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'}),
  redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error('Google Drive OAuth refresh failed.');
 const data=await response.json();
 if(!data.access_token)throw Error('Google Drive OAuth response missing access token.');
 return data.access_token;
}
export async function uploadReceipts({directory,folderId,accessToken,fetchImpl=fetch}){
 if(!/^[a-zA-Z0-9_-]+$/.test(folderId??'')||!accessToken)throw Error('Drive folder and access token required.');
 const request=async(url,options={})=>{
  const response=await fetchImpl(url,{...options,headers:{...options.headers,Authorization:'Bearer '+accessToken},
   redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error('Google Drive request failed (HTTP '+response.status+').');
  return response.json();
 };
 const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
 if(manifest.source!=='jobber-subscription-receipt'||!Array.isArray(manifest.files)||!manifest.files.length)throw Error('Missing complete receipt manifest.');
 const seen=new Set();
 const items=[];
 // Validate every input before uploading any file.
 for(const file of manifest.files){
  const match=/^Jobber_Subscription_(\d{4}-\d{2}-\d{2})_([a-zA-Z0-9_-]+)\.pdf$/.exec(file.filename??'');
  if(!match||match[1]!==file.date||file.date.slice(0,7)!==manifest.month||seen.has(file.filename))throw Error('Invalid receipt manifest entry.');
  seen.add(file.filename);
  const bytes=await readFile(join(directory,file.filename));validatePdf(bytes,'application/pdf');
  if(bytes.length>5000000||hash('sha256',bytes)!==file.sha256)throw Error('Receipt size or checksum mismatch.');
  items.push({...file,bytes,transactionId:match[2]});
 }
 const folder=await request(API+'/files/'+folderId+'?supportsAllDrives=true&fields=id,mimeType,driveId,capabilities(canAddChildren)');
 if(folder.id!==folderId||folder.mimeType!=='application/vnd.google-apps.folder'||folder.capabilities?.canAddChildren!==true)throw Error('Destination is not a writable Drive folder.');
 const results=[];
 for(const item of items){
  const query="'"+folderId+"' in parents and trashed = false and name = '"+item.filename+"'";
  const search=new URL(API+'/files');
  search.search=new URLSearchParams({q:query,...(folder.driveId?{corpora:'drive',driveId:folder.driveId}:{corpora:'user'}),includeItemsFromAllDrives:'true',supportsAllDrives:'true',pageSize:'100',fields:'nextPageToken,files('+FIELDS+')'});
  const existing=await request(search.toString());
  if(existing.nextPageToken||!Array.isArray(existing.files)||existing.files.length>1)throw Error('Ambiguous receipt duplicates in Drive.');
  if(existing.files.length){
   verifyRemote(existing.files[0],item,folderId);
   results.push({filename:item.filename,id:existing.files[0].id,skipped:true});continue;
  }
  const boundary='receipt_'+randomUUID();
  const metadata={name:item.filename,mimeType:'application/pdf',parents:[folderId],
   appProperties:{source:'jobber-subscription-receipt',transactionId:item.transactionId,sha256:item.sha256}};
  const body=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)+'\r\n--'+boundary+'\r\nContent-Type: application/pdf\r\n\r\n'),item.bytes,Buffer.from('\r\n--'+boundary+'--\r\n')]);
  // Never retry an uncertain create. Next run searches and verifies the existing receipt.
  const created=await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id',{
   method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body});
  if(!/^[a-zA-Z0-9_-]+$/.test(created.id??''))throw Error('Missing uploaded Drive file ID.');
  const readback=await request(API+'/files/'+created.id+'?supportsAllDrives=true&fields='+FIELDS);
  verifyRemote(readback,item,folderId);
  results.push({filename:item.filename,id:created.id,skipped:false});
 }
 await writeFile(join(directory,'drive-delivery.json'),JSON.stringify({month:manifest.month,files:results},null,2),{mode:0o600});
 return {uploaded:results.filter(x=>!x.skipped).length,skipped:results.filter(x=>x.skipped).length};
}
async function main(){
 const directory=resolve(process.argv[2]??'subscription-receipt-output');
 const accessToken=await googleAccessToken({clientId:process.env.JOBBER_DRIVE_CLIENT_ID,clientSecret:process.env.JOBBER_DRIVE_CLIENT_SECRET,refreshToken:process.env.JOBBER_DRIVE_REFRESH_TOKEN});
 const result=await uploadReceipts({directory,folderId:process.env.JOBBER_RECEIPTS_DRIVE_FOLDER_ID,accessToken});
 console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(()=>{console.error('Drive receipt delivery failed. Check folder access and Google authentication. An uncertain upload is not automatically retried.');process.exitCode=1;});
}
