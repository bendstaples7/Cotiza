import type { JobberReadClient } from './ops-assistant-read.js';
import type { SchemaField, SchemaType } from './jobber-expense-capabilities.js';
const REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
const FIELD = `name args { name type { ${REF} } } type { ${REF} }`;
const TYPES = ['Expense', 'ExpenseFilterAttributes', 'PaymentRecord', 'PaymentRecordInterface', 'PaymentRecordFilterAttributes', 'PaymentRecordConnection', 'Invoice', 'InvoiceFilterAttributes', 'Quote', 'User', 'Name', 'Iso8601DateTimeRangeInput', 'InvoiceAmounts', 'Job', 'Visit', 'JobFilterAttributes'];
const QUERY = `query AssistantReportingCapabilities {
  __schema { queryType { fields { ${FIELD} } } mutationType { fields { ${FIELD} } } }
  ${TYPES.map((name, i) => `t${i}: __type(name: "${name}") {
    name kind fields { ${FIELD} } inputFields { name type { ${REF} } }
    possibleTypes { name fields { ${FIELD} } }
  }`).join('\n')}
}`;
/** Fixed schema-only read. No records, exports, emails, scope changes or credentials. */
export async function inspectReportingCapabilities(jobber: JobberReadClient) {
  const data = await jobber.graphqlRequest<Record<string, unknown>>(QUERY);
  const schema = data.__schema as { queryType?: { fields?: SchemaField[] }; mutationType?: { fields?: SchemaField[] } } | undefined;
  if (!Array.isArray(schema?.queryType?.fields)) throw new Error('Jobber reporting schema unavailable.');
  return {
    queries: schema.queryType.fields.filter(field => /expense|payment|transaction|invoice|report|export/i.test(field.name)),
    mutations: (schema.mutationType?.fields ?? []).filter(field => /report|export/i.test(field.name)),
    types: TYPES.map((_, i) => data[`t${i}`] as SchemaType | null).filter(Boolean),
    reportWritesEnabled: false,
    limitations: ['Schema availability is specific to this connected account and API version.',
      'Exposed fields do not prove a native emailed-report operation is available or working.',
      'No reports generated or emailed. No records changed. No credentials returned.'],
  };
}
