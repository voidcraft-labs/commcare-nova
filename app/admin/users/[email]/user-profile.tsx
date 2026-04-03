/**
 * Async server component — user profile card.
 *
 * Fetches the user document from Firestore and renders the profile card.
 * Wrapped in a Suspense boundary by the parent page so it streams in
 * independently of the usage table and project list.
 */
import { notFound } from 'next/navigation'
import { Badge } from '@/components/ui/Badge'
import { getAdminUserProfile } from '@/lib/db/admin'
import { formatRelativeDate } from '@/lib/utils/format'

interface UserProfileSectionProps {
  email: string
}

export async function UserProfileSection({ email }: UserProfileSectionProps) {
  const user = await getAdminUserProfile(email)
  if (!user) notFound()

  return (
    <div className="bg-nova-deep border border-nova-border rounded-xl p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {user.image ? (
            <img
              src={user.image}
              alt=""
              className="w-12 h-12 rounded-full border border-nova-border"
            />
          ) : (
            <div className="w-12 h-12 rounded-full bg-nova-surface border border-nova-border flex items-center justify-center text-lg text-nova-text-secondary">
              {user.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div>
            <h2 className="text-lg font-display font-semibold">{user.name}</h2>
            <p className="text-sm text-nova-text-secondary">{user.email}</p>
            <p className="text-xs text-nova-text-muted mt-1">
              Joined {new Date(user.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              {' \u00b7 '}
              Active {formatRelativeDate(new Date(user.last_active_at))}
            </p>
          </div>
        </div>
        <Badge variant={user.role === 'admin' ? 'violet' : 'muted'}>
          {user.role}
        </Badge>
      </div>
    </div>
  )
}
