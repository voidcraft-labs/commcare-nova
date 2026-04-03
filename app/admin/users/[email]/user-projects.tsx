/**
 * Async server component — user project list.
 *
 * Fetches projects from Firestore and renders the ReplayableProjectList.
 * Wrapped in a Suspense boundary by the parent page so it streams in
 * independently of the profile card and usage table.
 */
import { getAdminUserProjects } from '@/lib/db/admin'
import { ReplayableProjectList } from '@/components/ui/ReplayableProjectList'

interface UserProjectsSectionProps {
  email: string
  /** URL-encoded email for building the logs endpoint URL. */
  encodedEmail: string
}

export async function UserProjectsSection({ email, encodedEmail }: UserProjectsSectionProps) {
  const projects = await getAdminUserProjects(email)

  return (
    <section>
      <h3 className="text-lg font-display font-semibold mb-4">
        Projects ({projects.length})
      </h3>
      <ReplayableProjectList
        projects={projects}
        logsUrlPrefix={`/api/admin/users/${encodedEmail}/projects`}
        emptyState={<p className="text-sm text-nova-text-secondary">No projects yet.</p>}
      />
    </section>
  )
}
