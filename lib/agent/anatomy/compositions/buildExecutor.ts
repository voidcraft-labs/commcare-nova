/** Executor composition: stable role guidance, an accepted workflow brief,
 * a bounded workspace overview, and shared tools loaded through hosted search.
 * Each slice owns its transcript; recovery retains durable native results. */

import { executorToolDefinitions } from "@/lib/agent/build/executorLoop";
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
		why: "A new generation opens for the attempt and receives the accepted workflow and workspace overview before the first step. Nothing from an earlier slice's transcript is here.",
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
		why: "After provider compaction, Nova restores the accepted workflow and a current workspace overview. Focused reads provide details.",
		needs: ["design-session"],
		source: {
			file: "lib/agent/build/executorLoop.ts",
			symbol: "compaction-reseed",
		},
	},
];

function systemPromptItem(): ContextItem {
	return systemItem({
		text: EXECUTOR_SYSTEM,
		segments: segmentViews(EXECUTOR_SEGMENTS, PROMPT, "EXECUTOR_SEGMENTS"),
		source: { file: PROMPT, symbol: "EXECUTOR_SYSTEM" },
		note: "Role guidance is stable. Accepted requirements and current workspace state arrive as separate messages.",
	});
}

async function toolItem(): Promise<ContextItem> {
	const tools = await toolViews(executorToolDefinitions());
	return toolsItem({
		tools,
		source: {
			file: "lib/agent/build/executorLoop.ts",
			symbol: "executorToolDefinitions",
		},
		note: "This is the full construction catalog. Each live workflow exposes only its permitted subset through hosted search; dispatch also checks permission when a call runs. Recorded messages show which definitions were loaded.",
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
			"Accepted workflow requirements, relevant records, composition, and constraints. Choose a local design session with an executed slice to inspect its context.",
		),
		ledgerMissing(
			"candidate",
			"Private workspace overview",
			"Names and identities for existing modules, forms, questions, and record properties. Focused reads provide the omitted details.",
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
					"A short work_remaining status, with finishWorkflow as the completion action.",
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
					"The accepted workflow and current overview restored after compaction.",
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
		const system = systemPromptItem();
		const tools = await toolItem();
		const messages =
			inputs.session === undefined
				? noSessionItems(spec.id)
				: sessionItems(inputs.session, spec.id);
		return moment(spec, [system, tools, ...messages]);
	},
};
