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

/**
 * Shared empty-state rendered when either no run exists for this app or the
 * resolved run has zero events. Both paths surface the same user-facing
 * message so they share the same markup — any divergence would be a bug, not
 * a feature, so centralizing removes the risk of the two copies drifting.
 */
function EmptyState() {
	return (
		<div className="h-full flex items-center justify-center">
			<p className="text-nova-rose text-sm">
				No generation logs found for this app.
			</p>
		</div>
	);
}

export default async function ReplayPage({ params }: ReplayPageProps) {
	const { id } = await params;

	const runId = await readLatestRunId(id);
	if (!runId) return <EmptyState />;

	const events: Event[] = await readEvents(id, runId);
	if (events.length === 0) return <EmptyState />;

	return <ReplayBuilder events={events} exitPath="/admin" />;
}
