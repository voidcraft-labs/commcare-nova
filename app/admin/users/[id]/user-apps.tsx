/**
 * Async server component — user app list.
 *
 * Fetches apps from Firestore and renders the AppCardList.
 * Wrapped in a Suspense boundary by the parent page so it streams in
 * independently of the profile card and usage table.
 */

import { AppCardList } from "@/components/ui/AppCardList";
import { getAdminUserApps } from "@/lib/db/admin";

interface UserAppsSectionProps {
	userId: string;
}

export async function UserAppsSection({ userId }: UserAppsSectionProps) {
	const apps = await getAdminUserApps(userId);

	return (
		<section>
			<h3 className="text-lg font-display font-semibold mb-4">
				Apps ({apps.length})
			</h3>
			<AppCardList
				apps={apps}
				showReplay
				emptyState={
					<p className="text-sm text-nova-text-secondary">No apps yet.</p>
				}
			/>
		</section>
	);
}
