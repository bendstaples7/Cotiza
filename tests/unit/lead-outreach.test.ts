import { describe, expect, it } from 'vitest';
import { buildActionMessage, buildOutreach, itemKind, mailtoLink, smsLink } from '../../client/src/leadOutreach';
import type { LeadInfoItem } from '../../client/src/api';

let n = 0;
const item = (question: string, required = true, status: LeadInfoItem['status'] = 'open'): LeadInfoItem => ({
  id: `lii_${String(++n).padStart(36, '0')}`,
  requestId: 'R',
  question,
  status,
  answer: null,
  required,
  createdAt: '2026-11-04T00:00:00Z',
  updatedAt: '2026-11-04T00:00:00Z',
  createdVia: 'assistant',
  updatedVia: 'assistant',
} as LeadInfoItem);

describe('buildOutreach', () => {
  it('asks only the open required questions and lists assumptions in the email', () => {
    const m = buildOutreach({
      clientName: 'Bryan  Waters',
      title: 'Wall Project',
      items: [
        item('Can you send a few photos of the lower level?'),
        item('Assumed: about 80 linear feet of exterior wall.', false),
        item('Optional: a quick video helps.', false),
        item('Old question', true, 'dropped'),
        item('Answered one', true, 'answered'),
      ],
    });
    expect(m.text).toBe(
      'Hi Bryan, this is Chicago Reno about your Wall Project request.\n\n'
      + 'To get your quote out, could you help with one thing? Can you send a few photos of the lower level?\n\n'
      + "We'll list what we're assuming on the quote so you can tell us if anything is off.\n\n"
      + '— Chicago Reno',
    );
    expect(m.emailSubject).toBe('Your Wall Project quote from Chicago Reno');
    expect(m.emailBody).toContain("- We're assuming about 80 linear feet of exterior wall");
    expect(m.emailBody).toContain('- a quick video helps.');
    expect(m.emailBody).not.toContain('Old question');
    expect(m.emailBody).not.toContain('Answered one');
    expect(m.emailBody.endsWith('Thanks,\nChicago Reno')).toBe(true);
  });

  it('numbers several asks, and says the quote is underway when nothing is needed', () => {
    const many = buildOutreach({ clientName: null, title: null, items: [item('First?'), item('Second?')] });
    expect(many.text).toContain('Hi there, this is Chicago Reno about your project request.');
    expect(many.text).toContain('1) First?\n2) Second?');
    const none = buildOutreach({ clientName: 'Emma Chimera', title: 'Condo repairs', items: [item('Assumed: standard tune-up.', false)] });
    expect(none.text).toContain("We're putting your quote together now.");
    expect(none.asks).toEqual([]);
    expect(none.assumptions).toEqual(['standard tune-up']);
    const caps = buildOutreach({ clientName: 'A', title: 'T', items: [item('Assumed: ADU permit is in place.', false), item('Assumed: I-beam stays.', false)] });
    expect(caps.emailBody).toContain("- We're assuming ADU permit is in place");
    expect(caps.emailBody).toContain("- We're assuming I-beam stays");
  });

  it('classifies items', () => {
    expect(itemKind(item('Assumed: x', false))).toBe('assumption');
    expect(itemKind(item('Photos?', false))).toBe('optional');
    expect(itemKind(item('Photos?'))).toBe('ask');
  });
});

describe('links', () => {
  it('builds sms and mailto links', () => {
    expect(smsLink('(773) 555-0100', 'Hi & bye')).toBe('sms:7735550100?&body=Hi%20%26%20bye');
    expect(mailtoLink('a@b.co', 'S', 'B')).toBe('mailto:a@b.co?subject=S&body=B');
    expect(mailtoLink('a@b.co?cc=evil@x.com', 'S', 'B')).toBeNull();
    expect(mailtoLink('a#1@b.co', 'S', 'B')).toBe('mailto:a%231@b.co?subject=S&body=B');
  });
});

describe('buildActionMessage', () => {
  const input = { clientName: 'Chris Trengove', title: 'Vinyl Flooring', items: [item('Can you send the room measurements?')] };

  it('sends the handbook "quote in progress" update', () => {
    const m = buildActionMessage('quote_update', input)!;
    expect(m.text).toContain('Hi Chris, this is Chicago Reno following up on your Vinyl Flooring request.');
    expect(m.text).toContain('finishing touches on your quote');
    expect(m.text).not.toMatch(/AI|Claude/);
    expect(m.emailBody).toContain('Thank you for your patience!');
  });

  it('thanks them when replying, and asks what is still open', () => {
    const m = buildActionMessage('reply', input)!;
    expect(m.text).toMatch(/^Hi Chris, thanks for getting back to us about your Vinyl Flooring request\./);
    expect(m.text).toContain('room measurements');
    expect(m.emailBody).toContain('Thanks for getting back to us about your Vinyl Flooring request.');
  });

  it('checks in, rather than introducing us again, when following up with no checklist', () => {
    const m = buildActionMessage('follow_up', { clientName: 'Anne Brady', title: 'Basement', items: [] })!;
    expect(m.text).toContain('following up on your Basement request');
    expect(m.text).not.toContain("We're putting your quote together now");
  });

  it('uses the asks for intro and follow-up texts, and has no message for drafting or review', () => {
    expect(buildActionMessage('intro_text', input)!.text).toBe(buildOutreach(input).text);
    expect(buildActionMessage('draft_quote', input)).toBeNull();
    expect(buildActionMessage('review', input)).toBeNull();
    expect(buildActionMessage('none', input)).toBeNull();
    expect(buildActionMessage('quote_follow_up', input)!.text).toContain('make sure you received our quote for your Vinyl Flooring');
  });
});
