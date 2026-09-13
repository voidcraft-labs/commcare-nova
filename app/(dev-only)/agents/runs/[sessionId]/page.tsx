import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
	modelLabel,
	type RecordedContext,
	readDesignSession,
	recordedItemsOf,
	type WeighedItem,
	weigh,
} from "@/lib/agent/anatomy";
import {
	RecordedTimeline,
	type TimelineContext,
} from "../../_components/RecordedTimeline";
import { summarizeRole } from "../../_lib/roleSummary";

export const dynamic = "force-dynamic";

async function weighContext(
	context: RecordedContext,
): Promise<readonly WeighedItem[]> {
	const weighed = await weigh({
		id: context.contextId,
		label: "Recorded context",
		why: "",
		needs: [],
		source: {
			file: "lib/agent/build/modelContextStore.ts",
			symbol: "appendDesignModelContext",
		},
		items: recordedItemsOf(context),
	});
	return weighed.items;
}

export default async function RecordedSessionPage({
	params,
}: {
	params: Promise<{ sessionId: string }>;
}) {
	const { sessionId } = await params;
	await connection();
	const session = await readDesignSession(sessionId);
	if (session === null) notFound();
	const [author, executor] = await Promise.all([
		summarizeRole("design-author"),
		summarizeRole("build-executor"),
	]);
	const contexts: TimelineContext[] = await Promise.all(
		session.contexts.map(async (context) => ({
			contextId: context.contextId,
			kind: context.kind,
			generation: context.generation,
			supersedesContextId: context.supersedesContextId,
			modelId: context.modelId,
			modelLabel: modelLabel(context.modelId),
			promptVersion: context.promptVersion,
			toolsetDigest: context.toolsetDigest,
			contextVersion: context.contextVersion,
			slice: context.slice ?? null,
			staticTokens:
				context.kind === "design" ? author.staticTokens : executor.staticTokens,
			items: await weighContext(context),
			steps: context.steps,
		})),
	);
	return (
		<div className="space-y-6">
			<p className="text-nova-text-muted text-xs">
				<Link
					href="/agents/runs"
					className="nova-focusable rounded-md hover:text-nova-text"
				>
					Recorded runs
				</Link>
				{" / "}
				{session.appName ?? `Session ${sessionId.slice(0, 8)}`}
			</p>
			<div className="max-w-[72ch] space-y-1.5">
				<h1 className="font-display text-[28px] font-semibold leading-tight tracking-[-0.015em]">
					{session.appName ?? `Session ${sessionId.slice(0, 8)}`}
				</h1>
				<p className="text-nova-text-secondary text-[15px] leading-relaxed">
					{contexts.length === 0
						? "This session has no model context yet."
						: `${contexts.length} ${contexts.length === 1 ? "context" : "contexts"}, in the order they opened. Each holds exactly what its model received, and each completed step carries the billed usage beside the estimate.`}
				</p>
			</div>
			<RecordedTimeline contexts={contexts} sessionId={sessionId} />
		</div>
	);
}
