import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runWeeklyReports} from '../../scripts/weekly-payout-reports.mjs';
const report={complete:true,source:'jobber-public-api',summary:{expenseTotal:10},period:{start:'2026-10-17',end:'2026-10-23'},
 files:[{filename:'Expense_Report_2026-10-17_2026-10-23.csv',mimeType:'text/csv',content:'"test"\r\n'},
 {filename:'Transaction_List_2026-10-17_2026-10-23.csv',mimeType:'text/csv',content:'"test"\r\n'}]};
const opts={start:'2026-10-17',end:'2026-10-23',sessionToken:'test'};
test('hands both generated CSVs only to the connected office Gmail adapter',async()=>{
 let sent=0;const r=await runWeeklyReports({...opts,fetchImpl:async()=>Response.json(report),sendEmail:async email=>{
 sent++;assert.equal(email.to,'office@chicago-reno.com');assert.equal(email.payload.parts.length,3);
 assert.equal(email.payload.parts[1].body.base64_url_content,Buffer.from('"test"\r\n').toString('base64url'));
 return {id:'m'};
 }});
 assert.equal(sent,1);assert.equal(r.delivery.id,'m');
});
test('never calls Gmail for a failed or incomplete export',async()=>{
 for(const body of [{...report,complete:false},{...report,files:[]}]){
 let sent=0;await assert.rejects(runWeeklyReports({...opts,fetchImpl:async()=>Response.json(body),sendEmail:async()=>sent++}));assert.equal(sent,0);
 }
});
test('does not retry an uncertain Gmail send',async()=>{
 let sent=0;await assert.rejects(runWeeklyReports({...opts,fetchImpl:async()=>Response.json(report),sendEmail:async()=>{sent++;throw Error('response lost');}}));assert.equal(sent,1);
});
test('rejects untrusted API destinations before transmitting the session',async()=>{
 let called=0;await assert.rejects(runWeeklyReports({...opts,base:'https://untrusted.example',fetchImpl:async()=>{called++;return Response.json(report);}}));assert.equal(called,0);
});
