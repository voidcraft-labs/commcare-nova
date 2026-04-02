/**
 * Project logs API — load generation run logs from Firestore.
 *
 * GET /api/projects/{id}/logs            — load entries for the latest run
 * GET /api/projects/{id}/logs?runId={id} — load entries for a specific run
 *
 * Both return `{ events: StoredEvent[], runId: string | null }`.
 * When no entries exist, returns `{ entries: [], runId: null }`.
 *
 * Authenticated-only — BYOK users have no Firestore logs. The user's email
 * scopes all queries to their own data.
 */
import { requireSession } from '@/lib/auth-utils'
import { ApiError, handleApiError } from '@/lib/apiError'
import { loadRunEvents, loadLatestRunId } from '@/lib/db/logs'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession(req)
    const { id: projectId } = await params
    const { searchParams } = new URL(req.url)
    const email = session.user.email

    const runId = searchParams.get('runId') ?? await loadLatestRunId(email, projectId)
    if (!runId) return Response.json({ events: [], runId: null })

    const events = await loadRunEvents(email, projectId, runId)
    return Response.json({ events, runId })
  } catch (err) {
    return handleApiError(err instanceof Error ? err : new ApiError('Failed to load logs', 500))
  }
}
