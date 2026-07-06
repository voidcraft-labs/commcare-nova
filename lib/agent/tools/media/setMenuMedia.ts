/**
 * SA tool: `set_menu_media` — set or clear menu media on one or more menu
 * tiles (module home-screen tiles and per-form menu tiles) in a single
 * call: each tile's `icon` (image) and `audioLabel` (audio prompt).
 *
 * Menu carriers take image + audio only (no video — see
 * `lib/domain/multimedia.ts::mediaSchema`'s docstring). One list-taking
 * tool covers both carrier levels — there is no per-module or per-form
 * twin (the no-singular-twin rule: one tile is a length-1 `items` array).
 * An app's whole menu — every module and form tile — sets in ONE call,
 * which is also what lets the model see sibling tiles side by side when
 * it picks icons (the prompt's vary-within-a-screen guidance leans on
 * this). Each item is discriminated by `target`: the module arm offers
 * the topic-icon slugs, the form arm the action-icon slugs.
 *
 * Both slots are set per item; each is required-and-nullable so the SA
 * states intent explicitly (an asset id or built-in slug sets the slot,
 * `null` clears it). To touch only one slot, read the other's current
 * value — `getModule` surfaces every tile's stored `icon` /
 * `audio_label`, `getForm` a form's — and pass it back verbatim
 * (`resolveIconInput` round-trips a stored `nova-icon:<slug>` ref
 * unchanged).
 *
 * The batch is all-or-nothing (`commitMediaBatch`): every item must
 * resolve (module / form exists) and every set slot must pass the
 * at-source asset verdict (exists / owned / ready / kind-matched / inside
 * the export ceiling) before the single gated commit; any failure returns
 * `{ error }` naming every offending item and nothing is written. Two
 * items addressing the same tile apply in order — the later one wins.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext`.
 */

import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import {
	type AssetId,
	type BlueprintDoc,
	FORM_ICON_SLUGS,
	MODULE_ICON_SLUGS,
} from "@/lib/domain";
import {
	resolveFormUuid,
	resolveModuleUuid,
	setFormMediaMutations,
	setModuleMediaMutations,
} from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { type MutatingToolResult, toToolErrorResult } from "../common";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	brandAssetSlot,
	commitMediaBatch,
	nullableAssetSlot,
	nullableIconSlot,
	type ResolvedMediaBatchItem,
	resolveIconInput,
	slotExpectation,
} from "./shared";

const moduleMenuItemSchema = z
	.object({
		target: z.literal("module").describe("A module's home-screen tile"),
		moduleIndex: z.number().describe("0-based module index"),
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

const formMenuItemSchema = z
	.object({
		target: z.literal("form").describe("A form's menu tile"),
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index within the module"),
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

export const setMenuMediaInputSchema = z
	.object({
		items: z
			.array(
				z.discriminatedUnion("target", [
					moduleMenuItemSchema,
					formMenuItemSchema,
				]),
			)
			.min(1)
			.describe(
				"The menu tiles to set, each a module tile (`target: module`) or a " +
					"form tile (`target: form`). Set every tile you're styling in ONE " +
					"call — the whole app's menu icons fit in a single batch. Both " +
					"slots are stated per tile: an icon slug / asset id sets, null " +
					"clears. The batch commits as a whole.",
			),
	})
	.strict();

export type SetMenuMediaInput = z.infer<typeof setMenuMediaInputSchema>;

export type SetMenuMediaResult = MutationSuccess | { error: string };

export const setMenuMediaTool = {
	description:
		"Set or clear menu media on one or more menu tiles in a single call — module home-screen tiles and form menu tiles, mixed freely (set the whole app's menu in one batch). Each item sets both slots of one tile: the icon (a built-in icon slug like household or register, or an uploaded image's asset id from list_media_assets) and the audio label (an audio asset id); null clears either. To preserve a tile's current slot, pass back the stored value from getModule / getForm. Menu tiles carry image + audio only, no video.",
	inputSchema: setMenuMediaInputSchema,
	async execute(
		input: SetMenuMediaInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetMenuMediaResult>> {
		const { items } = input;
		try {
			// Resolve every item before writing anything, collecting every
			// failure — `commitMediaBatch` reports them as one all-or-nothing
			// error. The two arms differ only in target resolution, the
			// mutation builder, and the carrier phrase; `resolveTile` carries
			// the shared shape.
			const resolved: ResolvedMediaBatchItem[] = [];
			const failures: string[] = [];
			const resolveTile = (
				item: SetMenuMediaInput["items"][number],
				carrierPhrase: string,
				buildMutations: (
					icon: AssetId | null,
					audioLabel: AssetId | null,
				) => Mutation[],
			): ResolvedMediaBatchItem => {
				const icon = resolveIconInput(
					item.icon,
					`the icon on ${carrierPhrase}`,
				);
				return {
					mutations: buildMutations(icon.icon, brandAssetSlot(item.audioLabel)),
					expectations: [
						...icon.expectations,
						...slotExpectation(
							item.audioLabel,
							"audio",
							`the audio label on ${carrierPhrase}`,
						),
					],
					line: `${carrierPhrase}: icon ${describeSlot(item.icon)}, audio label ${describeSlot(item.audioLabel)}`,
				};
			};
			for (const [i, item] of items.entries()) {
				if (item.target === "module") {
					const moduleUuid = resolveModuleUuid(doc, item.moduleIndex);
					const mod = moduleUuid ? doc.modules[moduleUuid] : undefined;
					if (!mod) {
						failures.push(
							`items[${i}]: found no module at index ${item.moduleIndex}. Look at getModule's projection for valid indices.`,
						);
						continue;
					}
					resolved.push(
						resolveTile(item, `module "${mod.name}"`, (icon, audioLabel) =>
							setModuleMediaMutations(mod.uuid, icon, audioLabel),
						),
					);
				} else {
					const formUuid = resolveFormUuid(
						doc,
						item.moduleIndex,
						item.formIndex,
					);
					const form = formUuid ? doc.forms[formUuid] : undefined;
					if (!form) {
						failures.push(
							`items[${i}]: found no form at m${item.moduleIndex}-f${item.formIndex}. Run getModule to see the module's forms and their indices.`,
						);
						continue;
					}
					resolved.push(
						resolveTile(item, `form "${form.name}"`, (icon, audioLabel) =>
							setFormMediaMutations(form.uuid, icon, audioLabel),
						),
					);
				}
			}

			// Each item emits its carrier's dedicated mutation kind
			// (`setModuleMedia` / `setFormMedia`): a clear must ride the SSE
			// wire as an explicit `null` (the reducer maps it to `undefined`)
			// — an `update*` patch would encode it as `{ icon: undefined }`,
			// which `JSON.stringify` drops, leaving the stale ref on the
			// client.
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
					newDoc: doc,
					result: { error: outcome.error },
				};
			}

			return {
				kind: "mutate" as const,
				mutations: outcome.mutations,
				newDoc: outcome.newDoc,
				result: {
					message: `Set menu media on ${countPhrase(items.length)} — ${resolved.map((r) => r.line).join("; ")}.`,
					summary: { count: items.length },
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};

/** Render a slot's intent for the summary: cleared vs the set value
 *  (a built-in slug or an uploaded asset id, echoed as supplied). */
function describeSlot(value: string | null): string {
	return value === null ? "cleared" : `set to ${value}`;
}

/** "1 tile" / "4 tiles". */
function countPhrase(n: number): string {
	return `${n} ${n === 1 ? "tile" : "tiles"}`;
}
