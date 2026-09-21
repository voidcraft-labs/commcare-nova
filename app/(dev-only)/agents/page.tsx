import {
	ANATOMY_ROLE_IDS,
	type AnatomyRoleId,
	LIFECYCLES,
	OPENAI_COMPACTION_NOTE,
} from "@/lib/agent/anatomy";
import { LifecycleStrips } from "./_components/LifecycleStrips";
import { type RoleSummary, summarizeRole } from "./_lib/roleSummary";

export const dynamic = "force-dynamic";

export default async function AgentsMapPage() {
	const summaries = new Map<AnatomyRoleId, RoleSummary>(
		await Promise.all(
			ANATOMY_ROLE_IDS.map(
				async (role) => [role, await summarizeRole(role)] as const,
			),
		),
	);
	return (
		<div className="space-y-8">
			<div className="max-w-[68ch] space-y-2">
				<h1 className="font-display text-[28px] font-semibold leading-tight tracking-[-0.015em]">
					How Nova's agents are composed
				</h1>
				<p className="text-nova-text-secondary text-[15px] leading-relaxed">
					Explore each role's context, how it changes, and the weight of its
					parts. Role pages distinguish initially loaded tools from the full
					catalog and recorded messages from current code.
				</p>
			</div>
			<LifecycleStrips lifecycles={LIFECYCLES} summaries={summaries} />
			<p className="max-w-[80ch] text-nova-text-muted text-xs leading-relaxed">
				{OPENAI_COMPACTION_NOTE}
			</p>
		</div>
	);
}
