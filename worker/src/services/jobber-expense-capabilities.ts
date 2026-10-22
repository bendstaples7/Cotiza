import type { JobberReadClient } from './ops-assistant-read.js';

export type TypeRef = { kind: string; name: string | null; ofType?: TypeRef | null };
export type SchemaField = { name: string; type: TypeRef; args?: Array<{ name: string; type: TypeRef }> };
export type SchemaType = { name: string; kind: string; inputFields?: SchemaField[] | null; fields?: SchemaField[] | null };
const REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
const ROOT_QUERY = `query AssistantExpenseCapabilities {
  __schema {
    queryType { fields { name args { name type { ${REF} } } type { ${REF} } } }
    mutationType { fields { name args { name type { ${REF} } } type { ${REF} } } }
  }
}`;
const TYPE_QUERY = `query AssistantExpenseCapabilityType($name: String!) {
  __type(name: $name) {
    name kind
    inputFields { name type { ${REF} } }
    fields { name type { ${REF} } }
  }
}`;
function named(ref: TypeRef): string | null {
  return ref.name || (ref.ofType ? named(ref.ofType) : null);
}
function publicRef(ref: TypeRef): TypeRef {
  return { kind: ref.kind, name: ref.name, ...(ref.ofType ? { ofType: publicRef(ref.ofType) } : {}) };
}
function publicField(field: SchemaField): SchemaField {
  return { name: field.name, type: publicRef(field.type), ...(field.args ? {
    args: field.args.map(arg => ({ name: arg.name, type: publicRef(arg.type) })),
  } : {}) };
}
/** Fixed, bounded introspection only. No caller-supplied GraphQL, tokens, records or URLs. */
export async function inspectExpenseCapabilities(jobber: JobberReadClient) {
  const root = await jobber.graphqlRequest<{ __schema: {
    queryType: { fields: SchemaField[] }; mutationType: { fields: SchemaField[] } | null;
  } }>(ROOT_QUERY);
  if (!root?.__schema?.queryType?.fields) throw new Error('Jobber schema introspection unavailable.');
  const queries = root.__schema.queryType.fields.filter(field => /expense/i.test(field.name)).map(publicField);
  const mutations = (root.__schema.mutationType?.fields ?? []).filter(field => /expense/i.test(field.name)).map(publicField);
  // Prioritize creation and receipt contracts; query pagination/scalar types must
  // not exhaust the budget before the write input can be inspected.
  const pending = ['ExpenseCreateInput', 'ExpenseCreatePayload', 'Expense',
    ...mutations.flatMap(field => (field.args ?? []).map(arg => named(arg.type))),
  ].filter((name): name is string => Boolean(name));
  const visited = new Set<string>();
  const types: SchemaType[] = [];
  // Inspect expense inputs/payloads and their nested inputs, with a strict upstream call cap.
  while (pending.length && visited.size < 12) {
    const name = pending.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const data = await jobber.graphqlRequest<{ __type: SchemaType | null }>(TYPE_QUERY, { name });
    if (!data?.__type) continue;
    const type = data.__type;
    const fields = type.fields?.map(publicField);
    const inputFields = type.inputFields?.map(publicField);
    types.push({ name: type.name, kind: type.kind, ...(fields ? { fields } : {}), ...(inputFields ? { inputFields } : {}) });
    for (const field of [...(inputFields ?? []), ...(fields ?? []).filter(field => /expense|receipt|attachment|file/i.test(field.name))]) {
      const child = named(field.type);
      if (child && !visited.has(child) && child !== name && !['String', 'Int', 'Float', 'Boolean', 'EncodedId', 'ISO8601DateTime'].includes(child)) pending.unshift(child);
    }
  }
  return {
    queries, mutations, types,
    discoveryComplete: pending.every(name => visited.has(name)),
    expenseWritesExposed: mutations.length > 0,
    assistantWritesEnabled: false,
    limitations: [
      'Schema visibility depends on the connected app permissions and API version. Absence does not prove Jobber has no such API.',
      'An exposed mutation is not proof that creation or receipt upload works. Validate its exact input and response contract before enabling writes.',
      'No records were created or changed. No receipt was uploaded. Existing ops:read tokens remain read-only.',
    ],
  };
}
