import type { JobberReadClient } from './ops-assistant-read.js';
type Row = Record<string, unknown>;
type Connection = { nodes?: Row[]; edges?: {node:Row}[]; pageInfo?: {hasNextPage:boolean;endCursor:string|null} };
const ZONE='America/Chicago';
const REF='kind name ofType { kind name ofType { kind name } }';
const PREFLIGHT=`query WeeklyReportSchema {
 range: __type(name:"Iso8601DateTimeRangeInput") { inputFields { name } }
 amounts: __type(name:"InvoiceAmounts") { fields { name type { ${REF} } } }
}`;
const PERSON='id name { full }';
const CLIENT='id firstName lastName companyName';
export function validateReportPeriod(start: string,end: string) {
 const valid=(x:string)=>/^\d{4}-\d{2}-\d{2}$/.test(x)&&!isNaN(Date.parse(x))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
 if(!valid(start)||!valid(end)) throw new Error('Use valid YYYY-MM-DD reporting dates.');
 const days=(Date.parse(end)-Date.parse(start))/86400000;
 if(days<0||days>30) throw new Error('Reporting period must be 1 to 31 days.');
 return {start,end,timeZone:ZONE};
}
export function reportDate(value: unknown): string {
 if(typeof value!=='string'||!Number.isFinite(Date.parse(value))) throw new Error('Report record has an invalid date.');
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
 const p=(key:string)=>parts.find(x=>x.type===key)?.value;
 return `${p('year')}-${p('month')}-${p('day')}`;
}
export function reportCsv(headers:string[],rows:Row[]):string {
 const cell=(v:unknown)=>{
  let s=v==null?'':String(v);
  // Keep CSV consumers from executing user-entered formulas.
  if(typeof v!=='number'&&/^[\s]*[=+@-]/.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
 };
 return headers.map(cell).join(',')+'\r\n'+rows.map(r=>headers.map(h=>cell(r[h])).join(',')).join('\r\n')+'\r\n';
}
function name(v:unknown):string {
 const p=v as {name?:{full?:string};companyName?:string;firstName?:string;lastName?:string}|null;
 return p?.name?.full||p?.companyName||[p?.firstName,p?.lastName].filter(Boolean).join(' ');
}
function cents(v:unknown):number {
 if(typeof v!=='number'||!Number.isFinite(v))throw new Error('Report amount is missing; it cannot be treated as zero.');
 return Math.round(v*100);
}
async function pages(jobber:JobberReadClient,query:string,key:string,filter:Row):Promise<Row[]> {
 const all:Row[]=[];const ids=new Set<string>();const cursors=new Set<string>();let after:string|null=null;
 for(let page=0;page<50;page++){
  const data:Record<string,Connection>=await jobber.graphqlRequest<Record<string,Connection>>(query,{first:50,after,filter});
  const c:Connection|undefined=data[key];const nodes:Row[]|undefined=c?.nodes??c?.edges?.map(e=>e.node);
  if(!c||!Array.isArray(nodes)||typeof c.pageInfo?.hasNextPage!=='boolean')throw new Error('Incomplete report response; no report can be sent.');
  for(const node of nodes){
   if(typeof node.id!=='string'||ids.has(node.id))throw new Error('Duplicate or missing source ID; retry the entire report.');
   ids.add(node.id);all.push(node);
  }
  if(!c.pageInfo.hasNextPage)return all;
  const next:string|null=c.pageInfo.endCursor;
  if(!next||cursors.has(next))throw new Error('Report pagination did not advance.');
  cursors.add(next);after=next;
 }
 throw new Error('Report exceeded its page limit; no partial report can be sent.');
}
export async function generateWeeklyReports(jobber:JobberReadClient,start:string,end:string){
 const period=validateReportPeriod(start,end);
 const schema=await jobber.graphqlRequest<{range:{inputFields:{name:string}[]}|null;amounts:{fields:{name:string;type:{kind:string;name:string|null;ofType?:{kind:string;name:string|null}}}[]}|null}>(PREFLIGHT);
 const fields=schema.range?.inputFields.map(x=>x.name)??[];
 const lower=['after','gte','greaterThanOrEqualTo'].find(x=>fields.includes(x));
 const upper=['before','lte','lessThanOrEqualTo'].find(x=>fields.includes(x));
 const total=schema.amounts?.fields.find(f=>['total','grandTotal'].includes(f.name));
 if(!lower||!upper||!total)throw new Error('Connected Jobber schema does not support the required date/amount contract.');
 const broadStart=new Date(Date.parse(start+'T00:00:00Z')-86400000).toISOString();
 const broadEnd=new Date(Date.parse(end+'T00:00:00Z')+2*86400000).toISOString();
 const range={[lower]:broadStart,[upper]:broadEnd};
 const selected=(v:unknown)=>{const d=reportDate(v);return d>=start&&d<=end;};
 const expenses=await pages(jobber,`query WeeklyExpenses($first:Int!,$after:String,$filter:ExpenseFilterAttributes) {
 expenses(first:$first,after:$after,filter:$filter){nodes {
 id date title description total enteredBy { ${PERSON} } paidBy { ${PERSON} } reimbursableTo { ${PERSON} }
 linkedJob { jobNumber title client { ${CLIENT} } }
 } pageInfo {hasNextPage endCursor}}}`,'expenses',{date:range});
 const payments=await pages(jobber,`query WeeklyPayments($first:Int!,$after:String,$filter:PaymentRecordFilterAttributes) {
 paymentRecords(first:$first,after:$after,filter:$filter){nodes {
 __typename id entryDate adjustmentType paymentType paymentOrigin amount rawAmount details
 client { ${CLIENT} } invoice {invoiceNumber} quote {quoteNumber}
 ... on ZellePaymentRecord {confirmationNumber}
 ... on OtherPaymentRecord {confirmationNumber}
 ... on CheckPaymentRecord {checkNumber}
 ... on JobberPaymentsACHPaymentRecord {transactionStatus transactionId feeAmount}
 ... on JobberPaymentsCreditCardPaymentRecord {transactionStatus transactionId feeAmount}
 ... on JobberPaymentsRefundPaymentRecord {transactionStatus transactionId feeAmount}
 } pageInfo {hasNextPage endCursor}}}`,'paymentRecords',{entryDate:range});
 const invoices=await pages(jobber,`query WeeklyInvoices($first:Int!,$after:String,$filter:InvoiceFilterAttributes) {
 invoices(first:$first,after:$after,filter:$filter){nodes {
 id issuedDate invoiceNumber invoiceStatus subject amounts { ${total.name} } client { ${CLIENT} }
 } pageInfo {hasNextPage endCursor}}}`,'invoices',{issuedDate:range});
 const expenseRows=expenses.filter(r=>selected(r.date)).map(r=>{
  const job=r.linkedJob as {jobNumber?:number;title?:string;client?:unknown}|null;
  return {'Source ID':r.id,'Date':reportDate(r.date),'Source date':r.date,'Item name':r.title,'Details':r.description??'','Total $':cents(r.total)/100,
   'Entered by':name(r.enteredBy),'Paid by':name(r.paidBy),'Reimbursable to':name(r.reimbursableTo),'Job #':job?.jobNumber??'',
   'Client name':name(job?.client),'Job description':job?.title??''};
 });
 const paymentRows=payments.filter(r=>selected(r.entryDate)).map(r=>{
  const inv=r.invoice as {invoiceNumber?:string}|null;const quote=r.quote as {quoteNumber?:string}|null;
  return {'Source ID':r.id,'Client name':name(r.client),'Date':reportDate(r.entryDate),'Source date':r.entryDate,'Type':r.__typename,
   'Adjustment type':r.adjustmentType,'API Amount $':cents(r.amount)/100,'Raw amount $':cents(r.rawAmount)/100,
   'Details':r.details??'','Invoice #':inv?.invoiceNumber??'','Quote #':quote?.quoteNumber??'','Payment method':r.paymentType??'',
   'Confirmation #':r.confirmationNumber??'','Check #':r.checkNumber??'','Transaction ID':r.transactionId??'',
   'Processor status':r.transactionStatus??'','Processor fee $':r.feeAmount??''};
 });
 const invoiceRows=invoices.filter(r=>r.issuedDate&&selected(r.issuedDate)).map(r=>({
  'Source ID':r.id,'Client name':name(r.client),'Date':reportDate(r.issuedDate),'Source date':r.issuedDate,'Type':'Invoice','Adjustment type':'',
  'API Amount $':cents((r.amounts as Row)?.[total.name])/100,'Raw amount $':'','Details':r.subject??'','Invoice #':r.invoiceNumber,
  'Quote #':'','Payment method':'','Confirmation #':'','Check #':'','Transaction ID':'','Processor status':r.invoiceStatus,'Processor fee $':'',
 }));
 const expenseHeaders=['Source ID','Date','Source date','Item name','Details','Total $','Entered by','Paid by','Reimbursable to','Job #','Client name','Job description'];
 const txHeaders=['Source ID','Client name','Date','Source date','Type','Adjustment type','API Amount $','Raw amount $','Details','Invoice #','Quote #','Payment method','Confirmation #','Check #','Transaction ID','Processor status','Processor fee $'];
 const txRows=[...paymentRows,...invoiceRows].sort((a,b)=>String(a.Date).localeCompare(String(b.Date)));
 return {period,complete:true,source:'jobber-public-api',generatedAt:new Date().toISOString(),
  summary:{expenseCount:expenseRows.length,expenseTotal:expenseRows.reduce((s,r)=>s+cents(r['Total $']),0)/100,
   paymentCount:paymentRows.length,paymentApiAmount:paymentRows.reduce((s,r)=>s+cents(r['API Amount $']),0)/100,invoiceCount:invoiceRows.length},
  expenses:expenseRows,transactions:txRows,
  files:[{filename:`Expense_Report_${start}_${end}.csv`,mimeType:'text/csv',content:reportCsv(expenseHeaders,expenseRows)},
   {filename:`Transaction_List_${start}_${end}.csv`,mimeType:'text/csv',content:reportCsv(txHeaders,txRows)}],
  limitations:['Cotiza API reports, not native Jobber exports. One payment row per source payment record; invoice allocations are not separate receipts.',
   'Payment amounts retain API signs. Invoice rows are not cash receipts. Processor payments may not be settled bank cash.',
   'Paid by and Entered by do not independently prove a personal-card reimbursement. Review Reimbursable to and receipt details.',
   'Expense categories are not supplied by this API. Unknown amounts cause failure. Refund records retain their original type and sign.']};
}
