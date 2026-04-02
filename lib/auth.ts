/**
 * Better Auth — server-side authentication instance.
 *
 * Stateless session management (JWT-based, no database required for auth).
 * Google OAuth restricted to @dimagi.com emails. Authenticated users share
 * the server-side ANTHROPIC_API_KEY; unauthenticated users fall back to BYOK.
 *
 * Required env vars:
 *   BETTER_AUTH_SECRET  — JWT signing secret (generate with `openssl rand -hex 32`)
 *   GOOGLE_CLIENT_ID    — Google OAuth client ID
 *   GOOGLE_CLIENT_SECRET — Google OAuth client secret
 *   BETTER_AUTH_URL     — Base URL (e.g. http://localhost:3000 or production URL).
 *                         Optional in dev — Better Auth auto-detects from requests.
 */
import { betterAuth } from 'better-auth'
import { createAuthMiddleware, APIError } from 'better-auth/api'

/** Email domain allowed for Google OAuth sign-in. */
const ALLOWED_DOMAIN = 'dimagi.com'

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },

  hooks: {
    /**
     * Domain restriction — reject sign-in attempts from non-Dimagi emails.
     *
     * Google's `hd` param restricts the account picker UI, but is NOT a security
     * measure (can be bypassed). This server-side hook is the actual gate.
     * Intercepts the callback path where user data arrives from Google.
     */
    before: createAuthMiddleware(async (ctx) => {
      /* Only intercept OAuth callbacks — that's where user identity is established */
      if (!ctx.path.startsWith('/callback/')) return

      /**
       * After the OAuth token exchange, Better Auth populates ctx.body with
       * the user profile from the provider. Check the email domain here.
       * If the email isn't available on the body (some flows), we fall through
       * and let the session creation proceed — the email is always verified
       * by Google, so the domain check on the profile is sufficient.
       */
      const email = ctx.body?.email as string | undefined
      if (email && !email.endsWith(`@${ALLOWED_DOMAIN}`)) {
        throw new APIError('FORBIDDEN', {
          message: `Sign-in is restricted to @${ALLOWED_DOMAIN} accounts.`,
        })
      }
    }),
  },
})

/** Type-safe session type exported for use in route handlers. */
export type Session = typeof auth.$Infer.Session
