/**
 * CompletedWorkService — Option 4 (two-pass AI) + Option 5 (deterministic regex)
 *
 * Pass 1 AI call: extracts two structured lists from the customer text:
 *   - completedWork: work already done (must NOT be quoted)
 *   - contextualFacts: background facts that inform the quote but aren't work items
 *
 * Deterministic regex supplement (Option 5): catches common past-tense patterns
 * that the AI might miss, merged into the same completedWork list.
 *
 * Never throws — any failure returns empty lists so quote generation continues.
 */

export interface CompletedWorkContext {
  /** Work items the customer states are already done — do NOT quote these */
  completedWork: string[];
  /** Background facts that inform the quote (substrate, existing conditions, etc.) */
  contextualFacts: string[];
  /** Whether the result came from the AI call (true) or regex-only fallback (false) */
  fromAI: boolean;
}

/**
 * Regex patterns for detecting past-tense completed work in customer text.
 * Each pattern targets a common construction describing already-done work.
 * Patterns are case-insensitive.
 */
const COMPLETED_WORK_PATTERNS: RegExp[] = [
  // "I recently/just/already had X done/installed/completed/spray foamed/finished"
  /(?:i|we)\s+(?:recently|just|already|previously)\s+had\s+(?:my|our|the)?\s*(.+?)\s+(?:done|installed|completed|spray\s*foamed|spray\s*foam(?:ed)?|finished|put\s+in|applied|added)/gi,
  // "X was/were already done/installed/completed"
  /(.+?)\s+(?:was|were|has\s+been|have\s+been)\s+already\s+(?:done|installed|completed|finished|applied|added)/gi,
  // "X is/are already in place/installed/done"
  /(.+?)\s+(?:is|are)\s+already\s+(?:in\s+place|installed|done|finished|completed|there)/gi,
  // "X has already been done/installed"
  /(.+?)\s+has\s+already\s+been\s+(?:done|installed|completed|finished|applied)/gi,
  // "just had X spray foamed / insulated / etc."
  /(?:just|recently)\s+had\s+(?:my|our|the)?\s*(.+?)\s+(?:spray\s*foam(?:ed)?|insulated|drywalled|painted|tiled|floored)/gi,
];

/**
 * Option 5: Deterministic regex extraction of completed work phrases.
 * Returns a deduplicated list of extracted work descriptions.
 */
export function extractCompletedWorkPatterns(customerText: string): string[] {
  const found = new Set<string>();

  for (const pattern of COMPLETED_WORK_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(customerText)) !== null) {
      const captured = match[1]?.trim();
      if (captured && captured.length > 2 && captured.length < 100) {
        found.add(captured.toLowerCase());
      }
    }
  }

  return [...found];
}

/**
 * Option 4: AI-powered two-pass extraction.
 * Calls GPT-4o-mini to extract completed work and contextual facts.
 * Falls back gracefully to regex-only results on any failure.
 */
export class CompletedWorkService {
  private readonly apiKey: string;
  private readonly apiUrl: string;

  constructor(apiKey: string, apiUrl: string) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
  }

  /**
   * Extract completed work context from customer text.
   * Merges AI extraction (Pass 1) with deterministic regex (Option 5).
   * Never throws — returns empty lists on failure.
   */
  async extract(customerText: string): Promise<CompletedWorkContext> {
    if (!customerText.trim()) {
      return { completedWork: [], contextualFacts: [], fromAI: false };
    }

    // Always run regex extraction as a baseline (Option 5)
    const regexCompleted = extractCompletedWorkPatterns(customerText);

    // Attempt AI extraction (Option 4)
    try {
      const aiResult = await this.callAI(customerText);

      // Merge: combine AI results with regex results, deduplicate
      const mergedCompleted = deduplicateStrings([
        ...aiResult.completedWork,
        ...regexCompleted,
      ]);

      return {
        completedWork: mergedCompleted,
        contextualFacts: aiResult.contextualFacts,
        fromAI: true,
      };
    } catch (err) {
      console.warn(
        `[CompletedWorkService] AI extraction failed, using regex only: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        completedWork: regexCompleted,
        contextualFacts: [],
        fromAI: false,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async callAI(customerText: string): Promise<{ completedWork: string[]; contextualFacts: string[] }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    let response: Response;
    try {
      response = await fetch(this.apiUrl, {
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
                'You analyze home renovation customer requests to identify two things:',
                '1. COMPLETED WORK: Work the customer states has ALREADY been done (past tense).',
                '   Examples: "I recently had my roof spray foamed", "the demo was already done", "we just finished the framing".',
                '   These are NOT work to quote — they are background context.',
                '2. CONTEXTUAL FACTS: Background facts about existing conditions that inform the quote.',
                '   Examples: "vaulted ceilings", "spray foam substrate", "existing hardwood floors".',
                '',
                'Return ONLY valid JSON in this exact format:',
                '{',
                '  "completedWork": ["brief description of completed item 1", "..."],',
                '  "contextualFacts": ["brief fact 1", "..."]',
                '}',
                '',
                'Rules:',
                '- completedWork entries should be short noun phrases (e.g. "roof spray foam insulation", "demo")',
                '- contextualFacts entries should be short descriptive phrases (e.g. "vaulted ceilings", "12x18ft rooms")',
                '- If nothing is completed or no facts exist, return empty arrays',
                '- Return ONLY valid JSON. No markdown, no explanation.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: customerText,
            },
          ],
          temperature: 0.1,
          max_tokens: 300,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`OpenAI API returned ${response.status}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error('CompletedWorkService: invalid JSON from AI');
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('CompletedWorkService: expected JSON object');
    }

    const obj = parsed as Record<string, unknown>;
    const completedWork = Array.isArray(obj.completedWork)
      ? (obj.completedWork as unknown[])
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim().toLowerCase())
      : [];
    const contextualFacts = Array.isArray(obj.contextualFacts)
      ? (obj.contextualFacts as unknown[])
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
      : [];

    return { completedWork, contextualFacts };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deduplicateStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/**
 * Fix 2: Filter overly generic completed work entries before they reach the reviewer.
 *
 * Two rules:
 * 1. Minimum word count: drop entries with fewer than 3 words — single/two-word
 *    entries like "roof", "demo", "framing" are too generic and cause false positives.
 * 2. Containment deduplication: if entry A is a substring of entry B, keep only B
 *    (the more specific description). E.g. "roof" ⊂ "roof spray foam insulation" → keep only the longer one.
 */
export function filterCompletedWork(items: string[]): string[] {
  if (items.length === 0) return items;

  // Step 1: drop entries with fewer than 3 words
  const longEnough = items.filter((item) => item.trim().split(/\s+/).length >= 3);

  // If filtering removed everything, fall back to the original list to avoid
  // losing all signal (better to have imprecise signal than none)
  const candidates = longEnough.length > 0 ? longEnough : items;

  // Step 2: containment deduplication — remove any entry that is a substring of another
  const result: string[] = [];
  for (const candidate of candidates) {
    const isSubsumed = candidates.some(
      (other) => other !== candidate && other.toLowerCase().includes(candidate.toLowerCase()),
    );
    if (!isSubsumed) {
      result.push(candidate);
    }
  }

  return result.length > 0 ? result : candidates;
}
