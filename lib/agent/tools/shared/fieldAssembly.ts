/**
 * Shared field-batch assembly — the one pipeline that turns the SA's flat
 * per-kind field items into `addField` mutations, used by every tool that
 * lands fields (`addFields` on an existing form; `createForm` /
 * `createModule` on a form minted in the same batch).
 *
 * Per item: sentinel strip (`stripEmpty`) → case-type default merge
 * (`applyDefaults`) → uuid mint → domain `Field` assembly
 * (`flatFieldToField`) → the shared identifier verdict
 * (`lib/doc/identifierVerdicts.ts` — XML-name legality, the reserved
 * `__nova_` prefix, the case-property length cap, sibling uniqueness
 * against the doc AND this batch's earlier items). Parent resolution
 * covers containers minted earlier in the same batch (`mintedByBareId`)
 * before falling back to the doc-wide lookup, so a group + its children
 * compose in one call.
 *
 * The insertion root (`formUuid`) does not have to exist on `doc` yet —
 * a form minted by an `addForm` mutation earlier in the same batch has no
 * `fieldOrder` entry, which reads as "no existing siblings", exactly
 * right for a brand-new form.
 *
 * One identifier rejection fails the WHOLE assembly (`ok: false`) with
 * every failing item named, so the agent fixes them in one re-issue —
 * a partial batch would leave it guessing which fields landed.
 */

import { parseXPathExpression } from "@/lib/commcare/xpath";
import {
	type FieldRefResolvableDoc,
	resolveCloseFieldRef,
} from "@/lib/doc/expressionText";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import { fieldIdVerdict } from "@/lib/doc/identifierVerdicts";
import { keyBetween, keysForSlot } from "@/lib/doc/order/keys";
import { keyedOptions } from "@/lib/doc/order/options";
import { declareCaseTypeMutations } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	Field,
	ResolveFieldPath,
	Uuid,
	XPathExpression,
	XPathPrintableDoc,
} from "@/lib/domain";
import {
	asUuid,
	fieldCasePropertyOn,
	fieldPathResolver,
	isContainer,
	opaqueXPathExpression,
	type SelectOption,
} from "@/lib/domain";
import { resolveFieldInForm } from "../../blueprintHelpers";
import {
	applyDefaults,
	type FlatField,
	flatFieldToField,
	stripEmpty,
	unescapeXPath,
} from "../../contentProcessing";

export interface FieldAssemblyArgs {
	/** The doc the batch will apply to — parent lookups + sibling scans. */
	doc: BlueprintDoc;
	/** Insertion root: an existing form's uuid, or the uuid of a form an
	 *  earlier mutation in the same batch creates. */
	formUuid: Uuid;
	/** The SA's flat field items, in order. */
	items: readonly FlatField[];
	/** Default parent for the batch (a group/repeat's bare id). A field's
	 *  own `parentId` overrides it. */
	batchParentId?: string;
	/** Insertion anchor for the batch's top-level block — only meaningful
	 *  against an EXISTING form (a new form has nothing to anchor to). */
	anchor?: { beforeFieldId?: string; afterFieldId?: string };
}

export type FieldAssemblyResult =
	| {
			ok: true;
			mutations: Mutation[];
			/** Items that didn't assemble into a valid Field for their kind —
			 *  reported, never silently dropped. */
			skipped: Array<{ id: string; reason: string }>;
			/**
			 * Parse expression TEXT against the doc PLUS this batch's planned
			 * tree — the same resolution context the landed fields' own
			 * expression slots were re-parsed in. The creation tools route
			 * their form-level XPath inputs (the Connect bindings, via
			 * `buildConnectConfig`) through this so a reference to a field
			 * landing in the same call resolves to an identity leaf, exactly
			 * as it would once the batch has applied.
			 */
			parseExpression: (text: string) => XPathExpression;
			/**
			 * Resolve a bare field id to the target field's stable uuid over
			 * the same doc-plus-batch overlay (pre-order first match — the
			 * `resolveCloseFieldRef` rule). The creation tools resolve a
			 * form's `close_condition.field` through this, so the condition
			 * can name a field landing in the same call. An id nothing
			 * answers to comes back verbatim, and the commit gate rejects
			 * the introduction with the validator's close-condition finding.
			 */
			resolveFieldRef: (ref: string) => Uuid | string;
	  }
	| {
			ok: false;
			/** Every item the identifier verdict refused, with its reason. */
			rejected: Array<{ id: string; reason: string }>;
	  };

