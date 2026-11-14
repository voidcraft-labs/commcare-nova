/**
 * SA tool: `set_menu_media` — set or clear menu media on one or more of four
 * carriers in a single call: a module's home-screen tile, a form's menu
 * tile, a module's case list item in its menu (`Module.caseListMenuItem`)
 * and the Register button of a case list that always offers another menu's
 * registration form (`Module.caseListRegistrationForm`, the `always` arm).
 * Each item sets its carrier's `icon` (image) and `audioLabel` (audio
 * prompt).
 *
 * Menu carriers take image + audio only (no video — see
 * `lib/domain/multimedia.ts::mediaSchema`'s docstring). One list-taking
 * tool covers every carrier — there is no per-carrier twin (the
 * no-singular-twin rule: one tile is a length-1 `items` array). An app's
 * whole menu sets in ONE call, which is also what lets the model see sibling
 * tiles side by side when it picks icons (the prompt's vary-within-a-screen
 * guidance leans on this). Each item is discriminated by `target`: the
 * module and case list item arms offer the topic-icon slugs, the form and
 * Register button arms the action-icon slugs.
 *
 * Both slots are set per item; each is required-and-nullable so the SA
 * states intent explicitly (an asset id or built-in slug sets the slot,
 * `null` clears it). To touch only one slot, read the other's current
 * value — a `getModule` read carries each built-in icon as its accepted catalog
 * slug and uploaded slots as UUIDs — and pass that authoring value back.
 *
 * The batch is all-or-nothing (`commitMediaBatch`): every item must
 * resolve (module / form exists) and every set slot must pass the
 * at-source asset verdict (exists / owned / ready / kind-matched / inside
 * the export ceiling) before the single gated commit; any failure returns
 * `{ error }` naming every offending item and nothing is written. Two
 * items addressing the same tile apply in order — the later one wins.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolInvocationContext`.
 */

import { z } from "zod";
import { alwaysOfferedRegistrationMutations } from "@/lib/doc/alwaysOfferedRegistration";
import {
	alwaysOfferedRegistrationOf,
	type CaseListMenuItem,
	FORM_ICON_SLUGS,
	MODULE_ICON_SLUGS,
} from "@/lib/domain";
import {
	setFormMediaMutations,
	setModuleMediaMutations,
} from "../../blueprintHelpers";
import type { ToolInvocationContext } from "../../workspace/types";
import { type MutatingToolResult, toToolErrorResult } from "../common";
import {
	formAddressSchema,
	moduleAddressSchema,
	resolveFormAddress,
	resolveModuleAddress,
} from "../shared/entityAddresses";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	commitMediaBatch,
	nullableAssetSlot,
	nullableIconSlot,
	type ResolvedMediaBatchItem,
	resolveIconInput,
	slotExpectation,
} from "./shared";

const moduleMenuItemSchema = moduleAddressSchema
	.extend({
		target: z.literal("module").describe("A module's home-screen tile"),
		icon: nullableIconSlot(
			MODULE_ICON_SLUGS,
			"The image on the module's home-screen tile. Pass a built-in icon slug " +
				"(one of the listed topic icons, e.g. household, patient, lab) for a " +
				"ready-made icon with no upload, OR the asset id of an uploaded image " +
				"from list_media_assets, OR null to clear it.",
		),
		audioLabel: nullableAssetSlot(
			"Asset id of the audio prompt played for the module's menu label, or " +
				"null to clear it. Discover audio asset ids with list_media_assets.",
		),
	})
	.strict();

const formMenuItemSchema = formAddressSchema
	.extend({
		target: z.literal("form").describe("A form's menu tile"),
		icon: nullableIconSlot(
			FORM_ICON_SLUGS,
			"The image on the form's menu tile. Pass a built-in icon slug (one of " +
				"the listed action icons, e.g. register, follow_up, refer) for a " +
				"ready-made icon with no upload, OR the asset id of an uploaded image " +
				"from list_media_assets, OR null to clear it.",
		),
		audioLabel: nullableAssetSlot(
			"Asset id of the audio prompt played for the form's menu label, or null " +
				"to clear it. Discover audio asset ids with list_media_assets.",
		),
	})
	.strict();

