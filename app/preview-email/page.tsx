// app/preview-email/page.tsx
// Dev-only email preview. Server component so it can 404 in production.

import { notFound } from 'next/navigation';
import EmailPreview from './EmailPreview';

// Evaluate per request so production returns a real 404, not a prerendered soft 404.
export const dynamic = 'force-dynamic';

export default function EmailPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <EmailPreview />;
}
