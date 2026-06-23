import { describe, it, expect } from 'vitest';
import {
  buildJobberCustomerText,
  buildRequestBodyText,
  parseStructuredNotesFromRequestBody,
  splitEmailContextFromCustomerText,
  parseEmailMessages,
  resolveJobberRequestFields,
  extractCustomerEmailFromRequestBody,
  isAbsentStoredValue,
} from '../../shared/src/jobber-request-text.js';

describe('isAbsentStoredValue', () => {
  it('treats null, empty, and literal "null" as absent', () => {
    expect(isAbsentStoredValue(null)).toBe(true);
    expect(isAbsentStoredValue(undefined)).toBe(true);
    expect(isAbsentStoredValue('')).toBe(true);
    expect(isAbsentStoredValue('null')).toBe(true);
    expect(isAbsentStoredValue('NULL')).toBe(true);
    expect(isAbsentStoredValue('undefined')).toBe(true);
    expect(isAbsentStoredValue('Anne Kirkner')).toBe(false);
  });
});

describe('extractCustomerEmailFromRequestBody', () => {
  it('returns null for literal null string bodies', () => {
    expect(extractCustomerEmailFromRequestBody('null')).toBeNull();
  });

  it('reads top-level email from Jobber API_FETCH payload', () => {
    expect(extractCustomerEmailFromRequestBody({
      email: 'abby@example.com',
      title: 'Flooring',
    })).toBe('abby@example.com');
  });

  it('reads nested request and client email fallbacks', () => {
    expect(extractCustomerEmailFromRequestBody({
      request: { email: 'req@example.com' },
    })).toBe('req@example.com');
    expect(extractCustomerEmailFromRequestBody({
      client: { email: 'client@example.com' },
    })).toBe('client@example.com');
  });

  it('parses JSON string bodies', () => {
    expect(extractCustomerEmailFromRequestBody(
      JSON.stringify({ email: 'parsed@example.com' }),
    )).toBe('parsed@example.com');
  });
});

describe('resolveJobberRequestFields', () => {
  it('resolves client name from request_body when stored client_name is Unknown', () => {
    const fields = resolveJobberRequestFields({
      clientName: 'Unknown',
      title: 'TV Mounting',
      description: null,
      requestBody: {
        title: 'TV Mounting',
        contactName: 'Christi Backer',
        notes: {
          edges: [{
            node: {
              message: 'Need TV mounted above fireplace',
              createdBy: { __typename: 'Client' },
            },
          }],
        },
      },
    });

    expect(fields.customerName).toBe('Christi Backer');
    expect(fields.requestTitle).toBe('TV Mounting');
    expect(fields.requestBodyText).toContain('fireplace');
    expect(fields.serviceDescription).toContain('fireplace');
    expect(fields.noteHighlights[0].label).toBe('Client');
  });

  it('does not use title as customer name when client is missing', () => {
    const fields = resolveJobberRequestFields({
      clientName: 'Unknown',
      title: 'Home Owner',
      description: null,
      requestBody: { title: 'Home Owner' },
    });
    expect(fields.customerName).toBe('Unknown');
    expect(fields.requestTitle).toBe('Home Owner');
  });

  it('rejects Home Owner stored as client_name and uses contactName from request_body', () => {
    const fields = resolveJobberRequestFields({
      clientName: 'Home Owner',
      title: 'Kitchen remodel',
      description: null,
      requestBody: {
        title: 'Kitchen remodel',
        contactName: 'Jack Panella',
      },
    });
    expect(fields.customerName).toBe('Jack Panella');
    expect(fields.requestTitle).toBe('Kitchen remodel');
  });

  it('prefers real client name over Home Owner contactName in request_body', () => {
    const fields = resolveJobberRequestFields({
      clientName: 'Home Owner',
      title: 'Deck repair',
      description: null,
      requestBody: {
        title: 'Deck repair',
        companyName: 'Home Owner',
        contactName: 'Home Owner',
        client: { firstName: 'Linda', lastName: 'Clark', companyName: null },
      },
    });
    expect(fields.customerName).toBe('Linda Clark');
  });

  it('ignores literal "null" strings from sparse webhook rows', () => {
    const fields = resolveJobberRequestFields({
      clientName: 'null',
      title: 'null',
      description: 'null',
      requestBody: 'null',
    });
    expect(fields.customerName).toBe('Unknown');
    expect(fields.requestTitle).toBeNull();
    expect(fields.requestBodyText).toBe('');
  });

  it('clears requestBodyText when it would duplicate the title', () => {
    const fields = resolveJobberRequestFields({
      clientName: 'Fiona Duncan',
      title: 'Bathroom Renovation',
      description: null,
      requestBody: { title: 'Bathroom Renovation', notes: { edges: [] } },
    });
    expect(fields.requestTitle).toBe('Bathroom Renovation');
    expect(fields.requestBodyText).toBe('');
    expect(fields.serviceDescription).toBe('Bathroom Renovation');
  });

  it('uses form text for request body when notes are empty', () => {
    const fields = resolveJobberRequestFields({
      clientName: 'Jane Doe',
      title: 'Kitchen remodel',
      description: null,
      requestBody: { title: 'Kitchen remodel', notes: { edges: [] } },
      formText: 'Scope: Full gut renovation\nBudget: $50k',
    });
    expect(fields.requestBodyText).toContain('Full gut renovation');
  });

  it('uses request title for AI when the only note is an attachment placeholder', () => {
    const fields = resolveJobberRequestFields({
      clientName: 'Justin Bassett-Green',
      title: 'Patio Door Replacement',
      description: 'Attachments from request submission',
      requestBody: {
        title: 'Patio Door Replacement',
        contactName: 'Justin Bassett-Green',
        notes: {
          edges: [{
            node: {
              message: 'Attachments from request submission',
              createdBy: { __typename: 'Client' },
            },
          }],
        },
      },
    });

    expect(fields.requestBodyText).toBe('');
    expect(fields.serviceDescription).toBe('Patio Door Replacement');
    expect(fields.noteHighlights).toHaveLength(0);
  });
});

