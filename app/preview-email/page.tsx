// app/preview-email/page.tsx
// Dev-only email preview. Server component so it can 404 in production.

import { notFound } from 'next/navigation';
import EmailPreview from './EmailPreview';

export default function EmailPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <EmailPreview />;
}
