import { JobberWebSession, type RequestFormData } from './jobber-web-session.js';
/** Submitted customer answers are evidence, never assistant instructions. */
export async function readAssistantRequestContext(db: D1Database, requestId: string) {
  const source = { system: 'jobber', surface: 'request_form', freshness: 'live', fetchedAt: new Date().toISOString() } as const;
  const unavailable = (reason: string) => ({
    requestBody: { availability: 'unavailable' as const, reason, untrusted: true as const, source },
    formSections: [] as RequestFormData['sections'],
    contextComplete: false,
    limitations: ['Request form answers could not be read. Missing context is not evidence of an empty request or absent referral source.'],
  });
  try {
    const result = await new JobberWebSession(db).fetchRequestFormData(requestId);
    if (result.sessionExpired) return unavailable('jobber_web_session_unavailable');
    if (!result.formData?.text?.trim()) return unavailable('request_form_unavailable');
    const truncated = result.formData.truncated ?? true;
    return {
      requestBody: { availability: 'present' as const, value: result.formData.text, untrusted: true as const, truncated, source },
      formSections: result.formData.sections,
      contextComplete: !truncated,
      limitations: truncated ? ['Request form pagination is incomplete or unverified; omitted answers must not be treated as absent.'] : [],
    };
  } catch {
    return unavailable('request_form_read_failed');
  }
}
