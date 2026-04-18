/**
 * Replay page — admin-only debug tool for reviewing generation logs.
 *
 * Admin access is enforced by the parent layout (`app/build/replay/layout.tsx`)
 * which calls `requireAdminAccess()` before any page renders. No additional
 * admin check needed here.
 */
import { readEvents, readLatestRunId } from "@/lib/log/reader";
import type { Event } from "@/lib/log/types";
import { ReplayBuilder } from "./replay-builder";

interface ReplayPageProps {
	params: Promise<{ id: string }>;
}

export default async function ReplayPage({ params }: ReplayPageProps) {
	const { id } = await params;

	const runId = await readLatestRunId(id);
	if (!runId) {
		return (
			<div className="h-full flex items-center justify-center">
				<p className="text-nova-rose text-sm">
					No generation logs found for this app.
				</p>
			</div>
		);
	}

	const events: Event[] = await readEvents(id, runId);
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
