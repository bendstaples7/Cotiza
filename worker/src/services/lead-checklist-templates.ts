/**
 * Card 96c6f073 T11: the checklist a lead of each job type must answer, and which items can be
 * answered from what Jobber already holds. A video-only item is never auto-answered.
 */
export type ChecklistTemplateItem = {
  question: string;
  required?: boolean;
  /** Answer from the photos the request already holds. */
  fromPhotos?: boolean;
  /** Marked "Check the video:" and left open. */
  videoOnly?: boolean;
  /** Lowercase words; a note line must contain one to answer this item from the request text. */
  keywords: string[];
};

const COMMON: ChecklistTemplateItem[] = [
  { question: 'Send us a walkthrough video of the space', required: false, videoOnly: true, keywords: [] },
];

const MEASUREMENTS: ChecklistTemplateItem = {
  question: 'What are the room measurements?',
  required: true,
  fromPhotos: true,
  keywords: ['measure', 'dimension', 'sq ft', 'square feet'],
};

export const CHECKLIST_TEMPLATES: Record<string, ChecklistTemplateItem[]> = {
  KITCHEN: [{ question: 'What cabinets and countertops do you want?', required: true, keywords: ['cabinet', 'countertop', 'counter'] }, MEASUREMENTS, ...COMMON],
  BATHROOM: [{ question: 'What fixtures and tile do you want?', required: true, keywords: ['fixture', 'tile', 'vanity', 'shower'] }, MEASUREMENTS, ...COMMON],
  BASEMENT: [{ question: 'What is being finished in the basement?', required: true, keywords: ['basement', 'finish', 'framing', 'drywall'] }, MEASUREMENTS, ...COMMON],
  DEFAULT: [{ question: 'What is the scope of the work?', required: true, keywords: ['scope', 'remodel', 'renovat', 'project'] }, MEASUREMENTS, ...COMMON],
};

// Test: `a lead with no known title gets the DEFAULT checklist`.
export function jobTypeKey(title: string | null | undefined): string {
  const text = (title ?? '').toUpperCase();
  for (const key of ['KITCHEN', 'BATHROOM', 'BASEMENT']) if (text.includes(key)) return key;
  return 'DEFAULT';
}
