import { z } from "zod";
import {
	readAuthorizedPreviewSearchCatalog,
	recoverPreviewSearchSettings,
	type SearchToolScope,
	setPreviewSearchSettings,
} from "@/lib/deployment/previewSearchSettings";
import {
	previewSearchTargetSchema,
	previewSearchValuesSchema,
} from "@/lib/preview/searchSettings";
import type { ToolInvocationContext } from "../workspace/types";

function scope(ctx: ToolInvocationContext): SearchToolScope | null {
	return ctx.appId
		? {
				appId: ctx.appId,
				projectId: ctx.projectId,
				actorUserId: ctx.userId,
				requestId: ctx.invocation.requestId,
				role: "tool",
				chatRunHolder: ctx.chatRunHolder,
				ordinaryAuthoring: ctx.ordinaryAuthoring,
				authoringSessionId: ctx.authoringSessionId,
			}
		: null;
}

export const getPreviewSearchSettingsTool = {
	description:
		"Read the saved app's available Preview search destinations, revisions and team-supplied settings. A null setting is unconfirmed. A local destination uses UTC, exact matching and 500 results by default only when selected. These settings describe Preview and cannot establish the current settings on CommCare HQ.",
	inputSchema: z.strictObject({}),
	async execute(_input: unknown, ctx: ToolInvocationContext) {
		const data = ctx.appId
			? await readAuthorizedPreviewSearchCatalog(
					ctx.appId,
					ctx.projectId,
					ctx.userId,
				)
			: { error: "Preview search settings need a saved app." };
		return { kind: "read" as const, data };
	},
};

const saveSchema = z.strictObject({
	target: previewSearchTargetSchema,
	expectedRevision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
	values: previewSearchValuesSchema,
});
function saved(revision: string) {
	return {
		kind: "mutate" as const,
		mutations: [],
		result: { ok: true, revision },
	};
}

export const setPreviewSearchSettingsTool = {
	description:
		"Record a project space's search settings for Preview after a person confirms them. Read getPreviewSearchSettings for the destination and its revision. Keep unconfirmed facts null. Empty fuzzyProperties and ignoredText lists explicitly confirm exact matching with no ignored text. For each ignoredText entry give its exact literal, property and record type, in the overall order the team confirmed. Record the team's settings only, never infer them from an app or its data. Saving affects Preview for this Project and destination.",
	inputSchema: saveSchema,
	async recover(ctx: ToolInvocationContext) {
		const who = scope(ctx);
		const revision = who && (await recoverPreviewSearchSettings(who));
		return revision ? saved(revision) : undefined;
	},
	async execute(input: z.infer<typeof saveSchema>, ctx: ToolInvocationContext) {
		const who = scope(ctx);
		if (!who)
			return {
				kind: "mutate" as const,
				mutations: [],
				result: { error: "Preview search settings need a saved app." },
			};
		const outcome = await setPreviewSearchSettings(
			who,
			ctx.userId,
			input.target,
			input.expectedRevision,
			input.values,
			who,
		);
		if (outcome.kind === "saved") return saved(outcome.savedRevision);
		return {
			kind: "mutate" as const,
			mutations: [],
			result: {
				error:
					outcome.kind === "changed"
						? "A teammate updated these settings. Read the current revision and review it before trying again."
						: "This destination is no longer available. Read the current destinations and choose one.",
				code: outcome.kind,
			},
		};
	},
};
