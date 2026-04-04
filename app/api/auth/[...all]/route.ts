/**
 * Better Auth catch-all route handler.
 *
 * Handles all /api/auth/* requests — OAuth flows, session management,
 * sign-in/sign-out. Better Auth routes internally based on the path segment.
 */

import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
