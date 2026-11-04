import type { JobberReadClient } from './ops-assistant-read.js';

/**
 * Jobber Products & Services (the saved line-item catalog) for the ops assistant.
 * Same fields the quote engine already reads in jobber-integration.ts.
 */
export const PRODUCTS_PAGE_SIZE = 50;
/** Hard stop so a runaway cursor can never loop: 40 pages x 50 = 2,000 catalog items. */
export const PRODUCTS_MAX_PAGES = 40;
/** Most matches returned in one find_products answer. */
export const PRODUCTS_MAX_RESULTS = 100;

export const PRODUCTS_QUERY = `query AssistantProducts($first: Int!, $after: String) {
  productOrServices(first: $first, after: $after) {
    edges { node { id name description defaultUnitCost category } }
    pageInfo { hasNextPage endCursor }
  }
}`;

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  defaultUnitCost: number | null;
  category: string | null;
}

interface ProductsPage {
  productOrServices?: {
    edges?: Array<{ node: Record<string, unknown> }>;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  } | null;
}

/** Normalize a name for duplicate checks: case, spacing and dash style do not matter. */
export function catalogKey(name: string): string {
  return name.toLowerCase().replace(/[‒-―]/g, '-').replace(/\s+/g, ' ').trim();
}

/** Read the whole catalog. Throws on a failed page; `complete` is false only if the page cap was hit. */
export async function loadCatalog(jobber: JobberReadClient): Promise<{ items: CatalogItem[]; complete: boolean }> {
  const items: CatalogItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < PRODUCTS_MAX_PAGES; page++) {
    const data: ProductsPage = await jobber.graphqlRequest<ProductsPage>(PRODUCTS_QUERY, { first: PRODUCTS_PAGE_SIZE, after });
    const conn = data.productOrServices;
    for (const edge of conn?.edges ?? []) {
      const n = edge.node;
      items.push({
        id: String(n.id ?? ''),
        name: typeof n.name === 'string' ? n.name : '',
        description: typeof n.description === 'string' ? n.description : '',
        defaultUnitCost: typeof n.defaultUnitCost === 'number' ? n.defaultUnitCost : null,
        category: typeof n.category === 'string' && n.category ? n.category : null,
      });
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) return { items, complete: true };
    after = conn.pageInfo.endCursor;
  }
  return { items, complete: false };
}

/** Filter by a case-insensitive name/description substring; all words must match. */
export function matchCatalog(items: CatalogItem[], query: string | undefined): CatalogItem[] {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((item) => {
    const hay = `${item.name}\n${item.description}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export const PRODUCTS_TOOL = {
  name: 'find_products',
  description: 'Search Jobber Products & Services, the saved line-item catalog the team picks from when building quotes: name, default unit price, description and category. query matches name or description (all words, case-insensitive); omit it to list the catalog. Returns up to 100 matches with totalMatches. Use it to check whether a quote line already exists in the catalog and how its default price compares. Read-only.',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Words to match, e.g. "shower cartridge"' },
    },
  },
} as const;
