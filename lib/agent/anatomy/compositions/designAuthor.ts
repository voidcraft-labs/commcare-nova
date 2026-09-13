/**
 * The design author: one durable model context per design session, a static
 * prompt (instructions, capability catalog, platform constraints), 22 tools
 * mounted in one immutable order, and server-authored packets appended to
 * the ledger between provider calls.
 *
 * Every message item comes from a recorded local session: the seed, the state
 * packets, the corrections, and the responses are exactly what the ledger
 * holds. Without a session the composition names each piece and what it
 * needs.
 */

import {
	composeDesignInstructions,
	designAgentOwnedToolDefinitions,
	designAuthorInstructionParts,
} from "@/lib/agent/design/loop/designAgent";
import { designLoopToolDefinitions } from "@/lib/agent/design/loop/tools";
import type {
	ContextItem,
	DesignSessionInput,
	MomentSpec,
	RecordedContext,
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
	specById,
	systemItem,
	toolsItem,
	toolViews,
} from "./shared";

const RUNNER = {
	file: "lib/agent/build/designLoopRunner.ts",
	symbol: "runDesignAgentLoop",
};
const AGENT = {
	file: "lib/agent/design/loop/designAgent.ts",
	symbol: "createDesignAgent",
};
const LEDGER = {
	file: "lib/agent/build/modelContextStore.ts",
	symbol: "appendDesignModelContext",
};

const MOMENTS: readonly MomentSpec[] = [
	{
		id: "first-step",
		label: "First step",
		why: "The context opens with the projected thread as its seed, then the server appends one state packet before the first provider call.",
		needs: ["design-session"],
		source: RUNNER,
	},
	{
		id: "latest-step",
		label: "Latest step",
		why: "The whole ledger as the newest provider call received it: every response appended in order, a fresh state packet before each call.",
		needs: ["design-session"],
		source: RUNNER,
	},
	{
		id: "required-questions",
		label: "Required questions demanded",
		why: "When every construction issue is a blocking question, the server appends an authorization message and forces one askQuestions round.",
		needs: ["design-session"],
		source: {
			file: "lib/agent/design/loop/designAgent.ts",
			symbol: "requiredDesignQuestionMessage",
		},
	},
	{
		id: "correction",
		label: "Server correction",
		why: "A clean response with no update, question, wait, or finalizer receives one server-authored correction and one internal redrive.",
		needs: ["design-session"],
		source: RUNNER,
	},
	{
		id: "wait",
		label: "Wait for input",
		why: "The explicit terminal when the conversation says more is coming: the wait persists in the ledger and the stream closes as awaiting input.",
		needs: ["design-session"],
		source: RUNNER,
	},
	{
		id: "after-compaction",
		label: "After a compaction",
		why: "The provider's checkpoint replaces the prefix. Nova appends a fresh state packet after it so the compacted suffix carries authority again.",
		needs: ["design-session"],
		source: {
			file: "lib/agent/design/loop/designAgent.ts",
			symbol: "projectDesignStepMessages",
		},
	},
	{
		id: "rollover",
		label: "Reseed after a rollover",
		why: "A deployed change to the model, prompt version, tool digest, or context format opens a new generation, reseeded from the whole browser transcript.",
		needs: ["design-session"],
		source: {
			file: "lib/agent/build/modelContextStore.ts",
			symbol: "openDesignModelContext",
		},
	},
];

function systemPromptItem(): ContextItem {
	/* The same three parts the loop runner hands `createDesignAgent`. */
	const { instructions, catalogText, constraintsText } =
		designAuthorInstructionParts();
	return systemItem({
		text: composeDesignInstructions(instructions, catalogText, constraintsText),
		segments: [
			{
				id: "instructions",
				title: "Design agent instructions",
				text: instructions,
				source: {
					file: "lib/agent/design/prompts.ts",
					symbol: "DESIGN_AGENT_SYSTEM",
				},
			},
			{
				id: "capability-catalog",
				title: "Capability catalog",
				text: catalogText,
				source: {
					file: "lib/agent/design/capabilityCatalog.ts",
					symbol: "renderCapabilityCatalog",
				},
				generated: ["buildCapabilityCatalog"],
			},
			{
				id: "platform-constraints",
				title: "Citable platform constraints",
				text: constraintsText,
				source: {
					file: "lib/agent/design/prompts.ts",
					symbol: "renderPlatformConstraintsSection",
				},
				generated: ["PLATFORM_CONSTRAINTS"],
			},
		],
		source: {
			file: "lib/agent/design/loop/designAgent.ts",
			symbol: "composeDesignInstructions",
		},
		note: "Three parts joined by blank lines. The same string in every phase, so a phase change never moves the cached prefix.",
	});
}

