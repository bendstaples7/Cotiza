import { Hono } from 'hono';
import type { User } from 'shared';
import type { Bindings } from '../bindings.js';
import { sessionMiddleware } from '../middleware/session.js';
import { openJobberIntegration } from '../services/jobber-integration.js';
import { generateWeeklyReports, validateReportPeriod } from '../services/weekly-payout-reports.js';
const app=new Hono<{Bindings:Bindings;Variables:{user:User}}>();
app.use('*',sessionMiddleware);
app.use('*',async(c,next)=>{
 if(c.get('user').email.toLowerCase()!=='office@chicago-reno.com')return c.json({error:'Only the Chicago Reno office account can generate payout reports.'},403);
 await next();
});
app.post('/weekly',async c=>{
 const body=await c.req.json().catch(()=>null) as {start?:unknown;end?:unknown}|null;
 if(!body||Object.keys(body).some(k=>!['start','end'].includes(k))||typeof body.start!=='string'||typeof body.end!=='string')
  return c.json({error:'Supply only start and end as YYYY-MM-DD dates.'},400);
 try{validateReportPeriod(body.start,body.end);}catch{return c.json({error:'Use a valid reporting period of at most 31 days.'},400);}
 c.header('Cache-Control','no-store');
 try{
  const {jobberIntegration}=await openJobberIntegration(c.env.DB,c.env);
  return c.json(await generateWeeklyReports(jobberIntegration,body.start,body.end));
 }catch{
  return c.json({complete:false,error:'Jobber report generation failed. No complete report is available and no email was sent.'},502);
 }
});
export default app;
