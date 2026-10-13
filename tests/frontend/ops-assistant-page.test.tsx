import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import OpsAssistantPage from '../../client/src/pages/OpsAssistantPage';

const mockListAssistantTokens = vi.hoisted(() => vi.fn());
const mockOpsAssistantMcpUrl = vi.hoisted(() => vi.fn(() => 'http://localhost:5173/mcp'));

vi.mock('../../client/src/api', () => ({
  listAssistantTokens: mockListAssistantTokens,
  mintAssistantToken: vi.fn(),
  revokeAssistantToken: vi.fn(),
  opsAssistantMcpUrl: mockOpsAssistantMcpUrl,
}));

describe('OpsAssistantPage', () => {
  beforeEach(() => {
    mockListAssistantTokens.mockReset();
    mockOpsAssistantMcpUrl.mockReturnValue('http://localhost:5173/mcp');
    mockListAssistantTokens.mockResolvedValue({ tokens: [] });
  });

  it('shows one primary title and the MCP URL after load', async () => {
    render(<OpsAssistantPage />);

    expect(screen.getByRole('heading', { level: 1, name: /operations assistant/i })).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(1);

    await waitFor(() => {
      expect(mockListAssistantTokens).toHaveBeenCalled();
    });

    expect(screen.getByText('http://localhost:5173/mcp')).toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });
});
