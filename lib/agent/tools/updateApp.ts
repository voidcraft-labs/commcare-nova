import {
	cleanLanguageIdentity,
	languageIdentityInputSchema,
} from "./localization";
/**
 * SA tool: `updateApp` — set the app's display name and its app settings:
 * whether groups automatically own new cases, whether workers see their
 * saved forms and their incomplete forms, whether every form requests the
 * device location, where it runs (`runs_only_on`), and which apps workers
 * need on Android.
 *
 * A change that adds a platform is checked before it stages, content first
 * and then media, and refused with the gate's own words: private work stages
 * a batch whatever its findings, and its pure gate sees no media rows, so
 * without the check the refusal would first reach the model at `saveWork`.
 * A change that only removes a platform can strand nothing and skips both.
 *
 * The configureConnect tool owns app-wide roles. Field tools place and
 * edit each Connect activity in its form.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolInvocationContext` interface.
 */

import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import {
	type AppSettings,
	type AppSettingsPatch,
	asUuid,
	type BlueprintDoc,
	declaredPlatforms,
	languageTag,
	type Platform,
	uuidSchema,
} from "@/lib/domain";
import { walkAuthoredAssetRefs } from "@/lib/domain/mediaRefs";
import { requiredAndroidAppsSchema } from "@/lib/domain/requiredAndroidApps";
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
	"This call named nothing to change, so the app is as it was. update_app sets the display name (name), whether workers see saved forms (show_saved_forms), whether they see incomplete forms (show_incomplete_forms), whether forms request the device location (capture_location), whether a new case goes to the worker's case-sharing group (case_sharing), where the app runs (runs_only_on), which apps workers need on Android (required_android_apps), named installations (installation_profile), and the layouts of the first and other menus (first_menu_layout, form_menu_layout). A call needs at least one change.";

const installationInputs = z.strictObject({
	name: z.string(),
	languages: z.array(languageIdentityInputSchema).min(1),
	requiresPracticeWorker: z.boolean(),
});
export const updateAppInputSchema = z
	.strictObject({
		installation_profile: z
			.discriminatedUnion("operation", [
				z.strictObject({
					operation: z.literal("create"),
					...installationInputs.shape,
				}),
				z.strictObject({
					operation: z.literal("update"),
					uuid: uuidSchema,
					patch: installationInputs
						.partial()
						.refine(
							(patch) => Object.keys(patch).length > 0,
							"Choose something to change in this installation profile.",
						),
				}),
				z.strictObject({ operation: z.literal("remove"), uuid: uuidSchema }),
			])
			.optional()
			.describe(
				"Create, change, or remove one named installation. languages is its ordered subset of structured app language identities, with the initial worker language first. requiresPracticeWorker means a practice worker must be chosen in each project space; account identifiers never belong in the profile. Read existing UUIDs with the installations option of getLanguages or get_languages.",
			),
		name: z
			.string()
			.min(1)
			.optional()
			.describe(
				"App display name (the title users see on devices). Leave it out to keep the current name.",
			),
		first_menu_layout: z
			.enum(["list", "grid"])
			.optional()
			.describe("Layout of the first menu workers open."),
		form_menu_layout: z
			.enum(["list", "grid", "individual"])
			.optional()
			.describe(
				"Layout for all other menus. Choose individual to set a menu’s layout with update_module. Web Apps grids show icons and text; Android grids also play spoken labels.",
			),
		capture_location: z
			.boolean()
			.optional()
			.describe(
				"Whether every form requests the Android device's location when it opens. False lets each form choose. Connect always requests location. Web Apps leaves the location empty.",
			),
		case_sharing: z
			.boolean()
			.optional()
			.describe(
				"Automatically give a new case to the worker’s one case-sharing group where its form uses the default owner.",
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
		required_android_apps: requiredAndroidAppsSchema
			.optional()
			.describe(
				"Apps workers need installed before opening this app on Android, in the order workers should see them. Give the whole selection. An empty list clears it.",
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
export type UpdateAppResult =
	| (MutationSuccess & { installation_profile_uuid?: string })
	| { error: string };

/** Each given setting whose value differs from the document's. */
function changedSettings(
	input: UpdateAppInput,
	current: AppSettings,
): AppSettingsPatch {
	const settings: AppSettingsPatch = {};
	const change = input.installation_profile;
	if (change?.operation === "create") {
		const { operation: _operation, ...definition } = change;
		settings.installationProfile = {
			operation: "add",
			profile: {
				...definition,
				languages: definition.languages.map((value) =>
					languageTag(cleanLanguageIdentity(value)),
				),
				uuid: asUuid(crypto.randomUUID()),
			},
		};
	} else if (change?.operation === "update") {
		const { languages, ...other } = change.patch;
		settings.installationProfile = {
			operation: "update",
			uuid: change.uuid,
			patch: {
				...other,
				...(languages && {
					languages: languages.map((value) =>
						languageTag(cleanLanguageIdentity(value)),
					),
				}),
			},
		};
	} else if (change) settings.installationProfile = change;
	if (
		input.capture_location !== undefined &&
		input.capture_location !== (current.captureLocation === true)
	)
		settings.captureLocation = input.capture_location;
	if (
		input.case_sharing !== undefined &&
		input.case_sharing !== (current.caseSharing ?? false)
	)
		settings.caseSharing = input.case_sharing;
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
	if (
		input.first_menu_layout !== undefined &&
		input.first_menu_layout !== (current.firstMenuLayout ?? "list")
	)
		settings.firstMenuLayout =
			input.first_menu_layout === "list" ? null : "grid";
	if (
		input.form_menu_layout !== undefined &&
		input.form_menu_layout !== (current.formMenuLayout ?? "list")
	)
		settings.formMenuLayout =
			input.form_menu_layout === "list" ? null : input.form_menu_layout;
	if (
		input.required_android_apps !== undefined &&
		(input.required_android_apps.length !==
			(current.requiredAndroidApps?.length ?? 0) ||
			input.required_android_apps.some(
				(app, i) => app !== current.requiredAndroidApps?.[i],
			))
	) {
		settings.requiredAndroidApps = input.required_android_apps;
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
	const current = declaredPlatforms(doc);
	const adds = declaredPlatforms(candidate).some(
		(platform) => !current.includes(platform),
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
		"Set the app's display name, its menu layouts, whether groups automatically own new cases, whether workers see their saved forms and their incomplete forms, whether every form requests the Android device location, where it runs, which apps workers need on Android, and which language profiles workers can install. Anything left out keeps its value.",

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
				...(settings.requiredAndroidApps !== undefined && {
					requiredAndroidApps: settings.requiredAndroidApps,
				}),
				...(input.name !== undefined && { subject: input.name, nameChange }),
				...(platforms !== undefined && { platforms }),
				...((settings.firstMenuLayout !== undefined ||
					settings.formMenuLayout !== undefined) && {
					menuLayouts: {
						...(settings.firstMenuLayout !== undefined && {
							first: settings.firstMenuLayout ?? "list",
						}),
						...(settings.formMenuLayout !== undefined && {
							forms: settings.formMenuLayout ?? "list",
						}),
					},
				}),
				...(settings.captureLocation !== undefined && {
					captureLocation: settings.captureLocation === true,
				}),
				...(settings.caseSharing !== undefined && {
					caseSharing: settings.caseSharing === true,
				}),
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
					...(settings.installationProfile?.operation === "add" && {
						installation_profile_uuid:
							settings.installationProfile.profile.uuid,
					}),
					summary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