async function toolItem(): Promise<ContextItem> {
	const owned = designAgentOwnedToolDefinitions();
	const loop = designLoopToolDefinitions();
	const tools = await toolViews({ ...owned, ...loop });
	const loopCount = Object.keys(loop).length;
	return toolsItem({
		tools,
		source: AGENT,
		digestCovers: Object.keys(loop),
		note: `${tools.length} mounted: ${Object.keys(owned).join(" and ")}, then the ${loopCount} loop tools. The persisted toolset digest covers the ${loopCount}; a changed digest rolls the session to a new generation.`,
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

function noSessionItems(momentId: string): ContextItem[] {
	const seed = ledgerMissing(
		"seed",
		"Seed: the projected thread",
		"The thread converted to model messages with the source package rendered into it. Pick a local design session to read the exact bytes.",
	);
	const state = ledgerMissing(
		"state",
		"Design session state packet",
		"Server-derived before every provider call: artifact ancestry, gate verdicts, open findings, and workspace state.",
	);
	switch (momentId) {
		case "first-step":
			return [seed, state];
		case "latest-step":
			return [
				seed,
				ledgerMissing(
					"responses",
					"Responses and packets",
					"Every assistant response, tool result, user turn, and state packet the ledger holds, in order.",
				),
				state,
			];
		case "required-questions":
			return [
				seed,
				ledgerMissing(
					"required",
					"Required questions demanded",
					"The server's authorization message naming the exact unanswered questions, followed by a forced askQuestions call.",
				),
			];
		case "correction":
			return [
				seed,
				ledgerMissing(
					"correction",
					"Server correction",
					"One of: design-terminal-omission, required-question-rejection, required-question-omission, input-terminal-rejection.",
				),
			];
		case "wait":
			return [
				seed,
				ledgerMissing(
					"wait",
					"Wait for input",
					"The waitForInput call and its result, persisted before orchestration.",
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
					"compaction-state",
					"State packet after compaction",
					"Appended after the checkpoint under a compaction-state: key. Pick a session that compacted to read it.",
				),
			];
		case "rollover":
			return [
				ledgerMissing(
					"seed-through",
					"Seed of the new generation",
					"A seed-through: append over the whole browser transcript, linked to the superseded generation.",
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
	const context = newestContext(session.contexts, "design");
	if (context === undefined) {
		return [
			ledgerMissing(
				"seed",
				"Design context",
				"This session has no design context yet: the design loop has not opened one.",
			),
		];
	}
	const items = context.items;
	const notFound = (id: string, label: string, explanation: string) => [
		ledgerMissing(id, label, explanation),
	];
	switch (momentId) {
		case "first-step":
			return recordedItems(
				throughFirst(items, "state-packet") ?? items,
				LEDGER,
			);
		case "latest-step":
			return recordedItems(items, LEDGER);
		case "required-questions": {
			const slice = throughFirst(items, "required-questions");
			return slice
				? recordedItems(slice, LEDGER)
				: notFound(
						"required",
						"Required questions demanded",
						"This session never needed a forced question round.",
					);
		}
		case "correction": {
			const slice = throughFirst(items, "correction");
			return slice
				? recordedItems(slice, LEDGER)
				: notFound(
						"correction",
						"Server correction",
						"This session never needed a correction.",
					);
		}
		case "wait": {
			const slice = throughFirst(items, "wait");
			return slice
				? recordedItems(slice, LEDGER)
				: notFound(
						"wait",
						"Wait for input",
						"This session never paused with waitForInput.",
					);
		}
		case "after-compaction": {
			const slice = fromNewestCompaction(items);
			return slice
				? recordedItems(slice, LEDGER)
				: notFound(
						"compaction",
						"Compaction checkpoint",
						"This session's newest design context never compacted.",
					);
		}
		case "rollover": {
			const rolled: RecordedContext | undefined = session.contexts
				.filter(
					(candidate) =>
						candidate.kind === "design" && candidate.generation > 0,
				)
				.sort((a, b) => b.generation - a.generation)
				.at(0);
			return rolled
				? recordedItems(
						throughFirst(rolled.items, "state-packet") ?? rolled.items,
						LEDGER,
					)
				: notFound(
						"seed-through",
						"Seed of the new generation",
						"This session never rolled to a new generation.",
					);
		}
		default:
			return [];
	}
}

export const designAuthorComposition: RoleComposition = {
	role: "design-author",
	moments: MOMENTS,
	async compose(momentId, inputs) {
		const spec = specById(MOMENTS, momentId, "design author");
		const system = systemPromptItem();
		const tools = await toolItem();
		const messages =
			inputs.session === undefined
				? noSessionItems(spec.id)
				: sessionItems(inputs.session, spec.id);
		return moment(spec, [system, tools, ...messages]);
	},
};
