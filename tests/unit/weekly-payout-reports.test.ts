import { describe,expect,it,vi } from 'vitest';
import {generateWeeklyReports,reportCsv,reportDate,validateReportPeriod} from '../../worker/src/services/weekly-payout-reports.js';
const schema={range:{inputFields:[{name:'after'},{name:'before'}]},amounts:{fields:[{name:'total',type:{kind:'SCALAR',name:'Float'}}]}};
const conn=(nodes:unknown[],hasNextPage=false,endCursor:string|null=null)=>({nodes,pageInfo:{hasNextPage,endCursor}});
const expense=(id='e',total:unknown=10)=>({id,total,date:'2026-10-20T12:00:00Z',title:'Receipt',description:'Paid personally',enteredBy:{name:{full:'Ben'}},paidBy:{name:{full:'Ivan'}},reimbursableTo:{name:{full:'Ivan'}},linkedJob:null});
const payment={id:'p',entryDate:'2026-10-20T12:00:00Z',__typename:'ZellePaymentRecord',amount:-50,rawAmount:-50,adjustmentType:'PAYMENT',client:{firstName:'A',lastName:'B'},invoice:{invoiceNumber:'266'}};
function mock(expenses=conn([expense()])) {
 return {graphqlRequest:vi.fn(async(q:string)=>{
  if(q.includes('WeeklyReportSchema'))return schema;
  if(q.includes('WeeklyExpenses'))return {expenses};
  if(q.includes('WeeklyPayments'))return {paymentRecords:conn([payment])};
  if(q.includes('WeeklyInvoices'))return {invoices:conn([{id:'i',issuedDate:'2026-10-21T12:00:00Z',invoiceNumber:'269',amounts:{total:200},client:{firstName:'A'}}])};
  throw new Error('unexpected query');
 })};
}
describe('weekly payout API reports',()=>{
 it('keeps invoices separate from receipts, preserves signs and reimbursement evidence',async()=>{
  const r=await generateWeeklyReports(mock() as never,'2026-10-17','2026-10-23');
  expect(r.complete).toBe(true);expect(r.summary).toEqual({expenseCount:1,expenseTotal:10,paymentCount:1,paymentApiAmount:-50,invoiceCount:1});
  expect(r.expenses[0]['Reimbursable to']).toBe('Ivan');
  expect(r.expenses[0]['Paid by']).toBe('Ivan');
  expect(r.transactions.map(x=>x.Type)).toEqual(['ZellePaymentRecord','Invoice']);
 });
 it('excludes invoice ledger entries from payment counts and totals',async()=>{
  const j=mock();const original=j.graphqlRequest.getMockImplementation()!;
  j.graphqlRequest.mockImplementation(async(q:string)=>q.includes('WeeklyPayments')
   ?{paymentRecords:conn([payment,{...payment,id:'invoice-ledger',adjustmentType:'INVOICE',amount:2060,rawAmount:2060}])}:original(q));
  const r=await generateWeeklyReports(j as never,'2026-10-17','2026-10-23');
  expect(r.summary.paymentCount).toBe(1);expect(r.summary.paymentApiAmount).toBe(-50);
  expect(r.transactions).toHaveLength(2);expect(r.transactions.filter(x=>x.Type==='Invoice')).toHaveLength(1);
 });
 it('keeps equal-valued expenses with different IDs',async()=>{
  const r=await generateWeeklyReports(mock(conn([expense('a'),expense('b')])) as never,'2026-10-17','2026-10-23');
  expect(r.summary.expenseTotal).toBe(20);
 });
 it('rejects missing amounts instead of silently using zero',async()=>{
  await expect(generateWeeklyReports(mock(conn([expense('e',null)])) as never,'2026-10-17','2026-10-23')).rejects.toThrow('missing');
 });
 it('does not accept a malformed or failed source as an empty report',async()=>{
  await expect(generateWeeklyReports(mock({nodes:[]} as never) as never,'2026-10-17','2026-10-23')).rejects.toThrow('Incomplete');
  await expect(generateWeeklyReports({graphqlRequest:vi.fn().mockRejectedValue(new Error('denied'))},'2026-10-17','2026-10-23')).rejects.toThrow('denied');
 });
 it('follows all pages and rejects repeated cursors',async()=>{
  const j=mock();let n=0;
  const original=j.graphqlRequest.getMockImplementation()!;
  j.graphqlRequest.mockImplementation(async(q:string)=>{
   if(q.includes('WeeklyExpenses'))return {expenses:++n===1?conn([expense('a')],true,'a'):conn([expense('b')])};
   return original(q);
  });
  const r=await generateWeeklyReports(j as never,'2026-10-17','2026-10-23');expect(r.summary.expenseCount).toBe(2);
  const looping=mock(conn([],true,'same'));
  await expect(generateWeeklyReports(looping as never,'2026-10-17','2026-10-23')).rejects.toThrow('did not advance');
 });
 it('rejects repeated IDs rather than counting them twice',async()=>{
  await expect(generateWeeklyReports(mock(conn([expense(),expense()])) as never,'2026-10-17','2026-10-23')).rejects.toThrow('Duplicate');
 });
 it('filters broad API results by Chicago dates and handles DST boundaries',async()=>{
  expect(reportDate('2026-10-24T04:59:59Z')).toBe('2026-10-23');
  expect(reportDate('2026-10-24T05:00:00Z')).toBe('2026-10-24');
  expect(reportDate('2026-11-02T05:59:59Z')).toBe('2026-11-01');
  const outside={...expense(),date:'2026-10-24T05:00:00Z'};
  const r=await generateWeeklyReports(mock(conn([outside])) as never,'2026-10-17','2026-10-23');expect(r.summary.expenseCount).toBe(0);
 });
 it('rejects impossible and unbounded periods before querying',()=>{
  for(const pair of [['2026-02-30','2026-03-01'],['2026-10-23','2026-10-17'],['2026-01-01','2026-10-23']])expect(()=>validateReportPeriod(...pair as [string,string])).toThrow();
 });
 it('escapes CSV text formulas, quotes and newlines without changing numeric returns',()=>{
  expect(reportCsv(['name','amount'],[{name:'=CMD("x")\nnext',amount:-5}])).toContain(`"'=CMD(""x"")\nnext","-5"`);
 });
 it('fails explicitly when connected date/amount schema is unavailable',async()=>{
  const j=mock();j.graphqlRequest.mockResolvedValueOnce({range:null,amounts:null} as never);
  await expect(generateWeeklyReports(j as never,'2026-10-17','2026-10-23')).rejects.toThrow('schema');
 });
});
