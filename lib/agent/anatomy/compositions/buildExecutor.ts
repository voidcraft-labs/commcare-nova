/**
 * The build executor: one fresh model context per slice attempt, seeded with
 * three user messages (the accepted brief, the private Blueprint checkpoint,
 * the slice focus and inventory), one model step per call, and the full
 * native tool registry mounted while `allowedTools` narrows it per slice.
 *
 * It never inherits a previous slice's transcript. The checkpoint is how it
 * learns what earlier slices built.
 */

import { buildExecutorTools } from "@/lib/agent/build/executorLoop";
import {
	EXECUTOR_SEGMENTS,
	EXECUTOR_SYSTEM,
} from "@/lib/agent/build/executorPrompt";
import type {
	ContextItem,
	DesignSessionInput,
	MomentSpec,
	RoleComposition,
} from "../types";
import {
	fromNewestCompaction,
	newestContext,
	recordedItems,
	throughFirst,
} from "./recordedItems";
import {
	compactionItem,
	missingItem,
	moment,
	segmentViews,
	specById,
	systemItem,
	toolsItem,
	toolViews,
} from "./shared";

const LOOP = {
	file: "lib/agent/build/executorLoop.ts",
	symbol: "runSliceExecutor",
};
const PROMPT = "lib/agent/build/executorPrompt.ts";
const LEDGER = {
	file: "lib/agent/build/modelContextStore.ts",
	symbol: "appendDesignModelContext",
};

const MOMENTS: readonly MomentSpec[] = [
	{
		id: "slice-start",
		label: "Slice start",
		why: "A new generation opens for the attempt and receives exactly three user messages before the first step. Nothing from an earlier slice's transcript is here.",
		needs: ["design-session"],
		source: {
			file: "lib/agent/build/executorLoop.ts",
			symbol: "executorSliceStartMessages",
		},
	},
	{
		id: "latest-step",
		label: "Latest step",
		why: "The whole attempt ledger: each response is persisted before its calls run, and each tool result is persisted before the next call begins.",
		needs: ["design-session"],
		source: LOOP,
	},
	{
		id: "empty-step",
		label: "Empty-step nudge",
		why: "A response with no tool call receives one nudge to continue. Three in a row end the attempt as a protocol failure.",
		needs: ["design-session"],
		source: LOOP,
	},
	{
		id: "repeated-failure",
		label: "Repeated-failure guidance",
		why: "A second substantive failure with the same signature buys one architect decision. The guidance arrives inside the failed tool result, under an auto-blocker key.",
		needs: ["design-session"],
		source: { file: "lib/agent/build/executorLoop.ts", symbol: "auto-blocker" },
	},
	{
		id: "blocker",
		label: "Blocker decision",
		why: "The executor called reportExecutionBlocker. The helper's decision comes back as that call's result: continue guidance, or a stop the build owner handles.",
		needs: ["design-session"],
		source: LOOP,
	},
	{
		id: "after-compaction",
		label: "After a compaction",
		why: "The provider's checkpoint replaces the prefix, including the three seed packets. Nova appends all three again so the executor keeps exact intent and current state.",
		needs: ["design-session"],
		source: {
			file: "lib/agent/build/executorLoop.ts",
			symbol: "compaction-reseed",
		},
	},
];

function staticItems() {
	return systemItem({
		text: EXECUTOR_SYSTEM,
		segments: segmentViews(EXECUTOR_SEGMENTS, PROMPT, "EXECUTOR_SEGMENTS"),
		source: { file: PROMPT, symbol: "EXECUTOR_SYSTEM" },
		note: "Nothing per slice, per app, or per attempt is in here. The brief, checkpoint, and focus ride as messages so the cached prefix holds across every slice of every build.",
	});
}

async function toolItem(): Promise<ContextItem> {
	const tools = await toolViews(
		Object.fromEntries(
			Object.entries(buildExecutorTools()).map(([name, definition]) => [
				name,
				{ ...definition, strict: false },
			]),
		),
	);
	return toolsItem({
		tools,
		source: {
			file: "lib/agent/build/executorLoop.ts",
			symbol: "buildExecutorTools",
		},
		note: "The full native registry on every step, so the prompt-cache shape never changes. The brief's tool profile plus finishWorkflow and reportExecutionBlocker become the provider's allowedTools; the server refuses dispatch outside it.",
	});
}

