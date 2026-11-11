import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === 'development';
const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const posthog = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://app.posthog.com';

// Static CSP (no nonces), so inline scripts are allowed: Next injects inline bootstrap scripts.
// Move to a nonce-based CSP in proxy.ts if 'unsafe-inline' for scripts becomes a concern.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''} https://js.stripe.com https://va.vercel-scripts.com https://*.posthog.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${supabase} ${supabase.replace(/^http/, 'ws')} https://api.stripe.com https://va.vercel-scripts.com ${posthog} https://*.posthog.com`,
  'frame-src https://js.stripe.com https://hooks.stripe.com https://buy.stripe.com https://checkout.stripe.com https://www.youtube.com',
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://checkout.stripe.com",
].join('; ');

const nextConfig: NextConfig = {
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        {
          key: 'Content-Security-Policy',
          value: csp,
        },
        {
          key: 'X-Frame-Options',
          value: 'DENY',
        },
        {
          key: 'X-Content-Type-Options',
          value: 'nosniff',
        },
        {
          key: 'Referrer-Policy',
          value: 'strict-origin-when-cross-origin',
        },
        {
          key: 'X-XSS-Protection',
          value: '1; mode=block',
        },
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=31536000; includeSubDomains',
        },
      ],
    },
  ],
  turbopack: {},
};

export default nextConfig;
