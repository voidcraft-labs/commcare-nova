/**
 * Replay page — admin-only debug tool for reviewing generation logs.
 *
 * Loads generation logs directly by appId. Admin access is enforced here
 * (not by a parent layout) since the build layout only gates on auth.
 */
import { requireAuth } from "@/lib/auth-utils";
import { loadLatestRunId, loadRunEvents } from "@/lib/db/logs";
import type { StoredEvent } from "@/lib/db/types";
import { isUserAdmin } from "@/lib/db/users";
import { ReplayBuilder } from "./replay-builder";

interface ReplayPageProps {
	params: Promise<{ id: string }>;
}

export default async function ReplayPage({ params }: ReplayPageProps) {
	const [{ id }, session] = await Promise.all([params, requireAuth()]);

	if (!(await isUserAdmin(session.user.email))) {
		return (
			<div className="h-full flex items-center justify-center">
				<p className="text-nova-rose text-sm">App not found.</p>
			</div>
		);
	}

	const runId = await loadLatestRunId(id);
	if (!runId) {
		return (
			<div className="h-full flex items-center justify-center">
				<p className="text-nova-rose text-sm">
					No generation logs found for this app.
				</p>
			</div>
		);
	}

	const events: StoredEvent[] = await loadRunEvents(id, runId);
	if (events.length === 0) {
		return (
			<div className="h-full flex items-center justify-center">
				<p className="text-nova-rose text-sm">
					No generation logs found for this app.
				</p>
			</div>
		);
	}

	return <ReplayBuilder events={events} exitPath="/admin" />;
}