function ledgerMissing(
	id: string,
	label: string,
	explanation: string,
): ContextItem {
	return missingItem({
		id,
		label,
		needs: "design-session",
		explanation,
		source: LEDGER,
	});
}

function seedMissing(): ContextItem[] {
	return [
		ledgerMissing(
			"brief",
			"Accepted execution brief",
			"The workflow, only the properties it owns or uses, a semantic checklist per construction group, relevant constraints, and the exact tool profile. Pick a local design session with an executed slice to read one.",
		),
		ledgerMissing(
			"candidate",
			"Private Blueprint checkpoint",
			"The complete current private Blueprint projected through durable authoring handles: what every earlier slice built, as the only authority after compaction or recovery.",
		),
		ledgerMissing(
			"focus",
			"Slice focus and inventory",
			"A short focus statement for this slice plus a compact inventory of the workspace.",
		),
	];
}

function noSessionItems(momentId: string): ContextItem[] {
	switch (momentId) {
		case "slice-start":
			return seedMissing();
		case "latest-step":
			return [
				...seedMissing(),
				ledgerMissing(
					"responses",
					"Responses and tool results",
					"Every assistant response and each serially executed tool result, in provider order.",
				),
			];
		case "empty-step":
			return [
				...seedMissing(),
				ledgerMissing(
					"nudge",
					"Empty-step nudge",
					"A user message: continue building with the ordinary Nova tools, call finishWorkflow when the workflow is complete.",
				),
			];
		case "repeated-failure":
			return [
				...seedMissing(),
				ledgerMissing(
					"auto-blocker",
					"Repeated-failure guidance",
					"The failed tool result carrying the architect's continue guidance.",
				),
			];
		case "blocker":
			return [
				...seedMissing(),
				ledgerMissing(
					"blocker",
					"Blocker decision",
					"The reportExecutionBlocker result carrying the architect's decision.",
				),
			];
		case "after-compaction":
			return [
				compactionItem({
					id: "compaction",
					source: LEDGER,
					origin: "composed",
				}),
				ledgerMissing(
					"reseed",
					"Reseed after compaction",
					"The brief, checkpoint, and focus appended again under compaction-reseed keys.",
				),
			];
		default:
			return [];
	}
}

function sessionItems(
	session: DesignSessionInput,
	momentId: string,
): ContextItem[] {
	const context = newestContext(session.contexts, "executor");
	if (context === undefined) {
		return [
			ledgerMissing(
				"brief",
				"Executor context",
				"This session has no executor context yet: no slice attempt has opened one.",
			),
		];
	}
	const items = context.items;
	const notFound = (id: string, label: string, explanation: string) => [
		ledgerMissing(id, label, explanation),
	];
	switch (momentId) {
		case "slice-start":
			return recordedItems(throughFirst(items, "slice-focus") ?? items, LEDGER);
		case "latest-step":
			return recordedItems(items, LEDGER);
		case "empty-step": {
			const slice = throughFirst(items, "empty-step-nudge");
			return slice
				? recordedItems(slice, LEDGER)
				: notFound(
						"nudge",
						"Empty-step nudge",
						"This attempt never produced a response without a tool call.",
					);
		}
		case "repeated-failure": {
			const slice = throughFirst(items, "auto-blocker");
			return slice
				? recordedItems(slice, LEDGER)
				: notFound(
						"auto-blocker",
						"Repeated-failure guidance",
						"This attempt never repeated a substantive failure.",
					);
		}
		case "blocker": {
			const slice = throughFirst(items, "blocker");
			return slice
				? recordedItems(slice, LEDGER)
				: notFound(
						"blocker",
						"Blocker decision",
						"This attempt never reported a blocker.",
					);
		}
		case "after-compaction": {
			const slice = fromNewestCompaction(items);
			return slice
				? recordedItems(slice, LEDGER)
				: notFound(
						"compaction",
						"Compaction checkpoint",
						"This attempt never compacted.",
					);
		}
		default:
			return [];
	}
}

export const buildExecutorComposition: RoleComposition = {
	role: "build-executor",
	moments: MOMENTS,
	async compose(momentId, inputs) {
		const spec = specById(MOMENTS, momentId, "build executor");
		const system = staticItems();
		const tools = await toolItem();
		const messages =
			inputs.session === undefined
				? noSessionItems(spec.id)
				: sessionItems(inputs.session, spec.id);
		return moment(spec, [system, tools, ...messages]);
	},
};
