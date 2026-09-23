import type { ToolSet } from "ai";
import { z } from "zod";
import { planMarkdownSchema } from "@/lib/agent/planning/plan";
import {
	SHARED_TOOL_REGISTRY,
	type SharedToolRegistryEntry,
} from "@/lib/agent/sharedToolRegistry";
import { solutionsArchitectToolDefinitions } from "@/lib/agent/solutionsArchitect";
import { readSourceInputSchema } from "@/lib/agent/sources";
import { languageIdentityInputSchema } from "@/lib/agent/tools/localization";

import type { AUTHORING_TOOL_PRESENTATION } from "../toolPresentation";

type PresentedTools = Partial<
	Record<keyof typeof AUTHORING_TOOL_PRESENTATION, ToolSet[string]>
>;

const empty = z.strictObject({});
export const writePlanInputSchema = z.strictObject({
	markdown: planMarkdownSchema,
});
export const editPlanInputSchema = z.strictObject({
	oldText: z.string().min(1),
	newText: z.string(),
});
export const reviewInputSchema = z.strictObject({
	focus: z.string().max(4000).optional(),
});
export const translateLanguageInputSchema = z.strictObject({
	language: languageIdentityInputSchema,
});

export const PLANNING_TOOL_DEFINITIONS = {
	readPlan: {
		description: "Read the shared Markdown plan.",
		inputSchema: empty,
		strict: false,
	},
	writePlan: {
		description:
			"Write or replace the current design in the shared Markdown plan. Revisions retain history; omit review logs and superseded decisions.",
		inputSchema: writePlanInputSchema,
		strict: false,
	},
	editPlan: {
		description:
			"Replace one exact passage in the shared plan. Include enough surrounding text to identify it once.",
		inputSchema: editPlanInputSchema,
		strict: false,
	},
	readSource: {
		description: "Read a passage from an attached document.",
		inputSchema: readSourceInputSchema,
		strict: false,
	},
	getApp: {
		description: "Read the app overview and any unsaved work.",
		inputSchema: empty,
		strict: false,
	},
} satisfies PresentedTools;
const LEAD_TOOL_DEFINITIONS = {
	translateLanguage: {
		description:
			"Translate missing, outdated or unreviewed copied text into a target language, adding it if needed. Preserves current translations; new translations need review.",
		inputSchema: translateLanguageInputSchema,
		strict: false,
	},
	reviewPlan: {
		description:
			"Ask an independent colleague to improve the plan. The colleague edits the same document and explains material changes.",
		inputSchema: reviewInputSchema,
		strict: false,
	},
	startBuilding: {
		description:
			"Begin construction from the plan. A colleague reviews it first if it has not been reviewed.",
		inputSchema: empty,
		strict: false,
	},
	saveWork: {
		description:
			"Save a complete, valid workflow from the private workspace. The first save creates the app; subsequent saves extend it.",
		inputSchema: empty,
		strict: false,
	},
	reviewApp: {
		description:
			"Ask a colleague to inspect the saved app against the user's request and plan. The colleague retains earlier review evidence. Describe corrections or uncertainties to focus the next inspection. Returns their assessment and any plan improvements.",
		inputSchema: reviewInputSchema,
		strict: false,
	},
} satisfies PresentedTools;

export interface AuthoringToolPhase {
	readonly role: "architect" | "peer";
	readonly building: boolean;
	readonly hasApp: boolean;
}

export function sharedToolAvailable(
	entry: SharedToolRegistryEntry,
	phase: AuthoringToolPhase,
): boolean {
	if (entry.policy.effect === "read-blueprint") return true;
	if (phase.role === "peer")
		return entry.policy.effect === "exercise-app" && phase.hasApp;
	// Keep the construction catalog stable across the first save. Hiding a
	// resource until then teaches the architect that the capability is absent;
	// deferred tool discovery does not announce newly available definitions.
	// The invocation boundary explains prerequisites before any side effect.
	return phase.building;
}

/** All authoring definitions come from the same editor/MCP registry. Hosted
 * search defers their loading. Role authority determines discovery; first-save
 * prerequisites are enforced by the invocation boundary. */
export function architectToolDefinitions(phase: AuthoringToolPhase): ToolSet {
	const shared = solutionsArchitectToolDefinitions();
	const selected: ToolSet = {
		toolSearch: shared.toolSearch,
		...PLANNING_TOOL_DEFINITIONS,
	};
	if (phase.role === "architect") {
		selected.askQuestions = shared.askQuestions;
		Object.assign(selected, LEAD_TOOL_DEFINITIONS);
		if (!phase.building) {
			delete selected.translateLanguage;
			delete selected.saveWork;
			delete selected.reviewApp;
		}
		if (!phase.hasApp) delete selected.reviewApp;
	}
	for (const entry of SHARED_TOOL_REGISTRY)
		if (sharedToolAvailable(entry, phase))
			selected[entry.saName] = shared[entry.saName];
	return selected;
}
