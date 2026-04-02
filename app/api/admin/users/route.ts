/**
 * Admin user list endpoint — returns all users with current month usage.
 *
 * GET /api/admin/users → { users: AdminUserRow[], stats: AdminStats }
 *
 * Fetches all UserDocs, then enriches each with current month usage and
 * project count in parallel. For <100 Dimagi users this is bounded and fast.
 * Also computes headline stats (total users, generations, spend) from the
 * same data to avoid a separate stats endpoint.
 */
import { requireAdmin } from '@/lib/auth-utils'
import { ApiError, handleApiError } from '@/lib/apiError'
import { listAllUsers } from '@/lib/db/users'
import { collections, docs } from '@/lib/db/firestore'
import { getCurrentPeriod } from '@/lib/db/usage'
import type { AdminUserRow, AdminStats, AdminUsersResponse } from '@/lib/types/admin'

export async function GET(req: Request) {
  try {
    await requireAdmin(req)

    const allUsers = await listAllUsers()
    const period = getCurrentPeriod()

    /* Enrich each user with usage and project count in parallel */
    const enriched = await Promise.all(
      allUsers.map(async (user): Promise<AdminUserRow> => {
        const [usageSnap, projectCountSnap] = await Promise.all([
          docs.usage(user.email, period).get(),
          collections.projects(user.email).count().get(),
        ])

        const usage = usageSnap.exists ? usageSnap.data()! : null

        return {
          email: user.email,
          name: user.name,
          image: user.image,
          role: user.role,
          created_at: user.created_at.toDate().toISOString(),
          last_active_at: user.last_active_at.toDate().toISOString(),
          generations: usage?.request_count ?? 0,
          cost: usage?.cost_estimate ?? 0,
          project_count: projectCountSnap.data().count,
        }
      }),
    )

    /* Compute headline stats from the enriched data */
    const stats: AdminStats = {
      totalUsers: enriched.length,
      totalGenerations: enriched.reduce((sum, u) => sum + u.generations, 0),
      totalSpend: enriched.reduce((sum, u) => sum + u.cost, 0),
      period,
    }

    const response: AdminUsersResponse = { users: enriched, stats }
    return Response.json(response)
  } catch (err) {
    return handleApiError(err instanceof Error ? err : new ApiError('Failed to load admin data', 500))
  }
}
