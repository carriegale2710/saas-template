# Security Checks

This repository includes a baseline security workflow for an open-source Next.js + Stripe + Supabase starter. It is designed to catch common issues early and to document the security assumptions that downstream adopters must review before deploying to production.

## Automated checks

GitHub Actions runs the following checks on pull requests, default-branch pushes, and a weekly schedule where applicable:

- **Dependency review** on pull requests to detect newly introduced vulnerable dependencies when `ENABLE_DEPENDENCY_REVIEW=true` and repository dependency-review prerequisites are enabled
- **`npm audit --omit=dev --audit-level=high`** to catch high and critical runtime npm vulnerabilities from the lockfile
- **CodeQL JavaScript/TypeScript analysis** for static application security scanning
- **Gitleaks** to scan the repository history and working tree for committed secrets

## Local maintainer workflow

Install dependencies and Gitleaks locally, then run:

```bash
npm install
npm run security:check
```

If `gitleaks` is not installed yet, install it first through your preferred package manager before running `npm run security:check`.

## Reviewed security-sensitive entry points

The current review baseline focuses on:

- `app/api/email/send/route.ts`
- `app/api/stripe/cancel/route.ts`
- `app/api/stripe/reactivate/route.ts`
- `app/api/stripe/sync/route.ts`
- `app/api/stripe/test/route.ts`
- `app/api/stripe/webhook/route.ts`
- `app/api/user/delete/route.ts`
- `app/auth/callback/route.ts`
- `utils/supabase-admin.ts`
- `supabase/functions/*`
- `supabase/scripts/setup/*.sql`
- `initial_supabase_table_schema.sql`

## Protections already present

- Stripe webhook signature verification in the webhook route
- Row-level security policies in the Supabase schema
- Security headers in `next.config.js`

## Hardening applied in this baseline

- Server-side ownership checks for subscription mutation and account deletion routes
- Safer auth callback redirects that only allow in-app paths
- Reduced secret exposure in debug and webhook logs
- Safer `.env.example` defaults that no longer suggest live Stripe keys
- Required dedicated internal email API secret instead of relying on provider-key fallback guidance

## Required setup for adopters

Before using this template in production:

- Set all secrets through your deployment platform and Supabase secrets management
- Use Stripe **test** keys in development and separate live keys in production
- Generate a dedicated `INTERNAL_API_KEY` for server-to-server email calls
- Review Supabase RLS policies and `SECURITY DEFINER` functions for your own data model
- Restrict allowed origins to your deployed application domains
- Disable or remove non-production diagnostic routes before production rollout if you extend them

## Findings policy

Treat these as **must-fix before release**:

- Missing authorization on mutating routes
- Secret exposure in source control, logs, docs, or examples
- Unsafe redirect behavior
- Insecure production-facing defaults in template files
- Over-broad service-role access patterns beyond the intended server-only surfaces

Lower-priority findings can be documented as hardening guidance if they do not create an immediate exploitable path in the starter itself.
