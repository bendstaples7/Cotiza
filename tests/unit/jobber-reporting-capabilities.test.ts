import { describe, expect, it, vi } from 'vitest';
import { inspectReportingCapabilities } from '../../worker/src/services/jobber-reporting-capabilities.js';
import { callAssistantTool, OpsAssistantRead } from '../../worker/src/services/ops-assistant-read.js';
describe('reporting capability discovery', () => {
 it('uses one fixed schema query and excludes unrelated operations', async () => {
  const graphqlRequest = vi.fn().mockResolvedValue({__schema: {
   queryType: {fields: [{name:'expenses'},{name:'paymentRecords'},{name:'clients'}]},
   mutationType: {fields: [{name:'reportExport'},{name:'expenseDelete'}]}
  }, t0:{name:'Expense',fields:[]}});
  const r=await inspectReportingCapabilities({graphqlRequest});
  expect(graphqlRequest).toHaveBeenCalledTimes(1);
  expect(graphqlRequest.mock.calls[0][0]).toMatch(/^query /);
  expect(r.queries.map(x=>x.name)).toEqual(['expenses','paymentRecords']);
  expect(r.mutations.map(x=>x.name)).toEqual(['reportExport']);
  expect(r.reportWritesEnabled).toBe(false);
 });
 it('does not turn missing or denied schema into empty results',async()=>{
  await expect(inspectReportingCapabilities({graphqlRequest:vi.fn().mockResolvedValue({})})).rejects.toThrow('unavailable');
  const read=new OpsAssistantRead({graphqlRequest:vi.fn().mockRejectedValue(new Error('denied'))},{} as never);
  expect((await callAssistantTool(read,'u','inspect_reporting_capabilities',{}))?.outcome).toBe('failed');
 });
 it('rejects caller queries before using Jobber',async()=>{
  const graphqlRequest=vi.fn();const read=new OpsAssistantRead({graphqlRequest},{} as never);
  await expect(callAssistantTool(read,'u','inspect_reporting_capabilities',{query:'mutation { x }'})).rejects.toThrow();
  expect(graphqlRequest).not.toHaveBeenCalled();
 });
});
