/**
 * Async server component — user app list.
 *
 * Fetches apps from Firestore and renders the ReplayableAppList.
 * Wrapped in a Suspense boundary by the parent page so it streams in
 * independently of the profile card and usage table.
 */

import { ReplayableAppList } from "@/components/ui/ReplayableAppList";
import { getAdminUserApps } from "@/lib/db/admin";

interface UserAppsSectionProps {
	email: string;
	/** URL-encoded email for building the logs endpoint URL. */
	encodedEmail: string;
}

export async function UserAppsSection({
	email,
	encodedEmail,
}: UserAppsSectionProps) {
	const apps = await getAdminUserApps(email);

	return (
		<section>
			<h3 className="text-lg font-display font-semibold mb-4">
				Apps ({apps.length})
			</h3>
			<ReplayableAppList
				apps={apps}
				logsUrlPrefix={`/api/admin/users/${encodedEmail}/apps`}
				emptyState={
					<p className="text-sm text-nova-text-secondary">No apps yet.</p>
				}
			/>
		</section>
	);
}
