/**
 * Admin user detail endpoint — returns a single user's profile, usage history, and projects.
 *
 * GET /api/admin/users/{email} → AdminUserDetailResponse
 *
 * Three parallel Firestore reads: user doc, all usage periods, and project list.
 * The email is URL-encoded in the path and decoded before use.
 */
import { requireAdmin } from '@/lib/auth-utils'
import { ApiError, handleApiError } from '@/lib/apiError'
import { getUser } from '@/lib/db/users'
import { collections } from '@/lib/db/firestore'
import { listProjects } from '@/lib/db/projects'
import type { AdminUserDetailResponse, UsagePeriod } from '@/lib/types/admin'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ email: string }> },
) {
  try {
    await requireAdmin(req)
    const { email: rawEmail } = await params
    const email = decodeURIComponent(rawEmail)

    /* Fetch user, usage history, and projects in parallel */
    const [user, usageSnap, projects] = await Promise.all([
      getUser(email),
      collections.usage(email).orderBy('updated_at', 'desc').get(),
      listProjects(email),
    ])

    if (!user) {
      throw new ApiError('User not found', 404)
    }

    /* Map usage documents to serializable periods */
    const usage: UsagePeriod[] = usageSnap.docs.map(doc => {
      const data = doc.data()
      return {
        period: doc.id,
        request_count: data.request_count,
        input_tokens: data.input_tokens,
        output_tokens: data.output_tokens,
        cost_estimate: data.cost_estimate,
      }
    })

    const response: AdminUserDetailResponse = {
      user: {
        email,
        name: user.name,
        image: user.image,
        role: user.role,
        created_at: user.created_at.toDate().toISOString(),
        last_active_at: user.last_active_at.toDate().toISOString(),
      },
      usage,
      projects,
    }

    return Response.json(response)
  } catch (err) {
    return handleApiError(err instanceof Error ? err : new ApiError('Failed to load user details', 500))
  }
}
