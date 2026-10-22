import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WakingNotice } from './App';
import { ApiError } from './api/client';
import { ErrorNotice } from './components/ui';
import { ConfigErrorPage } from './pages/GatePages';

describe('cold start UI', () => {
  it('shows a calm status notice, not an alert', () => {
    render(<WakingNotice />);
    expect(screen.getByRole('status')).toHaveTextContent('The service is waking up, this can take up to a minute');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers a manual retry after the automatic retries ended in a network error', async () => {
    const onRetry = vi.fn();
    render(<ErrorNotice error={new ApiError('network', null, null, 'Network error')} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'invalid', 'insecure'] as const)('explains a %s API base URL at startup', (problem) => {
    render(<ConfigErrorPage problem={problem} />);
    expect(screen.getByRole('alert')).toHaveTextContent('VITE_API_BASE_URL');
  });
});
