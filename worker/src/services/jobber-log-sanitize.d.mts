export function sanitizeLogText(value: unknown, secrets?: readonly string[]): string;
export function summarizeUpstreamBody(body: string, secrets?: readonly string[]): string;
export function graphqlOperationName(query: string): string;
export function formatLog(prefix: string, detail: unknown, secrets?: readonly string[]): string;
