/**
 * Replay page — admin-only debug tool for reviewing generation logs.
 *
 * Admin access is enforced by the parent layout (`app/build/replay/layout.tsx`)
 * which calls `requireAdminAccess()` before any page renders. No additional
 * admin check needed here.
 */
import { readEvents, readLatestRunId } from "@/lib/log/reader";
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

	// `skipped` > 0 means some events failed schema validation and were
	// dropped — the replay reconstructs from mutations in order, so a missing
	// mutation can render a state that never existed during the real run.
	// Pass it through so the viewer is warned the replay may be incomplete.
	const { events, skipped } = await readEvents(id, runId);
	if (events.length === 0) return <EmptyState />;

	return (
		<ReplayBuilder
			events={events}
			exitPath="/admin"
			skippedEventCount={skipped}
		/>
	);
}
