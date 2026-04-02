/**
 * Better Auth — client-side authentication instance.
 *
 * Provides React hooks (useSession) and methods (signIn, signOut) for
 * interacting with the Better Auth server. Used by the landing page,
 * BuilderLayout redirect guard, and settings page.
 */
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient()