const caseListRegistrationItemSchema = moduleAddressSchema
	.extend({
		target: z
			.literal("case-list-registration")
			.describe("The Register button on a module's case list"),
		icon: nullableIconSlot(
			FORM_ICON_SLUGS,
			"The image on the Register button. Pass a built-in icon slug (one of the listed action icons, " +
				"e.g. register), OR the asset id of an uploaded image from list_media_assets, OR null to clear " +
				"it. Web Apps shows the button's text only.",
		),
		audioLabel: nullableAssetSlot(
			"Asset id of the audio prompt played for the Register button's label, or null to clear it.",
		),
	})
	.strict();

const caseListMenuItemItemSchema = moduleAddressSchema
	.extend({
		target: z
			.literal("case-list-menu-item")
			.describe("A module's case list item in its menu"),
		icon: nullableIconSlot(
			MODULE_ICON_SLUGS,
			"The image on the case list item. Pass a built-in icon slug (one of the listed topic icons, " +
				"e.g. household), OR the asset id of an uploaded image from list_media_assets, OR null to " +
				"clear it.",
		),
		audioLabel: nullableAssetSlot(
			"Asset id of the audio prompt played for the case list item's label, or null to clear it.",
		),
	})
	.strict();

export const setMenuMediaInputSchema = z.strictObject({
	items: z
		.array(
			z.discriminatedUnion("target", [
				moduleMenuItemSchema,
				formMenuItemSchema,
				caseListMenuItemItemSchema,
				caseListRegistrationItemSchema,
			]),
		)
		.min(1)
		.describe(
			"The tiles, items and buttons to set: module tiles (target: module), form tiles (target: form), a case list's menu item (target: case-list-menu-item) and a case list's Register button (target: case-list-registration), mixed freely.",
		),
});

export type SetMenuMediaInput = z.infer<typeof setMenuMediaInputSchema>;

export type SetMenuMediaResult = MutationSuccess | { error: string };

