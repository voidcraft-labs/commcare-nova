/**
 * Better Auth — client-side authentication instance.
 *
 * Provides React hooks (useSession) and methods (signIn, signOut) for
 * interacting with the Better Auth server. The `customSessionClient` plugin
 * gives the client type-safe access to the `isAdmin` field added by the
 * server-side `customSession` plugin.
 */
import { createAuthClient } from 'better-auth/react'
import { customSessionClient } from 'better-auth/client/plugins'
import type { auth } from './auth'

export const authClient = createAuthClient({
  plugins: [customSessionClient<typeof auth>()],
})
