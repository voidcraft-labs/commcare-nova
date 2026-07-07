/**
 * Shared input schemas + helpers for the dedicated media SA tools.
 *
 * The generic field-mutation tools (`addFields` / `editField`) and the
 * case-list-config tools deliberately OMIT every media slot — the SA can
 * neither mint nor discover an asset id from those surfaces, so exposing
 * a media slot there would only let the model write a dangling reference.
 * The media tools in this package are the dedicated authoring surface:
 * the SA discovers asset ids via `list_media_assets`, then attaches them
 * to a carrier through one of the `attach*` / `set*` tools here.
 *
 * Two carrier families, two slot shapes:
 *
 *   - **Field + option carriers** (a field's label / hint / help /
 *     validation message, and select options) take a full `Media` bundle
 *     — image + audio + video, any subset. `mediaSchema` is the single
 *     source of truth for that bundle; the tools reuse it directly.
 *   - **Menu carriers** (module / form menu tiles, app logo) take only
 *     direct `AssetId` slots (image + audio, or just image for the logo)
 *     — see `lib/domain/multimedia.ts::mediaSchema`'s docstring for why
 *     menu carriers don't use the bundle.
 *
 * Every attach runs the at-source asset verdict BEFORE its gated commit
 * (`attachGuardedMutate` below → `lib/media/attachVerdicts.ts`): the
 * asset must exist in the caller's library, be `ready`, match the slot's
 * kind, and keep the app's referenced-media aggregate inside the export
 * ceiling — so a committed reference can't dangle, and the export
 * boundary's media rules become defense-in-depth (legacy refs, ops
 * disasters) rather than the gate a live attach relies on. Clears carry
 * no expectations and skip the asset read entirely.
 * (`remove_media_asset` is the deletion-side twin — it refuses to orphan
 * a live reference at the source.)
 */

import { z } from "zod";
import { loadAppProjectId } from "@/lib/db/apps";
import type { Mutation } from "@/lib/doc/types";
import {
	type AssetId,
	type BlueprintDoc,
	builtinIconRef,
	type IconSlug,
	iconCatalogEntry,
	type Media,
	mediaSchema,
	parseBuiltinIconSlug,
} from "@/lib/domain";
import {
	type MediaAttachExpectation,
	mediaAttachVerdict,
} from "@/lib/media/attachVerdicts";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { type GuardedMutateOutcome, guardedMutate } from "../common";

/**
 * The full image/audio/video bundle carried by question-message slots and
 * select options. Reuses the domain `mediaSchema` verbatim so the tool
 * boundary and the stored shape can't drift — `mediaSchema` is
 * `.strict()` with three optional `assetIdSchema` slots, none of which
 * carries a `.transform()`, so it lowers cleanly to JSON Schema for the
 * Anthropic compiler.
 *
 * Clearing a slot is "omit it from the bundle" — an absent key resolves
 * to `undefined` and the carrier drops the reference. Passing an empty
 * bundle (`{}`) clears every slot.
 */
export const mediaBundleInput = (description: string) =>
	mediaSchema.describe(description);

/**
 * A single asset-id slot for the menu carriers (module / form icon +
 * audio label, app logo). `assetIdSchema` is a plain non-empty string at
 * runtime (the `AssetId` brand is compile-time only), so it lowers to
 * JSON Schema cleanly. Tool bodies cast the parsed value to `AssetId`
 * before threading it into the branded mutation builders.
 *
 * The SA passes `null` to clear the slot and a non-null asset id to set
 * it — a required-and-nullable shape that removes the "absent vs null"
 * ambiguity (the SA always states intent explicitly). Tool bodies map
 * `null → null` straight through to the mutation builders, which clear.
 */
export const nullableAssetSlot = (description: string) =>
	z.string().min(1).nullable().describe(description);

/**
 * The icon slot for a menu carrier (module / form tile). Unlike a plain
 * `nullableAssetSlot`, it accepts EITHER a built-in icon slug (the listed
 * enum — the common path, no upload needed) OR an uploaded image's asset id
 * (any other string), OR `null` to clear. Built-in icons are the library Nova
 * ships; the SA picks one by name, no `list_media_assets` round-trip. The
 * `anyOf` carries the slug list so the model sees the choices while still
 * allowing an asset-id string. `resolveIconInput` disambiguates at runtime.
 */
export const nullableIconSlot = (
	slugs: readonly [string, ...string[]],
	description: string,
) =>
	z
		.union([z.enum(slugs), z.string().min(1)])
		.nullable()
		.describe(description);

/**
 * Cast a parsed nullable asset-slot value to the branded `AssetId | null`
 * the mutation builders expect. The runtime value is already a string (or
 * null); the cast only re-applies the compile-time brand the wire schema
 * drops. Centralized here so every menu-media tool brands its slots the
 * same way.
 */