export const setMenuMediaTool = {
	description:
		"Set or clear icons and audio labels on module and form menu tiles, on a case list's menu item and on a case list's Register button. Each item sets BOTH slots of one tile, item or button (null clears; to keep a slot, pass back its stored value). Style the whole menu in one call so the icons read coherently together.",
	inputSchema: setMenuMediaInputSchema,
	async execute(
		input: SetMenuMediaInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<SetMenuMediaResult>> {
		const doc = ctx.snapshot.doc;
		const { items } = input;
		try {
			// Resolve every item before writing anything, collecting every
			// failure — `commitMediaBatch` reports them as one all-or-nothing
			// error. The arms differ in target resolution, the mutation
			// builder, and the carrier phrase.
			const resolved: ResolvedMediaBatchItem[] = [];
			const failures: string[] = [];
			for (const [i, item] of items.entries()) {
				if (item.target === "module") {
					const address = resolveModuleAddress(doc, item);
					if (!address.ok) {
						failures.push(`items[${i}]: ${address.error}`);
						continue;
					}
					const mod = address.module;
					const carrierPhrase = `module "${mod.name}"`;
					const icon = resolveIconInput(
						item.icon,
						`the icon on ${carrierPhrase}`,
					);
					resolved.push({
						mutations: setModuleMediaMutations(
							mod.uuid,
							icon.icon,
							item.audioLabel,
						),
						expectations: [
							...icon.expectations,
							...slotExpectation(
								item.audioLabel,
								"audio",
								`the audio label on ${carrierPhrase}`,
							),
						],
					});
				} else if (item.target === "case-list-menu-item") {
					const address = resolveModuleAddress(doc, item);
					if (!address.ok) {
						failures.push(`items[${i}]: ${address.error}`);
						continue;
					}
					const mod = address.module;
					const stored = mod.caseListMenuItem;
					if (stored === undefined) {
						failures.push(
							`items[${i}]: Module "${mod.name}" has no case list item in its menu, so there is no item to set media on. You can add one with case_list_menu_item on update_module.`,
						);
						continue;
					}
					const carrierPhrase = `the case list item of module "${mod.name}"`;
					const icon = resolveIconInput(
						item.icon,
						`the icon on ${carrierPhrase}`,
					);
					// The entry is set whole, its label kept; a cleared slot is an
					// absent key of that entry, which survives JSON.
					const entry: CaseListMenuItem = {
						...(stored.label !== undefined && { label: stored.label }),
						...(icon.icon !== null && { icon: icon.icon }),
						...(item.audioLabel !== null && { audioLabel: item.audioLabel }),
					};
					resolved.push({
						mutations: [
							{ kind: "setCaseListMenuItem", uuid: mod.uuid, item: entry },
						],
						expectations: [
							...icon.expectations,
							...slotExpectation(
								item.audioLabel,
								"audio",
								`the audio label on ${carrierPhrase}`,
							),
						],
					});
				} else if (item.target === "case-list-registration") {
					const address = resolveModuleAddress(doc, item);
					if (!address.ok) {
						failures.push(`items[${i}]: ${address.error}`);
						continue;
					}
					const mod = address.module;
					const stored = alwaysOfferedRegistrationOf(doc, mod.uuid);
					if (stored === undefined) {
						failures.push(
							`items[${i}]: Module "${mod.name}" offers no registration form on its case list, so there is no Register button to set media on. You can offer one with register_from_case_list on update_module.`,
						);
						continue;
					}
					const carrierPhrase = `the Register button on ${mod.name}'s case list`;
					const icon = resolveIconInput(
						item.icon,
						`the icon on ${carrierPhrase}`,
					);
					const { icon: _icon, audioLabel: _audioLabel, ...kept } = stored;
					const plan = alwaysOfferedRegistrationMutations(doc, mod.uuid, {
						...kept,
						...(icon.icon !== null && { icon: icon.icon }),
						...(item.audioLabel !== null && { audioLabel: item.audioLabel }),
					});
					if (plan.kind === "blocked") {
						failures.push(`items[${i}]: ${plan.message}`);
						continue;
					}
					resolved.push({
						mutations: plan.mutations,
						expectations: [
							...icon.expectations,
							...slotExpectation(
								item.audioLabel,
								"audio",
								`the audio label on ${carrierPhrase}`,
							),
						],
					});
				} else {
					const address = resolveFormAddress(doc, item);
					if (!address.ok) {
						failures.push(`items[${i}]: ${address.error}`);
						continue;
					}
					const form = address.form;
					const carrierPhrase = `form "${form.name}"`;
					const icon = resolveIconInput(
						item.icon,
						`the icon on ${carrierPhrase}`,
					);
					resolved.push({
						mutations: setFormMediaMutations(
							form.uuid,
							icon.icon,
							item.audioLabel,
						),
						expectations: [
							...icon.expectations,
							...slotExpectation(
								item.audioLabel,
								"audio",
								`the audio label on ${carrierPhrase}`,
							),
						],
					});
				}
			}

			// Each item emits its carrier's mutation so that a clear survives
			// the SSE wire and the persisted row. A tile emits its dedicated
			// kind (`setModuleMedia` / `setFormMedia`), whose clear is an
			// explicit `null` (an `update*` patch would encode it as
			// `{ icon: undefined }`, which `JSON.stringify` drops). A case
			// list item emits `setCaseListMenuItem` with the entry whole, and
			// a Register button the `updateModule` of
			// `alwaysOfferedRegistrationMutations` with the slot whole, so a
			// cleared slot is an absent key of a whole value.
			const outcome = await commitMediaBatch({
				ctx,
				doc,
				stage: "media:menu",
				resolved,
				failures,
				attemptPhrase: `set menu media on ${countPhrase(items.length)}`,
				itemNoun: "item",
				outcomeVerb: "set",
			});
			if (!outcome.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: outcome.error },
				};
			}

			return {
				kind: "mutate" as const,
				mutations: outcome.mutations,
				result: {
					ok: true,
					summary: { count: items.length },
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};

/** "1 tile" / "4 tiles". */
function countPhrase(n: number): string {
	return `${n} ${n === 1 ? "tile" : "tiles"}`;
}
