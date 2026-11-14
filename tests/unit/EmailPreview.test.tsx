// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const renderEmail = vi.hoisted(() => vi.fn());
vi.mock('@react-email/components', () => ({ render: renderEmail }));
vi.mock('@/emails/templates', () => ({
  WelcomeEmail: (data: unknown) => ({ template: 'welcome', data }),
  BillingConfirmationEmail: (data: unknown) => ({ template: 'billing', data }),
  CancellationConfirmationEmail: (data: unknown) => ({ template: 'cancellation', data }),
}));

import EmailPreview from '@/app/preview-email/EmailPreview';

describe('EmailPreview', () => {
  beforeEach(() => {
    renderEmail.mockReset();
    renderEmail.mockImplementation(async ({ template }: { template: string }) => `<p>${template}</p>`);
  });

  it('shows loading until the initial welcome preview is ready', async () => {
    let resolve!: (html: string) => void;
    renderEmail.mockReturnValue(new Promise<string>((done) => { resolve = done; }));
    render(<EmailPreview />);

    expect(screen.getByText('Loading preview...')).toBeTruthy();
    expect(screen.queryByTitle('Email Preview')).toBeNull();
    expect(renderEmail).toHaveBeenCalledWith({
      template: 'welcome',
      data: { userName: 'Sean', dashboardUrl: 'https://my-full-stack-app-iota.vercel.app/dashboard' },
    });

    await act(async () => resolve('<html><body>Welcome!</body></html>'));

    expect(screen.getByTitle('Email Preview').getAttribute('srcdoc')).toBe('<html><body>Welcome!</body></html>');
    expect(screen.queryByText('Loading preview...')).toBeNull();
  });

  it.each([
    {
      button: 'Billing Confirmation', template: 'billing', heading: 'Billing Confirmation',
      description: 'Sent after successful payment setup',
      data: {
        firstName: 'Sean', tierName: 'Pro', firstChargeDate: 'February 16, 2026',
        dashboardUrl: 'https://my-full-stack-app-iota.vercel.app/dashboard',
        billingUrl: 'https://my-full-stack-app-iota.vercel.app/profile',
      },
    },
    {
      button: 'Cancellation Email', template: 'cancellation', heading: 'Cancellation Confirmation',
      description: 'Sent when subscription is cancelled',
      data: { firstName: 'Sean', retentionDays: 14, resubscribeUrl: 'https://my-full-stack-app-iota.vercel.app/pay' },
    },
  ])('switches to $template and back to welcome', async ({ button, template, heading, description, data }) => {
    render(<EmailPreview />);
    await screen.findByTitle('Email Preview');

    fireEvent.click(screen.getByRole('button', { name: button }));

    await waitFor(() => expect(screen.getByTitle('Email Preview').getAttribute('srcdoc')).toBe(`<p>${template}</p>`));
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.getByText(description)).toBeTruthy();
    expect(renderEmail).toHaveBeenLastCalledWith({ template, data });

    fireEvent.click(screen.getByRole('button', { name: 'Welcome Email' }));

    await waitFor(() => expect(screen.getByTitle('Email Preview').getAttribute('srcdoc')).toBe('<p>welcome</p>'));
    expect(screen.getByRole('heading', { name: 'Welcome Email' })).toBeTruthy();
    expect(screen.getByText('Sent when a new user signs up')).toBeTruthy();
  });
});