describe('buildRequestBodyText', () => {
  it('does not fall back to title when notes are empty', () => {
    expect(buildRequestBodyText({ description: '', structuredNotes: [] })).toBe('');
  });

  it('includes labeled notes without title', () => {
    const text = buildRequestBodyText({
      structuredNotes: [
        { message: 'Paint walls', createdBy: 'client', createdAt: '2025-01-01' },
      ],
    });
    expect(text).toBe('[Client] Paint walls');
  });
});

describe('buildJobberCustomerText', () => {
  it('builds labeled notes and skips duplicate description', () => {
    const text = buildJobberCustomerText({
      title: 'Kitchen remodel',
      description: 'Need new cabinets\n\nAlso replace countertops',
      structuredNotes: [
        { message: 'Need new cabinets', createdBy: 'client', createdAt: '2025-01-01' },
        { message: 'Also replace countertops', createdBy: 'client', createdAt: '2025-01-02' },
      ],
    });

    expect(text).toContain('[Client] Need new cabinets');
    expect(text).toContain('[Client] Also replace countertops');
    expect(text).not.toContain('Need new cabinets\n\nAlso replace countertops');
  });

  it('falls back to title when notes are empty', () => {
    expect(buildJobberCustomerText({ title: 'Bathroom update', description: '', structuredNotes: [] }))
      .toBe('Bathroom update');
  });

  it('prepends title when notes are only attachment placeholders', () => {
    expect(buildJobberCustomerText({
      title: 'Patio Door Replacement',
      description: 'Attachments from request submission',
      structuredNotes: [{
        message: 'Attachments from request submission',
        createdBy: 'client',
        createdAt: '2026-06-12T23:02:55Z',
      }],
    })).toBe('Patio Door Replacement');
  });
});

describe('parseStructuredNotesFromRequestBody', () => {
  it('parses note edges from request_body JSON', () => {
    const notes = parseStructuredNotesFromRequestBody({
      notes: {
        edges: [
          {
            node: {
              message: 'Paint the living room',
              createdAt: '2025-06-01T12:00:00Z',
              createdBy: { __typename: 'Client' },
            },
          },
        ],
      },
    });

    expect(notes).toHaveLength(1);
    expect(notes[0].message).toBe('Paint the living room');
    expect(notes[0].createdBy).toBe('client');
  });
});

describe('splitEmailContextFromCustomerText', () => {
  it('splits email block from request text', () => {
    const input = [
      '--- Email Conversation Context ---',
      '',
      '--- Incoming Email ---',
      'From: client@example.com',
      'Subject: Kitchen quote',
      '',
      '--- End Email Context ---',
      '',
      '[Client] Need cabinets',
    ].join('\n');

    const { emailContext, requestText } = splitEmailContextFromCustomerText(input);
    expect(emailContext).toContain('Kitchen quote');
    expect(requestText).toBe('[Client] Need cabinets');
  });
});

describe('parseEmailMessages', () => {
  it('parses formatted email messages', () => {
    const block = [
      '--- Email Conversation Context ---',
      '',
      '--- Incoming Email ---',
      'From: Jane <jane@example.com>',
      'To: info@chicago-reno.com',
      'Subject: Quote request',
      'Date: Jun 1, 2025',
      'Body: Looking for a kitchen remodel',
      '',
      '--- End Email Context ---',
    ].join('\n');

    const messages = parseEmailMessages(block);
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe('Incoming');
    expect(messages[0].subject).toBe('Quote request');
    expect(messages[0].body).toContain('kitchen remodel');
  });
});
