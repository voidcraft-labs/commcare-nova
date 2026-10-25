/**
 * SA tool: `updateApp` — set the app's display name and its app settings:
 * whether workers see their saved forms and their incomplete forms.
 *
 * Connect mode and participation are deliberately absent. The shared
 * `configureConnect` / `configure_connect` command owns that complete
 * app-wide target state atomically.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolInvocationContext` interface.
 */

import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import type { AppSettings, AppSettingsPatch } from "@/lib/domain";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

/** The refusal a call that names nothing to change reads. */
export const UPDATE_APP_EMPTY_INPUT_MESSAGE =
	"This call named nothing to change, so the app is as it was. update_app sets the display name (name), whether workers see saved forms (show_saved_forms) and whether they see incomplete forms (show_incomplete_forms); a call needs at least one of them.";

export const updateAppInputSchema = z
	.strictObject({
		name: z
			.string()
			.min(1)
			.optional()
			.describe(
				"App display name (the title users see on devices). Leave it out to keep the current name.",
			),
		show_saved_forms: z
			.boolean()
			.optional()
			.describe(
				"Whether workers can look back at forms they have sent, from the Android home screen. Leave it out to keep the current setting.",
			),
		show_incomplete_forms: z
			.boolean()
			.optional()
			.describe(
				"Whether workers can pick up a form they started and left unfinished, on Android and in Web Apps. Leave it out to keep the current setting.",
			),
	})
	.refine((input) => Object.keys(input).length > 0, {
		error: UPDATE_APP_EMPTY_INPUT_MESSAGE,
	});

export type UpdateAppInput = z.infer<typeof updateAppInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateAppResult = MutationSuccess | { error: string };

/** Each given setting whose value differs from the document's. */
function changedSettings(
	input: UpdateAppInput,
	current: AppSettings,
): AppSettingsPatch {
	const settings: AppSettingsPatch = {};
	if (
		input.show_saved_forms !== undefined &&
		input.show_saved_forms !== current.showSavedForms
	) {
		settings.showSavedForms = input.show_saved_forms;
	}
	if (
		input.show_incomplete_forms !== undefined &&
		input.show_incomplete_forms !== current.showIncompleteForms
	) {
		settings.showIncompleteForms = input.show_incomplete_forms;
	}
	return settings;
}

export const updateAppTool = {
	description:
		"Set the app's display name, and whether workers see their saved forms and their incomplete forms. Anything left out keeps its value.",

	inputSchema: updateAppInputSchema,
	async execute(
		input: UpdateAppInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<UpdateAppResult>> {
		const doc = ctx.snapshot.doc;
		try {
			const settings = changedSettings(input, doc.appSettings);
			const settingsChanged = Object.keys(settings).length > 0;
			if (input.name === undefined && !settingsChanged) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { ok: true, summary: { noop: true } },
				};
			}

			const mutations: Mutation[] = [
				...(input.name !== undefined
					? [{ kind: "setAppName" as const, name: input.name }]
					: []),
				...(settingsChanged
					? [{ kind: "setAppSettings" as const, settings }]
					: []),
			];

			const commit = await guardedMutate(ctx, mutations, "app");
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			}

			const nameChange: ToolCallSummary["nameChange"] = doc.appName
				? "renamed"
				: "named";
			const summary: ToolCallSummary = {
				...(input.name !== undefined && { subject: input.name, nameChange }),
				...(settingsChanged && {
					formLists: {
						...(settings.showSavedForms !== undefined && {
							saved: settings.showSavedForms,
						}),
						...(settings.showIncompleteForms !== undefined && {
							incomplete: settings.showIncompleteForms,
						}),
					},
				}),
			};
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					ok: true,
					summary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