export function brandAssetSlot(value: string | null): AssetId | null {
	return value as AssetId | null;
}

/**
 * Cast a parsed `Media` bundle's slot values to the branded `Media`
 * shape. `mediaSchema` parses each slot to a plain string; the doc stores
 * `AssetId`, whose brand is compile-time only — so the parsed value is
 * structurally identical and the cast just re-applies the brand. Returns
 * the bundle unchanged at runtime.
 */
export function brandMediaBundle(bundle: z.infer<typeof mediaSchema>): Media {
	return bundle as Media;
}

/**
 * The four field-message slots a `Media` bundle can attach to. Mirrors
 * the `*_media` keys on the field schema bases (`label_media` /
 * `hint_media` / `help_media` / `validate_msg_media`) — the SA names the
 * slot by its message role (`label` / `hint` / `help` / `validate_msg`),
 * and the tool maps it to the `<slot>_media` key. `required` is
 * deliberately absent: CommCare's runtime parses no `jr:requiredMsg`, so
 * there is no `required_msg_media` slot to target.
 */
export const FIELD_MEDIA_SLOTS = [
	"label",
	"hint",
	"help",
	"validate_msg",
] as const;
export type FieldMediaSlot = (typeof FIELD_MEDIA_SLOTS)[number];

/** The `<slot>_media` field key a `FieldMediaSlot` maps to. */
export type FieldMediaKey = `${FieldMediaSlot}_media`;

/** Map a slot name to its `<slot>_media` field key. */
export function mediaKeyForSlot(slot: FieldMediaSlot): FieldMediaKey {
	return `${slot}_media`;
}

/**
 * The expectations a `Media` bundle's SET slots impose — one per
 * populated kind, each naming the carrier (`carrierPhrase`, e.g.
 * `the label media on field "x"`) so a rejection points at the exact
 * slot. An empty bundle (a clear) imposes none.
 */
export function bundleExpectations(
	media: Media,
	carrierPhrase: string,
): MediaAttachExpectation[] {
	const out: MediaAttachExpectation[] = [];
	if (media.image !== undefined) {
		out.push({
			assetId: media.image,
			kind: "image",
			slot: `the image on ${carrierPhrase}`,
		});
	}
	if (media.audio !== undefined) {
		out.push({
			assetId: media.audio,
			kind: "audio",
			slot: `the audio on ${carrierPhrase}`,
		});
	}
	if (media.video !== undefined) {
		out.push({
			assetId: media.video,
			kind: "video",
			slot: `the video on ${carrierPhrase}`,
		});
	}
	return out;
}

/**
 * The expectation a single nullable asset slot imposes — present iff the
 * call SETS the slot (a `null` clear imposes none). `slotPhrase` names
 * the carrier slot itself (`the icon on module "x"`).
 */
export function slotExpectation(
	value: string | null,
	kind: MediaAttachExpectation["kind"],
	slotPhrase: string,
): MediaAttachExpectation[] {
	return value === null ? [] : [{ assetId: value, kind, slot: slotPhrase }];
}

/**
 * Resolve a menu-tile icon input (from `nullableIconSlot`) into the `AssetId`
 * the mutation stores plus the attach expectation it imposes:
 *
 *   - a value matching a built-in icon slug → the reserved `nova-icon:<slug>`
 *     ref and NO expectation. Built-ins have no library row — they're always a
 *     ready image, resolved from the shipped set at emit — so the at-source
 *     verdict (which reads Firestore) must not run for them. An empty
 *     expectation list is exactly what skips it.
 *   - a STORED built-in ref (`nova-icon:<slug>`, a valid catalog slug) → the
 *     ref unchanged, NO expectation. This is the echo-back path: the SA
 *     preserves a tile's current icon by reading it (getModule / getForm) and
 *     passing the stored value back, so the stored form must round-trip. A
 *     STALE prefixed ref (slug gone from the catalog) falls through to the
 *     uploaded-id arm and fails closed at the verdict, like any dangling ref.
 *   - any other non-null value → an uploaded asset id: branded, with the
 *     standard image expectation so the verdict checks it exists / is ready.
 *   - `null` → clear, no expectation.
 *
 * Slugs and uploaded asset-id UUIDs can't collide, so catalog membership is a
 * sound discriminator.
 */
export function resolveIconInput(
	value: string | null,
	slotPhrase: string,
): { icon: AssetId | null; expectations: MediaAttachExpectation[] } {
	if (value === null) return { icon: null, expectations: [] };
	if (iconCatalogEntry(value)) {
		return { icon: builtinIconRef(value as IconSlug), expectations: [] };
	}
	if (parseBuiltinIconSlug(value)) {
		return { icon: brandAssetSlot(value), expectations: [] };
	}
	return {
		icon: brandAssetSlot(value),
		expectations: [{ assetId: value, kind: "image", slot: slotPhrase }],
	};
}

