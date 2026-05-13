import { EmbeddingService } from './embedding-service.js';
import { ActivityLogService } from './activity-log-service.js';
import { JobberIntegration } from './jobber-integration.js';
import { QuantityEngine } from './quantity-engine.js';

const EMBEDDING_BATCH_SIZE = 20;

export interface SyncResult {
  totalFetched: number;
  newQuotes: number;
  updatedQuotes: number;
  unchangedQuotes: number;
  embeddingsGenerated: number;
  durationMs: number;
  error?: string;
}

interface JobberQuoteNode {
  id: string;
  quoteNumber: string;
  title: string | null;
  message: string | null;
  quoteStatus: string;
  lineItems?: { nodes: Array<{ name: string; quantity: number }> };
}

interface CorpusRecord {
  jobber_quote_id: string;
  title: string | null;
  message: string | null;
  quote_status: string;
  has_embedding: boolean;
}

const QUOTES_QUERY = `
  query FetchQuotesForCorpus($first: Int!, $after: String) {
    quotes(first: $first, after: $after) {
      edges {
        node {
          id
          quoteNumber
          title
          message
          quoteStatus
          lineItems {
            nodes {
              name
              quantity
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export class QuoteSyncService {
  private readonly db: D1Database;
  private readonly embeddingService: EmbeddingService;
  private readonly activityLog: ActivityLogService;
  private readonly jobberIntegration: JobberIntegration;
  private readonly quantityEngine?: QuantityEngine;

  constructor(
    db: D1Database,
    embeddingService: EmbeddingService,
    activityLog: ActivityLogService,
    jobberIntegration: JobberIntegration,
    quantityEngine?: QuantityEngine,
  ) {
    this.db = db;
    this.embeddingService = embeddingService;
    this.activityLog = activityLog;
    this.jobberIntegration = jobberIntegration;
    this.quantityEngine = quantityEngine;
  }

  /**
   * Synchronize the quote corpus with Jobber.
   * Fetches all approved/converted quotes, upserts into corpus,
   * and generates embeddings for new/changed text.
   */
  async sync(): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      totalFetched: 0,
      newQuotes: 0,
      updatedQuotes: 0,
      unchangedQuotes: 0,
      embeddingsGenerated: 0,
      durationMs: 0,
    };

    try {
      if (!this.jobberIntegration.isAvailable()) {
        throw new Error('Jobber API is not available. Check credentials and connectivity.');
      }

      // Fetch all approved/converted quotes from Jobber
      const quotes = await this.fetchAllQuotes();
      result.totalFetched = quotes.length;

      // Load existing corpus records for comparison
      const existingMap = await this.loadExistingCorpus();

      const newQuotes: JobberQuoteNode[] = [];
      const changedQuotes: Array<{ node: JobberQuoteNode; textChanged: boolean }> = [];
      const needsEmbedding: Array<{ quoteId: string; searchableText: string }> = [];

      for (const q of quotes) {
        const existing = existingMap.get(q.id);
        if (!existing) {
          newQuotes.push(q);
        } else if (
          existing.title !== q.title ||
          existing.message !== q.message ||
          existing.quote_status !== q.quoteStatus
        ) {
          const textChanged = existing.title !== q.title || existing.message !== q.message;
          changedQuotes.push({ node: q, textChanged });
        } else {
          // Re-enqueue unchanged quotes that are missing embeddings (e.g., from a previous failed batch)
          if (!existing.has_embedding) {
            const searchableText = buildSearchableText(q.title, q.message);
            needsEmbedding.push({ quoteId: q.id, searchableText });
          }
          result.unchangedQuotes++;
        }
      }

      result.newQuotes = newQuotes.length;
      result.updatedQuotes = changedQuotes.length;

      // Upsert new quotes
      for (const q of newQuotes) {
        const searchableText = buildSearchableText(q.title, q.message);
        await this.upsertQuote(q, searchableText);
        needsEmbedding.push({ quoteId: q.id, searchableText });
      }

      // Upsert changed quotes
      for (const { node: q, textChanged } of changedQuotes) {
        const searchableText = buildSearchableText(q.title, q.message);
        await this.upsertQuote(q, searchableText);
        if (textChanged) {
          needsEmbedding.push({ quoteId: q.id, searchableText });
        }
      }

      // Generate embeddings in batches
      result.embeddingsGenerated = await this.generateEmbeddings(needsEmbedding);

      // Extract quantity data from new/changed quotes for the Quantity Engine
      if (this.quantityEngine) {
        // Determine if we need a full backfill (quantity_history is empty)
        // This handles the case where quotes were synced before the quantity_history table existed
        const needsBackfill = await this.isQuantityHistoryEmpty();

        const quotesForExtraction = needsBackfill
          ? quotes.map(q => ({
              jobberQuoteId: q.id,
              quoteNumber: q.quoteNumber,
              message: q.message,
              lineItems: q.lineItems?.nodes,
            }))
          : [...newQuotes, ...changedQuotes.map(c => c.node)]
              .map(q => ({
                jobberQuoteId: q.id,
                quoteNumber: q.quoteNumber,
                message: q.message,
                lineItems: q.lineItems?.nodes,
              }));

        if (quotesForExtraction.length > 0) {
          const extractionResult = await this.quantityEngine.extractAndStore(quotesForExtraction);
          await this.activityLog.log({
            userId: 'system',
            component: 'QuoteSyncService',
            operation: 'quantityExtraction',
            severity: 'info',
            description: `Quantity extraction${needsBackfill ? ' (backfill)' : ''}: ${extractionResult.extracted} records extracted, ${extractionResult.skipped} quotes skipped from ${quotesForExtraction.length} quotes.`,
          });
        }
      }

      const durationMs = Date.now() - startTime;
      result.durationMs = durationMs;
      await this.updateSyncStatus(result.totalFetched, durationMs, null);

      await this.activityLog.log({
        userId: 'system',
        component: 'QuoteSyncService',
        operation: 'sync',
        severity: 'info',
        description: `Corpus sync completed: ${result.totalFetched} fetched, ${result.newQuotes} new, ${result.updatedQuotes} updated, ${result.embeddingsGenerated} embeddings generated in ${durationMs}ms.`,
      });

      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      result.durationMs = durationMs;
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      result.error = errorMessage;

      await this.activityLog.log({
        userId: 'system',
        component: 'QuoteSyncService',
        operation: 'sync',
        severity: 'error',
        description: `Corpus sync failed: ${errorMessage}`,
        recommendedAction: 'Check Jobber API credentials and connectivity.',
      });

      await this.updateSyncStatus(null, durationMs, errorMessage);
      return result;
    }
  }

  /**
   * Get the current corpus status.
   */
  async getStatus(): Promise<{ totalQuotes: number; lastSyncAt: string | null }> {
    try {
      const row = await this.db.prepare(
        'SELECT total_quotes, last_sync_at FROM quote_corpus_sync_status WHERE id = 1'
      ).first() as { total_quotes: number; last_sync_at: string | null } | null;

      if (!row) {
        return { totalQuotes: 0, lastSyncAt: null };
      }

      return {
        totalQuotes: Number(row.total_quotes),
        lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
      };
    } catch {
      return { totalQuotes: 0, lastSyncAt: null };
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  /**
   * Fetch all approved/converted quotes from Jobber via the integration's
   * paginated GraphQL helper. Filters to approved/converted status.
   */
  private async fetchAllQuotes(): Promise<JobberQuoteNode[]> {
    const allQuotes: JobberQuoteNode[] = [];
    let after: string | null = null;
    const PAGE_SIZE = 25;

    do {
      const data: {
        quotes: {
          edges: Array<{ node: JobberQuoteNode }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null = await this.jobberIntegration.graphqlRequest<{
        quotes: {
          edges: Array<{ node: JobberQuoteNode }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(QUOTES_QUERY, { first: PAGE_SIZE, after });

      const connection: { edges: Array<{ node: JobberQuoteNode }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | undefined = data?.quotes;
      if (!connection || !connection.edges) break;

      for (const edge of connection.edges) {
        const node = edge.node;
        if (node.quoteStatus === 'approved' || node.quoteStatus === 'converted') {
          allQuotes.push(node);
        }
      }

      if (connection.pageInfo.hasNextPage && connection.pageInfo.endCursor) {
        after = connection.pageInfo.endCursor;
      } else {
        break;
      }
    } while (true);

    return allQuotes;
  }

  private async loadExistingCorpus(): Promise<Map<string, CorpusRecord>> {
    const result = await this.db.prepare(
      'SELECT jobber_quote_id, title, message, quote_status, (embedding IS NOT NULL) AS has_embedding FROM quote_corpus'
    ).all();

    const map = new Map<string, CorpusRecord>();
    for (const row of result.results as Record<string, unknown>[]) {
      map.set(row.jobber_quote_id as string, {
        jobber_quote_id: row.jobber_quote_id as string,
        title: row.title as string | null,
        message: row.message as string | null,
        quote_status: row.quote_status as string,
        has_embedding: row.has_embedding === 1 || row.has_embedding === true,
      });
    }
    return map;
  }

  private async upsertQuote(node: JobberQuoteNode, searchableText: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO quote_corpus (id, jobber_quote_id, quote_number, title, message, quote_status, searchable_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jobber_quote_id) DO UPDATE SET
         quote_number = excluded.quote_number,
         title = excluded.title,
         message = excluded.message,
         quote_status = excluded.quote_status,
         searchable_text = excluded.searchable_text,
         updated_at = datetime('now')`
    ).bind(crypto.randomUUID(), node.id, node.quoteNumber, node.title, node.message, node.quoteStatus, searchableText).run();
  }

  private async generateEmbeddings(
    items: Array<{ quoteId: string; searchableText: string }>,
  ): Promise<number> {
    if (items.length === 0) return 0;

    let generated = 0;

    for (let offset = 0; offset < items.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = items.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const texts = batch.map((item) => item.searchableText);

      try {
        const embeddings = await this.embeddingService.embedBatch(texts);

        for (let i = 0; i < batch.length; i++) {
          await this.db.prepare(
            "UPDATE quote_corpus SET embedding = ?, updated_at = datetime('now') WHERE jobber_quote_id = ?"
          ).bind(JSON.stringify(embeddings[i]), batch[i].quoteId).run();
          generated++;
        }
      } catch (err) {
        console.error(
          `[QuoteSyncService] Embedding batch failed at offset ${offset}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return generated;
  }

  private async updateSyncStatus(
    totalQuotes: number | null,
    durationMs: number,
    error: string | null,
  ): Promise<void> {
    try {
      if (totalQuotes !== null) {
        await this.db.prepare(
          `UPDATE quote_corpus_sync_status
           SET last_sync_at = datetime('now'), total_quotes = ?, last_sync_duration_ms = ?, last_sync_error = NULL
           WHERE id = 1`
        ).bind(totalQuotes, durationMs).run();
      } else {
        await this.db.prepare(
          `UPDATE quote_corpus_sync_status
           SET last_sync_duration_ms = ?, last_sync_error = ?
           WHERE id = 1`
        ).bind(durationMs, error).run();
      }
    } catch (err) {
      console.error('[QuoteSyncService] Failed to update sync status:', err);
    }
  }

  /**
   * Check if the quantity_history table is empty.
   * Used to trigger a one-time backfill when quotes were synced before the table existed.
   */
  private async isQuantityHistoryEmpty(): Promise<boolean> {
    try {
      const row = await this.db.prepare(
        'SELECT COUNT(*) as count FROM quantity_history LIMIT 1'
      ).first<{ count: number }>();
      return !row || row.count === 0;
    } catch {
      // Table might not exist yet — treat as empty
      return true;
    }
  }
}

export function buildSearchableText(title: string | null, message: string | null): string {
  const t = title?.trim() || '';
  const m = message?.trim() || '';
  if (t && m) return `${t} ${m}`;
  return t || m;
}