/**
 * Resolve a creation tool's `close_condition` input to the stored
 * `closeCondition` shape: the authored field id resolves to the target's
 * uuid through the assembly's `resolveFieldRef` (the same doc-plus-batch
 * overlay the batch's expressions used, so the condition may name a field
 * landing in this call; an unresolved id stays verbatim and the gate
 * rejects it with the validator's close-condition finding). One resolver
 * for both creation surfaces — `createForm` and `createModule` — so the
 * two cannot drift. Returns `undefined` for an absent/null input (an
 * unconditional close).
 */
export function resolveCloseCondition(
	resolveFieldRef: (ref: string) => Uuid | string,
	input:
		| { field: string; answer: string; operator?: "=" | "selected" | null }
		| null
		| undefined,
): { field: Uuid; answer: string; operator?: "=" | "selected" } | undefined {
	if (input == null) return undefined;
	return {
		field: asUuid(resolveFieldRef(input.field)),
		answer: input.answer,
		...(input.operator && { operator: input.operator }),
	};
}

export function assembleFieldMutations(
	args: FieldAssemblyArgs,
): FieldAssemblyResult {
	const { doc, formUuid, items, batchParentId, anchor } = args;

	// Resolve the batch's insertion parent — the form root, or the
	// batch-level `parentId` when it names an existing container (mirrors
	// the per-field fallback in the loop). When an anchor is given, find
	// the index in that parent's CURRENT order where the batch's top-level
	// block should start; `topLevelNextIndex` then walks forward as each
	// top-level field is placed, so the inserted fields land contiguously
	// in batch order. A field carrying its OWN parentId nests under that
	// parent and never consumes an anchor slot.
	let batchInsertParent: Uuid = formUuid;
	if (batchParentId) {
		const existing = resolveFieldInForm(doc, formUuid, batchParentId);
		// An AMBIGUOUS parent ref (or a uuid living in another form) fails
		// the whole call — silently nesting the batch under the depth-first
		// duplicate is the wrong-target class the field tools refuse, and a
		// parent slot must refuse it identically. A missing parent keeps the
		// legacy fall-through to form level, as does a leaf: only a
		// container can be a parent — nesting under a leaf would make every
		// batch field invisible to the emitter.
		if (!existing.ok && existing.reason !== "not_found") {
			return {
				ok: false,
				rejected: [{ id: batchParentId, reason: existing.error }],
			};
		}
		if (existing.ok && isContainer(existing.field)) {
			batchInsertParent = existing.field.uuid;
		}
	}
	let topLevelNextIndex: number | undefined;
	if (anchor?.beforeFieldId || anchor?.afterFieldId) {
		const order = orderedFieldUuids(doc, batchInsertParent);
		if (anchor.beforeFieldId) {
			const i = order.findIndex(
				(u) => doc.fields[u]?.id === anchor.beforeFieldId,
			);
			if (i !== -1) topLevelNextIndex = i;
		} else if (anchor.afterFieldId) {
			const i = order.findIndex(
				(u) => doc.fields[u]?.id === anchor.afterFieldId,
			);
			if (i !== -1) topLevelNextIndex = i + 1;
		}
	}
	// The anchor's start slot in the parent's DISPLAY order, captured BEFORE
	// the placement loop advances `topLevelNextIndex` — the second-pass order
	// minting keys the anchored block BETWEEN the neighbors at this slot.
	const anchorStartIndex = topLevelNextIndex;

	// `mintedByBareId` records only containers added earlier in this batch
	// so a later item's `parentId` can resolve to them; `pendingByParent`
	// carries the ids earlier items claimed per parent (they aren't in
	// `doc` yet), so two new siblings can't land with the same id.
	// `dupMintedIds` tracks a container id minted TWICE in this batch
	// (legal — sibling uniqueness is per parent level, so two same-id
	// groups under different parents both pass the verdict): a later
	// `parentId` naming it is refused rather than silently resolved to
	// whichever container the map happened to keep.
	const mintedByBareId = new Map<string, Uuid>();
	const dupMintedIds = new Set<string>();
	const mutations: Mutation[] = [];
	const skipped: Array<{ id: string; reason: string }> = [];
	const rejected: Array<{ id: string; reason: string }> = [];
	const pendingByParent = new Map<Uuid, Set<string>>();
	// Expression slots resolve in a SECOND pass against the whole
	// batch's planned tree (a calculate may reference a field that lands
	// later in the same call), so assembly first installs the authored
	// text as opaque runs and `resolveBatchExpressions` re-parses each
	// landed field's slots once every sibling is known.
	const landed: Array<{ field: Field; processed: Partial<FlatField> }> = [];

	for (const raw of items) {
		// `stripEmpty` narrows `parentId?: string | null` (sentinel empty
		// string → null) and `applyDefaults` preserves that narrowing while
		// merging case-type metadata onto the field.
		const processed = applyDefaults(stripEmpty(raw), doc.caseTypes);

		// Resolve parentUuid: the field's OWN `parentId` wins; if it didn't
		// set one, fall back to the batch-level `parentId`; if neither is
		// set, the field lands at the form's top level.
		let parentUuid: Uuid = formUuid;
		const parentId = processed.parentId ?? batchParentId;
		if (parentId && typeof parentId === "string") {
			const minted = mintedByBareId.get(parentId);
			if (minted) {
				// A same-call parent ref must have exactly ONE viable
				// referent. Two same-id containers minted in this batch, or
				// a minted container shadowing an EXISTING container with
				// the same id, are both silent-wrong-parent hazards — refuse
				// them like every other ambiguous field ref. An existing
				// LEAF with the id doesn't refuse: a leaf can't be a parent,
				// so the minted container is the only viable referent.
				if (dupMintedIds.has(parentId)) {
					rejected.push({
						id: raw.id,
						reason: `parentId "${parentId}": this call adds more than one container with that id — give the new containers distinct ids so the reference is unambiguous.`,
					});
					continue;
				}
				const shadowed = resolveFieldInForm(doc, formUuid, parentId);
				if (
					(shadowed.ok && isContainer(shadowed.field)) ||
					(!shadowed.ok && shadowed.reason === "ambiguous")
				) {
					rejected.push({
						id: raw.id,
						reason: `parentId "${parentId}": a container added in this call and an existing field in the form share that id — rename the container this call adds, or pass the existing container's uuid.`,
					});
					continue;
				}
				parentUuid = minted;
			} else {
				const existing = resolveFieldInForm(doc, formUuid, parentId);
				// An ambiguous parent ref (or a foreign-form uuid) rejects
				// this item — same refusal contract as the batch-level
				// parent above, reported per item so one corrected re-issue
				// suffices.
				if (!existing.ok && existing.reason !== "not_found") {
					rejected.push({
						id: raw.id,
						reason: `parentId "${parentId}": ${existing.error}`,
					});
					continue;
				}
				if (existing.ok && isContainer(existing.field)) {
					parentUuid = existing.field.uuid;
				}
				// A non-existent parentId, or one naming a non-container
				// (a leaf field), falls through to form-level insert.
				// Never nest under a leaf: the reducer would create a
				// child order under it and the emitter — which only
				// recurses into containers — would silently drop the
				// field.
			}
		}

		const fieldUuid = asUuid(crypto.randomUUID());
		const assembled = flatFieldToField(
			processed,
			fieldUuid,
			opaqueXPathExpression,
		);
		if (!assembled.ok) {
			// The payload didn't assemble into a valid Field for its kind.
			// Carry the specific reason so the caller reports WHY each field
			// was skipped, not just that it was.
			skipped.push({ id: raw.id, reason: assembled.reason });
			continue;
		}
		const field = assembled.field;

		// Pre-dispatch identifier guard. A rejected field claims nothing —
		// it never joins the pending scope or the minted-parent lookup.
		const pending = pendingByParent.get(parentUuid);
		const verdict = fieldIdVerdict({
			doc,
			parentUuid,
			proposedId: field.id,
			pendingSiblingIds: pending,
		});
		if (!verdict.ok) {
			rejected.push({ id: field.id, reason: verdict.message });
			continue;
		}
		if (pending) pending.add(field.id);
		else pendingByParent.set(parentUuid, new Set([field.id]));

		if (isContainer(field)) {
			// Keep the FIRST minted uuid per id — once the id is marked
			// duplicated, any later ref to it is refused, so which uuid the
			// map holds no longer matters.
			if (mintedByBareId.has(field.id)) dupMintedIds.add(field.id);
			else mintedByBareId.set(field.id, fieldUuid);
		}
		// Top-level batch fields honor the anchor (a contiguous block at
		// the resolved index, walking forward per field); everything else
		// — fields nested under their own parentId, or any field when no
		// anchor was given — appends.
		if (topLevelNextIndex !== undefined && parentUuid === batchInsertParent) {
			mutations.push({
				kind: "addField",
				parentUuid,
				field,
				index: topLevelNextIndex,
			});
			topLevelNextIndex += 1;
		} else {
			mutations.push({ kind: "addField", parentUuid, field });
		}
		landed.push({ field, processed });
	}

	if (rejected.length > 0) return { ok: false, rejected };
	const overlay = buildBatchOverlay(doc, formUuid, mutations);
	const resolve = fieldPathResolver(overlay, formUuid);
	resolveBatchExpressions(resolve, landed);
	// Mint an `order` key for every born field. An ANCHORED batch (a top-level
	// block placed at `beforeFieldId` / `afterFieldId`) keys its fields BETWEEN
	// the anchor's DISPLAY neighbors — the same neighbor bounds the builder's
	// `orderKeyForFieldSlot` uses — so the insert lands AT the anchor in display
	// order, not appended. Every other field (nested under its own parentId, or
	// any field when no anchor was given) appends after its parent's existing
	// fields, advancing per field so the batch's fields to one parent keep their
	// authored order. A field born keyless would sort ahead of / behind a later
	// keyed sibling until a reload's backfill, so the key is assigned at
	// construction. A minted container parent (added earlier in this same batch)
	// has no existing doc fields, so its children seed a fresh sequence.
	let anchorKeys: string[] | undefined;
	if (anchorStartIndex !== undefined) {
		const siblingKeys = orderedFieldUuids(doc, batchInsertParent)
			.map((u) => doc.fields[u]?.order)
			.filter((o): o is string => o !== undefined);
		const anchoredCount = mutations.filter(
			(m) => m.kind === "addField" && m.parentUuid === batchInsertParent,
		).length;
		anchorKeys = keysForSlot(siblingKeys, anchorStartIndex, anchoredCount);
	}
	const lastOrderByParent = new Map<string, string | null>();
	let anchorCursor = 0;
	for (const mut of mutations) {
		if (mut.kind !== "addField") continue;
		let order: string;
		if (anchorKeys !== undefined && mut.parentUuid === batchInsertParent) {
			order = anchorKeys[anchorCursor];
			anchorCursor += 1;
		} else {
			let last = lastOrderByParent.get(mut.parentUuid);
			if (last === undefined) {
				const keys = orderedFieldUuids(doc, mut.parentUuid)
					.map((u) => doc.fields[u]?.order)
					.filter((o): o is string => o !== undefined);
				last = keys.at(-1) ?? null;
			}
			order = keyBetween(last, null);
			lastOrderByParent.set(mut.parentUuid, order);
		}
		// A select field's born options also need identity + a sort key: the
		// per-uuid option diff skips a keyless option, so an edit to an
		// SA-authored option before a reload's backfill would be lost.
		const opts = keyedOptions(
			(mut.field as { options?: SelectOption[] }).options,
		);
		mut.field = { ...mut.field, order, ...(opts && { options: opts }) };
	}
	// Declaration chokepoint: a field writing to a type absent from the catalog
	// declares it (granular `declareCaseType`) — the reducer no longer
	// auto-creates the type. Declare each absent type ONCE, BEFORE the adds, so
	// every addField's catalog sync can append its property to the now-declared
	// type. No-op when every written type is already declared.
	const declared = new Set<string>();
	const declarations: Mutation[] = [];
	for (const mut of mutations) {
		if (mut.kind !== "addField") continue;
		const caseType = fieldCasePropertyOn(mut.field);
		if (caseType === undefined || declared.has(caseType)) continue;
		declared.add(caseType);
		declarations.push(...declareCaseTypeMutations(doc, caseType));
	}
	return {
		ok: true,
		mutations: [...declarations, ...mutations],
		skipped,
		parseExpression: (text) => parseXPathExpression(text, resolve),
		resolveFieldRef: (ref) => resolveCloseFieldRef(overlay, formUuid, ref),
	};
}