/**
 * Resolve the Project an SA media tool operates in — the app's Project (media's
 * tenant). Throws a consistent, actionable error when the app carries no
 * Project; every app has one post-migration, so a missing one is an internal
 * inconsistency, not a user action. The read tools (`listMediaAssets` /
 * `removeMediaAsset`) let it propagate to the tool runner; `attachGuardedMutate`
 * resolves inline because it reports the failure in its `{ ok: false }`
 * contract rather than throwing.
 */
export async function requireToolProjectId(appId: string): Promise<string> {
	const projectId = await loadAppProjectId(appId);
	if (!projectId) {
		throw new Error(
			`Couldn't find the Project for app "${appId}". The app row may be missing its project_id.`,
		);
	}
	return projectId;
}

/**
 * One resolved item of a batch media tool: the mutations it emits, the
 * verdict expectations its set slots impose, and the line the success
 * message reports for it. Tools that need extra per-item facts for their
 * summary (e.g. `attachFieldMedia`'s distinct-field count) intersect this
 * with their own field.
 */
export interface ResolvedMediaBatchItem {
	mutations: Mutation[];
	expectations: MediaAttachExpectation[];
	line: string;
}

/** Outcome of {@link commitMediaBatch}: the committed doc + the flattened
 *  mutation batch, or the error string for the tool's `{ error }` envelope. */
export type MediaBatchOutcome =
	| { ok: true; newDoc: BlueprintDoc; mutations: Mutation[] }
	| { ok: false; error: string };

/**
 * The shared tail of every batch media tool. The batch is all-or-nothing:
 * unresolved items are reported as ONE error naming them all (so the SA
 * repairs the whole call at once instead of discovering them one by one);
 * a clean batch flattens its mutations + expectations into a single
 * verdict-guarded, gated commit.
 *
 * `attemptPhrase` names what the call tried ("set menu media on 3 tiles");
 * `itemNoun` is the entry noun the failure count uses ("item",
 * "attachment"); `outcomeVerb` completes "nothing was <verb>" ("set",
 * "attached").
 */
export async function commitMediaBatch(args: {
	ctx: ToolExecutionContext;
	doc: BlueprintDoc;
	stage: string;
	resolved: readonly ResolvedMediaBatchItem[];
	failures: readonly string[];
	attemptPhrase: string;
	itemNoun: string;
	outcomeVerb: string;
}): Promise<MediaBatchOutcome> {
	const { ctx, doc, stage, resolved, failures } = args;
	if (failures.length > 0) {
		const count =
			failures.length === 1
				? `one ${args.itemNoun}`
				: `${failures.length} ${args.itemNoun}s`;
		return {
			ok: false,
			error: `Tried to ${args.attemptPhrase}, but the batch commits as a whole and ${count} didn't resolve — nothing was ${args.outcomeVerb}:\n${failures.join("\n")}`,
		};
	}
	const mutations = resolved.flatMap((r) => r.mutations);
	const commit = await attachGuardedMutate(
		ctx,
		doc,
		mutations,
		stage,
		resolved.flatMap((r) => r.expectations),
	);
	if (!commit.ok) return { ok: false, error: commit.error };
	return { ok: true, newDoc: commit.newDoc, mutations };
}

/** Join a batch's per-item lines into one sentence-cased success message. */
export function joinBatchLines(lines: readonly string[]): string {
	const joined = `${lines.join("; ")}.`;
	return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * The one commit path for the attach tools: run the at-source asset
 * verdict over `expectations` (exists / owned / ready / kind-matched /
 * inside the export ceiling — `lib/media/attachVerdicts.ts`), then the
 * standard validity-gated commit. The expectations ride through to
 * `ctx.recordMutations` so the MCP surface re-verifies them inside its
 * transactional save. A verdict failure returns the same `{ ok: false }`
 * shape as a gate rejection — the tool surfaces it in its `{ error }`
 * envelope and nothing is written.
 *
 * Clears pass an empty `expectations` and skip the asset read entirely.
 */
export async function attachGuardedMutate(
	ctx: ToolExecutionContext,
	doc: BlueprintDoc,
	mutations: Mutation[],
	stage: string,
	expectations: readonly MediaAttachExpectation[],
): Promise<GuardedMutateOutcome> {
	if (expectations.length > 0) {
		/* The attach verdict scopes to the app's Project (media's tenant), so an
		 * asset must belong to THIS app's Project to attach — resolved from the
		 * app the tool operates on. */
		const projectId = await loadAppProjectId(ctx.appId);
		if (!projectId) {
			return {
				ok: false,
				error:
					"This app has no Project, so its media can't be verified. Reload and try again.",
			};
		}
		const verdict = await mediaAttachVerdict({
			projectId,
			doc,
			expectations,
		});
		if (!verdict.ok) return { ok: false, error: verdict.error };
	}
	return guardedMutate(ctx, doc, mutations, stage, expectations);
}
