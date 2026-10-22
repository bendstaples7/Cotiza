import type { JobberReadClient } from './ops-assistant-read.js';

const FIELDS = 'id title description date total';
export async function findExpenses(jobber: JobberReadClient, search: string, cursor?: string) {
  if (typeof search !== 'string' || search.length < 1 || search.length > 100) throw new Error('Provide a search string of 1–100 characters.');
  if (cursor !== undefined && !/^[A-Za-z0-9+/=_-]{1,512}$/.test(cursor)) throw new Error('Invalid cursor.');
  const data = await jobber.graphqlRequest<{ expenses: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null }>(`query AssistantFindExpenses($search: String!, $after: String) { expenses(first: 20, searchTerm: $search, after: $after) { nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } } }`, { search, after: cursor ?? null });
  if (!data.expenses) throw new Error('Expense lookup unavailable. This is not an empty result.');
  return { outcome: 'ok', items: data.expenses.nodes, page: data.expenses.pageInfo };
}
type Ref = { name: string | null; kind: string; ofType?: Ref | null };
function named(ref: Ref): string | null { return ref.name || (ref.ofType ? named(ref.ofType) : null); }
const REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
/** Discover only the category/job/user lookup schema; never guess a field or accept caller GraphQL. */
export async function expenseOptions(jobber: JobberReadClient, kind: 'categories' | 'jobs' | 'users', cursor?: string) {
  if (!['categories', 'jobs', 'users'].includes(kind)) throw new Error('Invalid expense option kind.');
  if (cursor !== undefined && !/^[A-Za-z0-9+/=_-]{1,512}$/.test(cursor)) throw new Error('Invalid cursor.');
  const schema = await jobber.graphqlRequest<{ __schema: { queryType: { fields: Array<{ name: string; type: Ref; args: Array<{ name: string; type: Ref }> }> } } }>(`query AssistantExpenseOptionSchema { __schema { queryType { fields { name type { ${REF} } args { name type { ${REF} } } } } } }`);
  const candidates = kind === 'categories' ? ['expenseAccountingCodes', 'accountingCodes'] : [kind];
  const root = schema.__schema.queryType.fields.find(field => candidates.includes(field.name));
  if (!root) return { outcome: 'unavailable', message: 'This lookup is not exposed by the connected Jobber API. Use an existing verified Jobber ID; do not invent one.' };
  if (root.args.some(arg => arg.type.kind === 'NON_NULL' && !['first'].includes(arg.name))) return { outcome: 'unavailable', message: 'This lookup requires unsupported filters.' };
  const type = async (name: string) => (await jobber.graphqlRequest<{ __type: { fields: Array<{ name: string; type: Ref }> } | null }>(`query AssistantExpenseOptionType($name: String!) { __type(name: $name) { fields { name type { ${REF} } } } }`, { name })).__type;
  const rootType = await type(named(root.type)!);
  const nodeField = rootType?.fields.find(field => field.name === 'nodes');
  const list = root.type.kind === 'LIST' || root.type.ofType?.kind === 'LIST';
  const itemType = await type(nodeField ? named(nodeField.type)! : named(root.type)!);
  if (!nodeField && !list) return { outcome: 'unavailable', message: 'Unsupported lookup connection shape.' };
  if (!itemType?.fields.some(field => field.name === 'id')) return { outcome: 'unavailable', message: 'Lookup has no exposed IDs.' };
  const fields = ['id'];
  for (const field of itemType.fields) {
    if (!['name', 'title', 'code', 'jobNumber', 'email'].includes(field.name)) continue;
    const ref = field.type.kind === 'NON_NULL' ? field.type.ofType! : field.type;
    if (ref.kind === 'SCALAR') fields.push(field.name);
    else if (field.name === 'name' && ref.kind === 'OBJECT') {
      const names = await type(named(ref)!);
      const scalarNames = names?.fields.filter(f => ['full', 'first', 'last', 'firstName', 'lastName'].includes(f.name) && (f.type.kind === 'SCALAR' || f.type.ofType?.kind === 'SCALAR')).map(f => f.name) ?? [];
      if (scalarNames.length) fields.push(`name { ${scalarNames.join(' ')} }`);
    }
  }
  const args: string[] = []; const variables: Record<string, unknown> = {}; const declarations: string[] = [];
  if (root.args.some(arg => arg.name === 'first')) { args.push('first: 20'); }
  if (cursor && root.args.some(arg => arg.name === 'after')) { args.push('after: $after'); declarations.push('$after: String'); variables.after = cursor; }
  const paging = nodeField && rootType?.fields.some(field => field.name === 'pageInfo') ? 'pageInfo { hasNextPage endCursor }' : '';
  const selection = nodeField ? `nodes { ${fields.join(' ')} } ${paging}` : fields.join(' ');
  const data = await jobber.graphqlRequest<Record<string, { nodes?: unknown[]; pageInfo?: unknown } | unknown[]>>(`query AssistantExpenseOptions${declarations.length ? `(${declarations.join(',')})` : ''} { ${root.name}${args.length ? `(${args.join(',')})` : ''} { ${selection} } }`, variables);
  const result = data[root.name];
  if (!result) throw new Error('Expense options failed to load.');
  return { outcome: 'ok', kind, items: Array.isArray(result) ? result : result.nodes ?? [], page: Array.isArray(result) ? null : result.pageInfo ?? null };
}
