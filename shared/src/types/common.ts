/** Pagination parameters for list endpoints */
export interface PaginationParams {
  page: number;
  limit: number;
}

/** Aggregated status of all external service connections */
export interface SystemsStatusResponse {
  jobber: {
    available: boolean;
  };
  jobberSession: {
    configured: boolean;
    expired: boolean;
  };
  instagram: {
    status: 'connected' | 'expired' | 'not_connected';
    accountName?: string;
  };
}

/** Result of fetching Gmail context for a quote draft side panel. */
export type DraftEmailContextStatus =
  | 'cached'
  | 'found'
  | 'not_found'
  | 'not_configured'
  | 'no_customer_email';

export interface DraftEmailContextMessage {
  direction: 'Incoming' | 'Outgoing';
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

export interface DraftEmailContextResponse {
  status: DraftEmailContextStatus;
  customerEmail: string | null;
  messages: DraftEmailContextMessage[];
  gmailConfigured: boolean;
}
