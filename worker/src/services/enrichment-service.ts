import type { PendingEnrichment } from 'shared';

/** Minimal line item shape needed for enrichment lookups */
interface EnrichmentLineItem {
  id: string;
  productName?: string;
  description?: string;
}

/**
 * Service that processes pending AI enrichments for quote line item descriptions.
 * Each enrichment sends the customer request text + an extraction prompt to OpenAI,
 * then appends the extracted context to the line item's description.
 */
export class EnrichmentService {
  private readonly apiKey: string;
  private readonly apiUrl: string;

  constructor(apiKey: string, apiUrl?: string) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl || 'https://api.openai.com/v1/chat/completions';
  }

  /**
   * Process a list of pending enrichments against the customer request text.
   * Returns a map of lineItemId → extracted description text to append.
   */
  async processEnrichments(
    enrichments: PendingEnrichment[],
    customerRequestText: string,
    currentLineItems: EnrichmentLineItem[],
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    if (!this.apiKey || !customerRequestText.trim() || enrichments.length === 0) {
      return results;
    }

    // Process enrichments in batches to limit concurrency
    const MAX_CONCURRENT = 3;
    for (let i = 0; i < enrichments.length; i += MAX_CONCURRENT) {
      const batch = enrichments.slice(i, i + MAX_CONCURRENT);
      const batchPromises = batch.map(async (enrichment) => {
        try {
          const lineItem = currentLineItems.find(li => li.id === enrichment.lineItemId);
          const productName = lineItem?.productName ?? enrichment.productNamePattern;

          const extracted = await this.extractContext(
            customerRequestText,
            enrichment.extractionPrompt,
            productName,
          );

          if (extracted) {
            const separator = enrichment.separator ?? '. ';
            const existing = lineItem?.description?.trim() ?? '';
            if (existing.toLowerCase().includes(extracted.toLowerCase())) {
              return; // already present, skip
            }
            const newDesc = existing ? `${existing}${separator}${extracted}` : extracted;
            results.set(enrichment.lineItemId, newDesc);
          }
        } catch (err) {
          console.warn(`Enrichment failed for line item ${enrichment.lineItemId}: ${err instanceof Error ? err.message : err}`);
        }
      });
      await Promise.all(batchPromises);
    }

    return results;
  }

  /**
   * Call OpenAI to extract specific context from the customer request.
   */
  private async extractContext(
    customerRequestText: string,
    extractionPrompt: string,
    productName: string,
  ): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.apiKey,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: [
                'You extract specific details from a customer request for a home renovation quote line item.',
                'Return ONLY the extracted details as a brief, factual phrase suitable for a line item description.',
                'If the requested details are not found in the customer request, return exactly "N/A".',
                'Do not add commentary, explanations, or formatting. Just the extracted facts.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: [
                `Product: ${productName}`,
                `Extraction task: ${extractionPrompt}`,
                '',
                'Customer request:',
                customerRequestText,
              ].join('\n'),
            },
          ],
          temperature: 0.1,
          max_tokens: 100,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(`Context extraction failed (${response.status})`);
        return null;
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const extracted = data.choices?.[0]?.message?.content?.trim();

      if (!extracted || extracted === 'N/A' || extracted.toLowerCase() === 'n/a') {
        return null;
      }

      return extracted;
    } catch (err) {
      clearTimeout(timeout);
      console.warn(`Context extraction error: ${err instanceof Error ? err.message : 'unknown'}`);
      return null;
    }
  }
}
