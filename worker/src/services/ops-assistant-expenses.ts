/** Same account rule as /api/reports/weekly: expenses are financial records. */
export const EXPENSE_ACCOUNT = 'office@chicago-reno.com';

const PERSON = 'id name { full }';

const EXPENSES_QUERY = `
  query AssistantExpenses($first: Int!, $after: String, $searchTerm: String, $filter: ExpenseFilterAttributes) {
    expenses(first: $first, after: $after, searchTerm: $searchTerm, filter: $filter) {
      edges {
        node {
          id
          title
          description
          date
          total
          createdAt
          enteredBy { ${PERSON} }
          paidBy { ${PERSON} }
          reimbursableTo { ${PERSON} }
          linkedJob { id jobNumber title }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const EXPENSE_QUERIES = { EXPENSES_QUERY };

/** Widens by a day either side; callers re-check each date in Chicago time. */
export function expenseDateFilter(onOrAfter?: string, onOrBefore?: string) {
  const date: { after?: string; before?: string } = {};
  if (onOrAfter) date.after = new Date(Date.parse(`${onOrAfter}T00:00:00Z`) - 86_400_000).toISOString();
  if (onOrBefore) date.before = new Date(Date.parse(`${onOrBefore}T00:00:00Z`) + 2 * 86_400_000).toISOString();
  return Object.keys(date).length ? { date } : null;
}
