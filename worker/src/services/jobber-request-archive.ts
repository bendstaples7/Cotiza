/**
 * Archives (and unarchives) a Jobber request when the team closes (or reopens) a lead in Cotiza.
 *
 * The mutation comes from Jobber's live schema: requestArchive / requestUnarchive, taking the
 * request id and nothing else required. When Jobber offers no such mutation, nothing is sent and the
 * caller tells the team to archive the request in Jobber themselves ("not_offered").
 */
import type { JobberReadClient } from './ops-assistant-read.js';
import { sanitizeLogText } from './jobber-log-sanitize.mjs';

interface TypeRef { kind: string; name: string | null; ofType?: TypeRef | null }
interface Field { name: string; type: TypeRef }
interface MutationField { name: string; args: Field[]; type: TypeRef }

const REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
export const ARCHIVE_MUTATIONS_QUERY = `query CotizaArchiveMutations {
  __schema { mutationType { fields { name args { name type { ${REF} } } type { ${REF} } } } }
}`;
export const ARCHIVE_PAYLOAD_QUERY = `query CotizaArchivePayload($payload: String!) {
  payload: __type(name: $payload) { fields { name type { ${REF} } } }
}`;

function baseOf(ref: TypeRef): TypeRef {
  let r = ref;
  while (r.ofType) r = r.ofType;
  return r;
}
function render(ref: TypeRef): string {
  if (ref.kind === 'NON_NULL') return `${render(ref.ofType!)}!`;
  if (ref.kind === 'LIST') return `[${render(ref.ofType!)}]`;
  return String(ref.name);
}

export interface ArchiveShape { mutation: string; idArg: string; idType: string; hasUserErrors: boolean }

/** The archive (or unarchive) mutation, if Jobber offers one Cotiza can call with just the request id. Pure. */
export function archiveShape(fields: MutationField[], payloadFields: Field[] | null, which: 'archive' | 'unarchive'): ArchiveShape | null {
  const names = which === 'archive' ? ['requestArchive', 'archiveRequest'] : ['requestUnarchive', 'unarchiveRequest'];
  const field = fields.find((f) => names.includes(f.name));
  if (!field) return null;
  const idArg = field.args.find((a) => a.name === 'requestId' || a.name === 'id');
  if (!idArg) return null;
  if (field.args.some((a) => a !== idArg && a.type.kind === 'NON_NULL')) return null;
  return { mutation: field.name, idArg: idArg.name, idType: render(idArg.type), hasUserErrors: (payloadFields ?? []).some((f) => f.name === 'userErrors') };
}

export type ArchiveResult =
  | { status: 'archived' | 'unarchived' }
  | { status: 'not_offered'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'skipped'; message: string };

const shapeCache = new Map<string, { shape: ArchiveShape | null; at: number }>();
const SHAPE_TTL_MS = 60 * 60_000;

/** For tests. */
export function resetArchiveShapeCache() { shapeCache.clear(); }

async function loadShape(jobber: JobberReadClient, which: 'archive' | 'unarchive'): Promise<ArchiveShape | null> {
  const cached = shapeCache.get(which);
  if (cached && Date.now() - cached.at < SHAPE_TTL_MS) return cached.shape;
  const shape = await introspectShape(jobber, which);
  shapeCache.set(which, { shape, at: Date.now() });
  return shape;
}

async function introspectShape(jobber: JobberReadClient, which: 'archive' | 'unarchive'): Promise<ArchiveShape | null> {
  const data = await jobber.graphqlRequest<{ __schema?: { mutationType?: { fields?: MutationField[] } } }>(ARCHIVE_MUTATIONS_QUERY);
  const fields = data.__schema?.mutationType?.fields ?? [];
  const candidate = archiveShape(fields, [], which);
  if (!candidate) return null;
  const field = fields.find((f) => f.name === candidate.mutation)!;
  const payloadName = baseOf(field.type).name;
  const payload = payloadName
    ? await jobber.graphqlRequest<{ payload?: { fields?: Field[] } | null }>(ARCHIVE_PAYLOAD_QUERY, { payload: payloadName })
    : null;
  return archiveShape(fields, payload?.payload?.fields ?? [], which);
}

/** Archives or unarchives the request. Never throws: the outcome says what happened. */
export async function setRequestArchived(jobber: JobberReadClient | null, requestId: string, archived: boolean): Promise<ArchiveResult> {
  const which = archived ? 'archive' : 'unarchive';
  if (!jobber) return { status: 'failed', message: 'Jobber is not connected.' };
  try {
    const shape = await loadShape(jobber, which);
    if (!shape) {
      return { status: 'not_offered', message: archived ? 'Jobber does not let Cotiza archive requests. Archive this request in Jobber.' : 'Jobber does not let Cotiza unarchive requests. Unarchive this request in Jobber.' };
    }
    const selection = shape.hasUserErrors ? 'userErrors { message }' : '__typename';
    const data = await jobber.graphqlRequest<Record<string, { userErrors?: Array<{ message?: string }> } | null>>(
      `mutation CotizaArchive($id: ${shape.idType}) { ${shape.mutation}(${shape.idArg}: $id) { ${selection} } }`, { id: requestId },
    );
    const errors = data[shape.mutation]?.userErrors ?? [];
    if (errors.length) return { status: 'failed', message: errors.map((e) => e.message).filter(Boolean).join('; ') || 'Jobber refused.' };
    if (!data[shape.mutation]) return { status: 'failed', message: 'Jobber returned no result.' };
    return { status: archived ? 'archived' : 'unarchived' };
  } catch (err) {
    return { status: 'failed', message: sanitizeLogText(err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}
