import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SshPasswordHint } from './SshPasswordHint';

afterEach(() => cleanup());

describe('SshPasswordHint', () => {
  it('shows the connection label and a sudo-specific affordance', () => {
    render(<SshPasswordHint offer={{ label: 'sipaiprod', source: 'sudo' }} onApply={() => {}} />);
    expect(screen.getByText('sipaiprod')).toBeInTheDocument();
    expect(screen.getByText(/to paste saved sudo password/)).toBeInTheDocument();
  });

  it('uses plain "password" wording for a login-source offer', () => {
    render(<SshPasswordHint offer={{ label: 'box', source: 'login' }} onApply={() => {}} />);
    expect(screen.getByText(/to paste saved password/)).toBeInTheDocument();
    expect(screen.queryByText(/sudo password/)).toBeNull();
  });

  it('clicking the hint applies the saved password', () => {
    const onApply = vi.fn();
    render(<SshPasswordHint offer={{ label: 'box', source: 'sudo' }} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onApply).toHaveBeenCalledTimes(1);
  });
});
