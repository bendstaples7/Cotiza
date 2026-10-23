#!/usr/bin/env node
/**
 * Generate payout CSVs through Cotiza's existing server-side Jobber connection.
 * In ChatGPT, pass the connected office Gmail send action as sendEmail.
 * The CLI saves CSVs and the ready-to-send Gmail MIME payload; it does not expose
 * Jobber credentials or require Gmail permissions to be added to Cotiza.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const BASE='https://social-media-cross-poster.chicago-reno.workers.dev';
const OFFICE='office@chicago-reno.com';
export async function runWeeklyReports({start,end,sessionToken,base=BASE,outputDir,sendEmail,fetchImpl=fetch}) {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end))throw new Error('Use YYYY-MM-DD reporting dates.');
 if(!sessionToken)throw new Error('A current Cotiza session token is required.');
 if(new URL(base).origin!==BASE&&!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base))throw new Error('Use the verified Cotiza server or local development.');
 const response=await fetchImpl(base+'/api/reports/weekly',{
  method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+sessionToken},
  body:JSON.stringify({start,end}),signal:AbortSignal.timeout(120000),
 });
 if(!response.ok)throw new Error('Cotiza report generation failed (HTTP '+response.status+'). No email sent.');
 const result=await response.json();
 if(result.complete!==true||!Array.isArray(result.files)||result.files.length!==2||result.source!=='jobber-public-api')throw new Error('Incomplete reports. No email sent.');
 const expected=[`Expense_Report_${start}_${end}.csv`,`Transaction_List_${start}_${end}.csv`];
 if(!result.files.every((f,i)=>f.filename===expected[i]&&f.mimeType==='text/csv'&&typeof f.content==='string'))throw new Error('Unexpected report files. No email sent.');
 const email={
  to:OFFICE,subject:`Cotiza API payout reports: ${start} to ${end}`,
  payload:{mime_type:'multipart/mixed',parts:[
   {mime_type:'text/html',body:{content:`<p>Chicago Reno payout reports for ${start} through ${end} (America/Chicago).</p><p>Generated from the connected Jobber public API. These are Cotiza reports, not Jobber's native exports. Invoice rows are not cash receipts; processor payments may still be unsettled.</p><p>Expense payer, entry user and reimbursement recipient are included separately. Review receipt details before authorizing reimbursements.</p>`}},
   ...result.files.map(f=>({mime_type:'text/csv',charset:'UTF-8',filename:f.filename,content_disposition:'attachment',body:{base64_url_content:Buffer.from(f.content,'utf8').toString('base64url')}})),
  ]},
 };
 if(outputDir){
  await mkdir(outputDir,{recursive:true});
  for(const f of result.files)await writeFile(join(outputDir,f.filename),f.content,{mode:0o600});
  await writeFile(join(outputDir,'email-payload.json'),JSON.stringify(email,null,2),{mode:0o600});
 }
 // The connector owns the Gmail credentials. Never automatically retry an
 // uncertain send: the email might have been delivered even if its response failed.
 const delivery=sendEmail?await sendEmail(email):null;
 return {summary:result.summary,period:result.period,email,delivery,reports:result};
}
async function main(){
 const args=process.argv.slice(2);const get=k=>args[args.indexOf(k)+1];
 if(!args.includes('--start')||!args.includes('--end'))throw new Error('Usage: node scripts/weekly-payout-reports.mjs --start YYYY-MM-DD --end YYYY-MM-DD [--out DIR]. Set COTIZA_SESSION_TOKEN from your existing Cotiza login.');
 const result=await runWeeklyReports({start:get('--start'),end:get('--end'),sessionToken:process.env.COTIZA_SESSION_TOKEN,
  outputDir:resolve(args.includes('--out')?get('--out'):'weekly-report-output')});
 console.log(JSON.stringify({period:result.period,summary:result.summary,emailPrepared:true,emailSent:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Weekly report generation failed. No email was sent. Verify the session, date range and server availability.');process.exitCode=1;});