/**
 * Reference resolver over the doc PLUS the whole batch's planned tree —
 * the overlay both second-pass consumers share: the landed fields' own
 * expression slots (`resolveBatchExpressions`) and the caller-facing
 * `parseExpression` for form-level XPath inputs riding the same batch.
 */
function buildBatchOverlay(
	doc: BlueprintDoc,
	formUuid: Uuid,
	mutations: readonly Mutation[],
): XPathPrintableDoc & FieldRefResolvableDoc {
	const fields: Record<string, Field | undefined> = { ...doc.fields };
	const fieldOrder: Record<string, string[] | undefined> = {};
	for (const [parent, order] of Object.entries(doc.fieldOrder)) {
		fieldOrder[parent] = [...order];
	}
	// The insertion form may be minted by an earlier mutation in the same
	// batch (createForm / createModule) — give it a resolution root.
	const forms: Record<string, unknown> = doc.forms[formUuid]
		? doc.forms
		: { ...doc.forms, [formUuid]: {} };
	for (const mut of mutations) {
		if (mut.kind !== "addField") continue;
		fields[mut.field.uuid] = mut.field;
		const order = fieldOrder[mut.parentUuid] ?? [];
		const index =
			mut.index === undefined
				? order.length
				: Math.max(0, Math.min(mut.index, order.length));
		order.splice(index, 0, mut.field.uuid);
		fieldOrder[mut.parentUuid] = order;
		if (mut.field.kind === "group" || mut.field.kind === "repeat") {
			fieldOrder[mut.field.uuid] ??= [];
		}
	}
	return { forms, fields, fieldOrder };
}

