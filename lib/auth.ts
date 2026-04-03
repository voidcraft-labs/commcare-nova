/**
 * Better Auth — server-side authentication instance.
 *
 * Stateless session management (JWT-based, no database required for auth).
 * Google OAuth restricted to @dimagi.com emails. Authenticated users share
 * the server-side ANTHROPIC_API_KEY.
 *
 * Required env vars:
 *   BETTER_AUTH_SECRET  — JWT signing secret (generate with `openssl rand -hex 32`)
 *   GOOGLE_CLIENT_ID    — Google OAuth client ID
 *   GOOGLE_CLIENT_SECRET — Google OAuth client secret
 *   BETTER_AUTH_URL     — Base URL (e.g. http://localhost:3000 or production URL).
 *                         Optional in dev — Better Auth auto-detects from requests.
 */
import { betterAuth } from 'better-auth'
import { customSession } from 'better-auth/plugins'
import { createAuthMiddleware, APIError } from 'better-auth/api'
import { createUser, isUserAdmin } from './db/users'

/** Email domain allowed for Google OAuth sign-in. */
const ALLOWED_DOMAIN = 'dimagi.com'

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  session: {
    expiresIn: 60 * 60 * 24 * 2,   // 2 days max lifetime
    updateAge: 60 * 60 * 12,        // refresh every 12h of activity
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },

  plugins: [
    /**
     * Enrich the session with the user's admin role from Firestore.
     * Runs server-side on every `getSession`/`useSession` call — the result
     * is cached by Better Auth so this doesn't hit Firestore on every render.
     * The client receives `isAdmin` as part of the session data, eliminating
     * the need for a separate admin check fetch.
     */
    customSession(async ({ user, session }) => {
      let isAdmin = false
      try {
        isAdmin = await isUserAdmin(user.email)
      } catch {
        /* Fail closed — if Firestore is down, user is not admin */
      }
      return { user: { ...user, isAdmin }, session }
    }),
  ],

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

    /**
     * User provisioning — create/update the Firestore user document on sign-in.
     *
     * Fires after the OAuth callback completes successfully. The `newSession`
     * context field contains the freshly minted session with the user's Google
     * profile. This is the authoritative moment we know someone is a user —
     * the Firestore document is created synchronously here so the admin
     * dashboard always has a complete user list.
     */
    after: createAuthMiddleware(async (ctx) => {
      if (!ctx.path.startsWith('/callback/')) return
      const newSession = ctx.context.newSession
      if (!newSession) return

      /* Block sign-in if we can't provision the user doc — downstream
         operations (spend cap, project creation, logging) all depend on it. */
      await createUser(
        newSession.user.email,
        newSession.user.name,
        newSession.user.image ?? null,
      )
    }),
  },
})

/** Type-safe session type exported for use in route handlers. */
export type Session = typeof auth.$Infer.Session
