/**
 * Admin data queries — shared between API routes and RSC pages.
 *
 * Extracted from the admin API route handlers so Server Components can
 * call the same logic directly without going through HTTP.
 */
import { listAllUsers, getUser } from './users'
import { getDb, collections, docs } from './firestore'
import { getCurrentPeriod } from './usage'
import { listProjects } from './projects'
import type { AdminUserRow, AdminStats, AdminUsersResponse, AdminUserDetailResponse, UsagePeriod } from '../types/admin'

/**
 * Fetch all users with current month usage and project counts.
 *
 * Batch-reads all usage docs in a single Firestore getAll() call (1 round trip
 * for N users instead of N individual reads). Project counts are aggregation
 * queries and can't be batched, so those run in parallel per user.
 */
export async function getAdminUsersWithStats(): Promise<AdminUsersResponse> {
  const allUsers = await listAllUsers()
  const period = getCurrentPeriod()

  /* Batch-read all usage docs in a single round trip */
  const usageRefs = allUsers.map(u => docs.usage(u.email, period))
  const usageSnaps = usageRefs.length > 0 ? await getDb().getAll(...usageRefs) : []

  /* Project counts are aggregation queries — run in parallel */
  const projectCounts = await Promise.all(
    allUsers.map(u => collections.projects(u.email).count().get()),
  )

  const enriched: AdminUserRow[] = allUsers.map((user, i) => {
    const usageData = usageSnaps[i]?.exists ? usageSnaps[i].data() as { request_count?: number; cost_estimate?: number } : null

    return {
      email: user.email,
      name: user.name,
      image: user.image,
      role: user.role,
      created_at: user.created_at.toDate().toISOString(),
      last_active_at: user.last_active_at.toDate().toISOString(),
      generations: usageData?.request_count ?? 0,
      cost: usageData?.cost_estimate ?? 0,
      project_count: projectCounts[i].data().count,
    }
  })

  /* Compute headline stats from the enriched data */
  const stats: AdminStats = {
    totalUsers: enriched.length,
    totalGenerations: enriched.reduce((sum, u) => sum + u.generations, 0),
    totalSpend: enriched.reduce((sum, u) => sum + u.cost, 0),
    period,
  }

  return { users: enriched, stats }
}

/**
 * Fetch a single user's profile, usage history, and projects.
 *
 * Returns null if the user doesn't exist. Three parallel Firestore reads:
 * user doc, all usage periods, and project list.
 */
export async function getAdminUserDetail(email: string): Promise<AdminUserDetailResponse | null> {
  const [user, usageSnap, projects] = await Promise.all([
    getUser(email),
    collections.usage(email).orderBy('updated_at', 'desc').get(),
    listProjects(email),
  ])

  if (!user) return null

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

  return {
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
}
