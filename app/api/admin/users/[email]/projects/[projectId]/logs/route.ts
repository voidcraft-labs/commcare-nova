/**
 * Admin log replay endpoint — load generation logs for any user's project.
 *
 * GET /api/admin/users/{email}/projects/{projectId}/logs
 * GET /api/admin/users/{email}/projects/{projectId}/logs?runId={id}
 *
 * Mirrors the user-facing logs endpoint but scopes to the target user's email
 * (from URL path) instead of the session user's email. Admin-only access.
 * Returns `{ events: StoredEvent[], runId: string | null }`.
 */
import { requireAdmin } from '@/lib/auth-utils'
import { ApiError, handleApiError } from '@/lib/apiError'
import { loadRunEvents, loadLatestRunId } from '@/lib/db/logs'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ email: string; projectId: string }> },
) {
  try {
    await requireAdmin(req)
    const { email: rawEmail, projectId } = await params
    const email = decodeURIComponent(rawEmail)
    const { searchParams } = new URL(req.url)

    const runId = searchParams.get('runId') ?? await loadLatestRunId(email, projectId)
    if (!runId) return Response.json({ events: [], runId: null })

    const events = await loadRunEvents(email, projectId, runId)
    return Response.json({ events, runId })
  } catch (err) {
    return handleApiError(err instanceof Error ? err : new ApiError('Failed to load logs', 500))
  }
}
