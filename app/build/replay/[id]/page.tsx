/**
 * Replay page — admin-only, server-side data fetch.
 *
 * `owner` query param selects whose app to replay; defaults to the session
 * user. Admin access is enforced by the parent layout.
 */
import { headers } from "next/headers";
import { requireAuth } from "@/lib/auth-utils";
import { loadLatestRunId, loadRunEvents } from "@/lib/db/logs";
import type { StoredEvent } from "@/lib/db/types";
import { ReplayBuilder } from "./replay-builder";

interface ReplayPageProps {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ owner?: string }>;
}

export default async function ReplayPage({
	params,
	searchParams,
}: ReplayPageProps) {
	/* Force dynamic rendering — searchParams vary per request. */
	await headers();

	const [{ id }, { owner }, session] = await Promise.all([
		params,
		searchParams,
		requireAuth(),
	]);

	/* Determine whose app to replay — admin viewing another user's app
	 * when `owner` is specified, otherwise the session user's own app. */
	const email = owner ?? session.user.email;

	/* Load the latest run's events directly from Firestore. */
	const runId = await loadLatestRunId(email, id);
	if (!runId) {
		return (
			<div className="h-full flex items-center justify-center">
				<p className="text-nova-rose text-sm">
					No generation logs found for this app.
				</p>
			</div>
		);
	}

	const events: StoredEvent[] = await loadRunEvents(email, id, runId);
	if (events.length === 0) {
		return (
			<div className="h-full flex items-center justify-center">
				<p className="text-nova-rose text-sm">
					No generation logs found for this app.
				</p>
			</div>
		);
	}

	/* Build the exit path — navigate back to the admin user page when
	 * viewing another user's app, otherwise back to the app list. */
	const exitPath = owner ? `/admin/users/${encodeURIComponent(owner)}` : "/";

	return <ReplayBuilder events={events} exitPath={exitPath} />;
}
