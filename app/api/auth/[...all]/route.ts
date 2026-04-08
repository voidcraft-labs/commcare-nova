/**
 * Better Auth catch-all route handler.
 *
 * Handles all /api/auth/* requests — OAuth flows, session management,
 * sign-in/sign-out. Better Auth routes internally based on the path segment.
 *
 * Uses `auth.handler` directly instead of `toNextJsHandler` so the auth
 * singleton is initialized on first request via `getAuth()`, not at module
 * import time (which would crash during `next build`).
 */
import { getAuth } from "@/lib/auth";

const handler = (req: Request) => getAuth().handler(req);

export { handler as GET, handler as POST };