/**
 * Second assembly pass: re-parse every landed field's expression slots
 * against the batch-aware resolver, so a reference to any field in the
 * same call — earlier or later — resolves to an identity leaf exactly
 * as it would once the batch has applied.
 */
function resolveBatchExpressions(
	resolve: ResolveFieldPath,
	landed: ReadonlyArray<{ field: Field; processed: Partial<FlatField> }>,
): void {
	for (const { field, processed } of landed) {
		const carrier = field as unknown as Record<string, unknown>;
		for (const slot of [
			"relevant",
			"calculate",
			"default_value",
			"required",
		] as const) {
			const text = processed[slot];
			if (typeof text === "string" && text.length > 0 && slot in carrier) {
				carrier[slot] = parseXPathExpression(text, resolve);
			}
		}
		const validateExpr = processed.validate?.expr;
		if (
			typeof validateExpr === "string" &&
			validateExpr.length > 0 &&
			"validate" in carrier
		) {
			carrier.validate = parseXPathExpression(
				unescapeXPath(validateExpr),
				resolve,
			);
		}
		const repeatConfig = processed.repeat;
		const repeatCount =
			repeatConfig?.mode === "count_bound" ? repeatConfig.count : undefined;
		if (
			typeof repeatCount === "string" &&
			repeatCount.length > 0 &&
			"repeat_count" in carrier
		) {
			carrier.repeat_count = parseXPathExpression(
				unescapeXPath(repeatCount),
				resolve,
			);
		}
		const idsQuery =
			repeatConfig?.mode === "query_bound" ? repeatConfig.ids_query : undefined;
		const dataSource = carrier.data_source as
			| { ids_query?: unknown }
			| undefined;
		if (
			typeof idsQuery === "string" &&
			idsQuery.length > 0 &&
			dataSource !== undefined
		) {
			dataSource.ids_query = parseXPathExpression(
				unescapeXPath(idsQuery),
				resolve,
			);
		}
	}
}

/**
 * Compose the person-to-person error for an `ok: false` assembly: every
 * failing id with its reason, plus the frame (nothing was added, fix and
 * re-issue). Shared by the field-landing tools so the agent reads one
 * message shape wherever ids bounce.
 */
export function describeRejectedFieldIds(
	formName: string,
	totalCount: number,
	rejected: ReadonlyArray<{ id: string; reason: string }>,
): string {
	const lines = rejected.map((r) => `- "${r.id}": ${r.reason}`).join("\n");
	return `No fields were added to "${formName}" — ${rejected.length} of ${totalCount} field id(s) can't be used:\n${lines}\nFix the listed id(s) and re-issue the call.`;
}
