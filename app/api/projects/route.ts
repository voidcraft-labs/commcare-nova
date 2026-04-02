/**
 * GET /api/projects — list the authenticated user's projects.
 *
 * Returns denormalized project summaries (no full blueprints) sorted by
 * last modified. Only available to authenticated users — BYOK users get 401.
 */
import { requireSession } from '@/lib/auth-utils'
import { ApiError, handleApiError } from '@/lib/apiError'
import { listProjects } from '@/lib/db/projects'

export async function GET(req: Request) {
  try {
    const session = await requireSession(req)
    const projects = await listProjects(session.user.email)
    return Response.json({ projects })
  } catch (err) {
    return handleApiError(err instanceof Error ? err : new ApiError('Failed to load projects', 500))
  }
}
