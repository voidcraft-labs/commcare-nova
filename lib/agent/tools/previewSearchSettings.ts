import { z } from "zod";
import {
	previewSearchPageSchema,
	readPreviewSearchPage,
} from "@/lib/deployment/previewSearchPages";
import {
	recoverPreviewSearchSettings,
	type SearchToolScope,
	setPreviewSearchSettings,
} from "@/lib/deployment/previewSearchSettings";
import { previewSearchTargetSchema } from "@/lib/preview/searchSettings";
import { previewSearchChangesSchema } from "@/lib/preview/searchSettingsEdit";
import type { ToolInvocationContext } from "../workspace/types";
import type { MutatingToolResult } from "./common";

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
		"List the saved app's Preview destinations, revisions, search settings, Web Apps record map availability and rule counts. Choose a target to read its ordered rules. Repeat with nextCursor and the same target until nextCursor is null. A null setting is unconfirmed. Local Preview defaults apply only when selected. These settings describe Preview and cannot establish the current settings on CommCare HQ.",
	inputSchema: previewSearchPageSchema,
	async execute(
		input: z.infer<typeof previewSearchPageSchema>,
		ctx: ToolInvocationContext,
	) {
		const data = ctx.appId
			? await readPreviewSearchPage(ctx.appId, ctx.projectId, ctx.userId, input)
			: { error: "Preview search settings need a saved app." };
		return { kind: "read" as const, data };
	},
};

const saveSchema = z.strictObject({
	target: previewSearchTargetSchema,
	expectedRevision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
	changes: previewSearchChangesSchema,
});
type WriteResult =
	| { ok: true; revision: string }
	| { error: string; code?: string };
function saved(revision: string): MutatingToolResult<WriteResult> {
	return {
		kind: "mutate" as const,
		mutations: [],
		result: { ok: true, revision },
	};
}

export const setPreviewSearchSettingsTool = {
	description:
		"Record a project space’s Preview search settings or Web Apps record map availability after a person confirms them. For caseListMap use true for available, false for unavailable, or null for unconfirmed. It does not control Android maps. Read getPreviewSearchSettings for the destination and its revision. Send only the confirmed changes. Omitted settings and rule lists keep their values; null marks a fact unconfirmed. An empty propertyMatchers object confirms the current rules, or exact matching when previously unconfirmed. Edit rules with ordered splices of start, remove, insert against each list. Read target pages for exact indexes. For ignored text preserve the overall order across record types. Record the team's settings only, never infer them from an app or its data. Saving affects Preview for this Project and destination.",
	inputSchema: saveSchema,
	async recover(ctx: ToolInvocationContext) {
		const who = scope(ctx);
		const revision = who && (await recoverPreviewSearchSettings(who));
		return revision ? saved(revision) : undefined;
	},
	async execute(
		input: z.infer<typeof saveSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<WriteResult>> {
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
			input.changes,
			who,
		);
		if (outcome.kind === "saved") return saved(outcome.savedRevision);
		if (outcome.kind === "invalid")
			return {
				kind: "mutate",
				mutations: [],
				result: { error: outcome.message, code: "invalid" },
			};
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
