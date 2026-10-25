/**
 * SA tool: `updateApp` — set the app's display name and its app settings:
 * whether workers see their saved forms and their incomplete forms, and
 * whether it runs only in Web Apps or only on Android (`runs_only_on`).
 *
 * A change that adds a platform is checked before it stages, content first
 * and then media, and refused with the gate's own words: private work stages
 * a batch whatever its findings, and its pure gate sees no media rows, so
 * without the check the refusal would first reach the model at `saveWork`.
 * A change that only removes a platform can strand nothing and skips both.
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
import {
	type AppSettings,
	type AppSettingsPatch,
	type BlueprintDoc,
	declaredPlatforms,
	type Platform,
} from "@/lib/domain";
import { walkAuthoredAssetRefs } from "@/lib/domain/mediaRefs";
import { mediaDeclarationVerdict } from "@/lib/media/attachVerdicts";
import { describeUnplayableReferences } from "@/lib/media/platformPlayback";
import type { ToolInvocationContext } from "../workspace/types";
import {
	applyToDoc,
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import { MEDIA_APP_UNAVAILABLE_MESSAGE, mediaProjectId } from "./media/shared";
import {
	declarationPlatformRefusal,
	precheckLookupContext,
} from "./shared/platformPrecheck";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

/** The refusal a call that names nothing to change reads. */
export const UPDATE_APP_EMPTY_INPUT_MESSAGE =
	"This call named nothing to change, so the app is as it was. update_app sets the display name (name), whether workers see saved forms (show_saved_forms), whether they see incomplete forms (show_incomplete_forms) and where the app runs (runs_only_on); a call needs at least one of them.";

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
		runs_only_on: z
			.enum(["web-apps", "android"])
			.nullable()
			.optional()
			.describe(
				"Where workers use this app when it runs on only one platform: web-apps for Web Apps in a browser, android for the CommCare app on Android. null returns the app to both, which is how a new app starts. A change is refused while the app holds something the result can't run, and the refusal names each. Change it only when the person has said where their workers use the app, or the request needs a feature that runs on only one platform. Leave it out to keep the current setting.",
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
	if (input.runs_only_on === null) {
		if (current.runsOnlyOn !== undefined) settings.runsOnlyOn = null;
	} else if (
		input.runs_only_on !== undefined &&
		input.runs_only_on !== current.runsOnlyOn
	) {
		settings.runsOnlyOn = input.runs_only_on;
	}
	return settings;
}

/**
 * The refusal of a change that adds a platform, before it stages: the
 * content the new declaration can't run, in the gate's own findings, then
 * each file it can't play, in the commit kernel's own words; `undefined`
 * when neither stands in the way.
 */
async function platformAdditionRefusal(
	ctx: ToolInvocationContext,
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): Promise<string | undefined> {
	const candidate = applyToDoc(doc, mutations);
	const adds = declaredPlatforms(candidate).some(
		(platform) => !declaredPlatforms(doc).includes(platform),
	);
	if (!adds) return undefined;
	const content = declarationPlatformRefusal(
		doc,
		mutations,
		await precheckLookupContext(ctx, doc, candidate),
	);
	if (content !== undefined) return content;
	// A document with no file reference has nothing a platform could fail to play.
	if (walkAuthoredAssetRefs(candidate).next().done) return undefined;
	const projectId = await mediaProjectId(ctx);
	if (projectId === undefined) return MEDIA_APP_UNAVAILABLE_MESSAGE;
	const media = await mediaDeclarationVerdict({ projectId, doc: candidate });
	return media.ok ? undefined : describeUnplayableReferences(media.references);
}

/** The declaration a patch leaves, for the summary: "both" or the one platform. */
function declarationAfter(
	settings: AppSettingsPatch,
): "both" | Platform | undefined {
	if (!("runsOnlyOn" in settings)) return undefined;
	return settings.runsOnlyOn ?? "both";
}

export const updateAppTool = {
	description:
		"Set the app's display name, whether workers see their saved forms and their incomplete forms, and whether it runs only in Web Apps or only on Android. Anything left out keeps its value.",

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

			const refusal = await platformAdditionRefusal(ctx, doc, mutations);
			if (refusal !== undefined) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: refusal },
				};
			}

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
			const platforms = declarationAfter(settings);
			const formListsChanged =
				settings.showSavedForms !== undefined ||
				settings.showIncompleteForms !== undefined;
			const summary: ToolCallSummary = {
				...(input.name !== undefined && { subject: input.name, nameChange }),
				...(platforms !== undefined && { platforms }),
				...(formListsChanged && {
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
