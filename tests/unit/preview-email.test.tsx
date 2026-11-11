import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/app/preview-email/EmailPreview', () => ({ default: () => null }));

import EmailPreviewPage from '@/app/preview-email/page';

describe('/preview-email', () => {
  it('404s in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => EmailPreviewPage()).toThrow('NEXT_NOT_FOUND');
  });

  it('renders outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(EmailPreviewPage()).toBeTruthy();
  });
});
