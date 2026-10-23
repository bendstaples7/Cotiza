import {Hono} from 'hono';
import {describe,it,expect,vi} from 'vitest';
vi.mock('../../worker/src/services/auth-service.js',()=>({AuthService:class{
 async verifySession(token:string){return token==='office'?{id:'u',email:'office@chicago-reno.com'}:token==='other'?{id:'v',email:'other@chicago-reno.com'}:null;}
}}));
const calls=vi.hoisted(()=>({open:vi.fn(),generate:vi.fn()}));
vi.mock('../../worker/src/services/jobber-integration.js',()=>({openJobberIntegration:calls.open}));
vi.mock('../../worker/src/services/weekly-payout-reports.js',async()=>{
 const actual=await vi.importActual('../../worker/src/services/weekly-payout-reports.js');
 return {...actual,generateWeeklyReports:calls.generate};
});
import routes from '../../worker/src/routes/reports.js';
function app(){const a=new Hono();a.route('/api/reports',routes);a.onError((e,c)=>c.json({error:'denied'},(e as {statusCode?:number}).statusCode===401?401:500));return a;}
const request=(token:string,body:unknown)=>new Request('http://local/api/reports/weekly',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
describe('weekly reporting access',()=>{
 it('rejects absent and invalid sessions before Jobber',async()=>{
  calls.open.mockClear();for(const token of ['','invalid'])expect((await app().fetch(request(token,{}),{})).status).toBe(401);
  expect(calls.open).not.toHaveBeenCalled();
 });
 it('restricts financial reports to the office account',async()=>{
  expect((await app().fetch(request('other',{}),{})).status).toBe(403);
 });
 it('rejects extra fields and impossible periods',async()=>{
  expect((await app().fetch(request('office',{start:'2026-10-17',end:'2026-10-23',query:'x'}),{})).status).toBe(400);
  expect((await app().fetch(request('office',{start:'2026-02-30',end:'2026-03-01'}),{})).status).toBe(400);
 });
 it('returns no partial report when Jobber fails',async()=>{
  calls.open.mockResolvedValue({jobberIntegration:{}});calls.generate.mockRejectedValue(new Error('secret upstream detail'));
  const r=await app().fetch(request('office',{start:'2026-10-17',end:'2026-10-23'}),{});
  expect(r.status).toBe(502);expect(await r.text()).not.toContain('secret upstream detail');
 });
});
