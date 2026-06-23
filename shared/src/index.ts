export * from './types';
export { CONTENT_TYPE_LABELS, classifyContentType, extractHashtags } from './instagram-utils';
export {
  buildJobberCustomerText,
  buildRequestBodyText,
  parseStructuredNotesFromRequestBody,
  splitEmailContextFromCustomerText,
  parseEmailMessages,
  resolveJobberRequestFields,
  extractCustomerEmailFromRequestBody,
  isBoilerplateJobberNote,
  isAbsentStoredValue,
  isPlaceholderJobberClientName,
} from './jobber-request-text.js';
export type { ParsedEmailMessage, JobberRequestDisplayFields } from './jobber-request-text.js';
