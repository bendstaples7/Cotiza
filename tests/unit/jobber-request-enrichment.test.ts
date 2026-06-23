import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queueRowNeedsEnrichment, applyEnrichmentToListRow } from '../../worker/src/services/jobber-request-enrichment.js';
import type { ManualRequestListRow } from '../../worker/src/services/manual-request-service.js';

function jobberRow(overrides: Partial<ManualRequestListRow> & { jobberRequestId: string }): ManualRequestListRow {
  return {
    id: 'row-1',
    userId: 'user-1',
    customerName: overrides.customerName ?? 'Unknown',
    customerPhone: null,
    customerEmail: null,
    customerAddress: null,
    serviceDescription: '',
    mediaItemIds: [],
    requestSource: 'jobber',
    createdAt: new Date(),
    ageSeconds: 100,
    jobberRequestId: overrides.jobberRequestId,
    requestTitle: overrides.requestTitle ?? null,
    requestBodyText: overrides.requestBodyText ?? '',
    noteHighlights: overrides.noteHighlights ?? [],
    ...overrides,
  };
}

describe('queueRowNeedsEnrichment', () => {
  it('flags Unknown customer rows', () => {
    expect(queueRowNeedsEnrichment(jobberRow({ jobberRequestId: 'jid-1' }))).toBe(true);
  });

  it('flags literal null customer names', () => {
    expect(queueRowNeedsEnrichment(jobberRow({
      jobberRequestId: 'jid-null',
      customerName: 'null',
    }))).toBe(true);
  });

  it('flags rows with no body or notes', () => {
    expect(queueRowNeedsEnrichment(jobberRow({
      jobberRequestId: 'jid-2',
      customerName: 'Jane Doe',
      requestBodyText: '',
      noteHighlights: [],
    }))).toBe(true);
  });

  it('flags Home Owner placeholder rows for enrichment', () => {
    expect(queueRowNeedsEnrichment(jobberRow({
      jobberRequestId: 'jid-home-owner',
      customerName: 'Home Owner',
      noteHighlights: [{ label: 'Client', message: 'Need cabinets' }],
    }))).toBe(true);
  });

  it('skips rows with note highlights', () => {
    expect(queueRowNeedsEnrichment(jobberRow({
      jobberRequestId: 'jid-3',
      customerName: 'Jane Doe',
      noteHighlights: [{ label: 'Client', message: 'Need cabinets' }],
    }))).toBe(false);
  });
});
describe('applyEnrichmentToListRow', () => {
  it('applies distinct title and body from enrichment', () => {
    const row = jobberRow({ jobberRequestId: 'jid-4', customerName: 'Unknown' });
    const updated = applyEnrichmentToListRow(row, {
      title: 'Bathroom Renovation',
      clientName: 'Fiona Duncan',
      description: 'Replace vanity',
      requestBody: '{}',
      formText: null,
      resolved: {
        customerName: 'Fiona Duncan',
        requestTitle: 'Bathroom Renovation',
        requestBodyText: '[Client] Replace vanity and tile',
        serviceDescription: 'Bathroom Renovation\n\n[Client] Replace vanity and tile',
        noteHighlights: [{ label: 'Client', message: 'Replace vanity and tile' }],
      },
    });

    expect(updated.customerName).toBe('Fiona Duncan');
    expect(updated.requestTitle).toBe('Bathroom Renovation');
    expect(updated.requestBodyText).toContain('Replace vanity');
  });
});
