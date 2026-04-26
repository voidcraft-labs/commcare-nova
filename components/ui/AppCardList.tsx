import type { AppSummary } from "@/lib/db/apps";
import { AppCard } from "./AppCard";

interface AppCardListProps {
	apps: AppSummary[];
	/** When true, non-error apps link to `/build/{id}`. Defaults to false. */
	linkToApps?: boolean;
	/** When true, replay buttons are shown (admin-only feature). Defaults to false. */
	showReplay?: boolean;
}

/**
 * Grid of app cards used by the admin user-detail page (admin viewing
 * any user's apps). The home app list builds its own grid inline in
 * `app/(app)/app-list.tsx` because it owns the delete affordance — a
 * concern admin should never inherit. Stays a Server Component because
 * `AppCard` is the only client island it needs.
 */
export function AppCardList({
	apps,
	linkToApps = false,
	showReplay = false,
}: AppCardListProps) {
	if (apps.length === 0) {
		return (
			<p className="py-12 text-center text-sm text-nova-text-muted">
				No apps yet.
			</p>
		);
	}

	return (
		<div className="grid gap-3">
			{apps.map((app, i) => (
				<AppCard
					key={app.id}
					app={app}
					index={i}
					href={
						linkToApps && app.status !== "error"
							? `/build/${app.id}`
							: undefined
					}
					showReplay={showReplay}
				/>
			))}
		</div>
	);
}
