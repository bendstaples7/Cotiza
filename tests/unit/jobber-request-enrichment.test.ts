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

  it('keeps an existing real customer name when enrichment returns a placeholder', () => {
    const row = jobberRow({ jobberRequestId: 'jid-5', customerName: 'Linda Clark' });
    const updated = applyEnrichmentToListRow(row, {
      title: null,
      clientName: 'Home Owner',
      description: null,
      requestBody: null,
      formText: null,
      resolved: {
        customerName: 'Home Owner',
        requestTitle: 'Kitchen remodel',
        requestBodyText: 'Need cabinets',
        serviceDescription: 'Kitchen remodel',
        noteHighlights: [],
      },
    });

    expect(updated.customerName).toBe('Linda Clark');
    expect(updated.requestTitle).toBe('Kitchen remodel');
  });

  it('replaces literal null customer name with enriched placeholder when no real name available', () => {
    const row = jobberRow({ jobberRequestId: 'jid-null-name', customerName: 'null' });
    const updated = applyEnrichmentToListRow(row, {
      title: 'Bathroom update',
      clientName: 'Home Owner',
      description: null,
      requestBody: null,
      formText: null,
      resolved: {
        customerName: 'Home Owner',
        requestTitle: 'Bathroom update',
        requestBodyText: 'Replace tub',
        serviceDescription: 'Bathroom update',
        noteHighlights: [],
      },
    });

    expect(updated.customerName).toBe('Home Owner');
  });

  it('replaces literal null customer name with enriched real name', () => {
    const row = jobberRow({ jobberRequestId: 'jid-null-replace', customerName: 'null' });
    const updated = applyEnrichmentToListRow(row, {
      title: 'Bathroom update',
      clientName: 'Fiona Duncan',
      description: null,
      requestBody: null,
      formText: null,
      resolved: {
        customerName: 'Fiona Duncan',
        requestTitle: 'Bathroom update',
        requestBodyText: 'Replace tub',
        serviceDescription: 'Bathroom update',
        noteHighlights: [],
      },
    });

    expect(updated.customerName).toBe('Fiona Duncan');
  });
});
