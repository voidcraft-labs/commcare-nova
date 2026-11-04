/**
 * Shared field-batch assembly — the one pipeline that turns the SA's flat
 * per-kind field items into `addField` mutations, used by every tool that
 * lands fields (`addFields` on an existing form; `createForm` /
 * `createModule` on a form minted in the same batch).
 *
 * Per item: sentinel strip (`stripEmpty`) → case-type default merge
 * (`applyDefaults`) → uuid mint → domain `Field` assembly
 * (`flatFieldToField`) → the shared identifier verdict
 * (`lib/doc/identifierVerdicts.ts` — XML-name legality and sibling
 * uniqueness against the doc AND this batch's earlier items). Each item's
 * `caseWrite` is then planned into the form's case operations through
 * `planFieldCaseWrite`, over the document the batch's fields produce. Parent
 * resolution covers containers minted earlier in the same batch (`mintedByBareId`)
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

import { planFieldCaseWrite } from "@/lib/doc/fieldCaseWriteMutations";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import { fieldIdVerdict } from "@/lib/doc/identifierVerdicts";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import {
	asUuid,
	findAuthoredBlueprintIdentity,
	isContainer,
} from "@/lib/domain";
import {
	applyDefaults,
	batchUserRepeatHolders,
	type FlatField,
	flatFieldToField,
	prepareFlatFieldIdentities,
	stripEmpty,
} from "../../contentProcessing";
import { applyToDoc } from "../common";

export interface FieldAssemblyArgs {
	/** The doc the batch will apply to — parent lookups + sibling scans. */
	doc: BlueprintDoc;
	/** Insertion root: an existing form's uuid, or the uuid of a form an
	 *  earlier mutation in the same batch creates. */
	formUuid: Uuid;
	/** The SA's flat field items, in order. */
	items: readonly FlatField[];
	/** Other authorable identities predeclared by the surrounding creation call. */
	occupiedUuids?: ReadonlySet<Uuid>;
	/** Default parent for the batch. A field's own `parentUuid` overrides it. */
	batchParentUuid?: Uuid;
	/** Insertion anchor for the batch's top-level block — only meaningful
	 *  against an EXISTING form (a new form has nothing to anchor to). */
	anchor?: { beforeFieldUuid?: Uuid; afterFieldUuid?: Uuid };
}

export interface CreatedOptionIdentity {
	uuid: Uuid;
	value: string;
}

export interface CreatedFieldIdentity {
	uuid: Uuid;
	id: string;
	/** Inline-option identities in authored/source order; empty for non-selects
	 * and lookup-backed selects. */
	options: CreatedOptionIdentity[];
}

export type FieldAssemblyResult =
	| {
			ok: true;
			mutations: Mutation[];
			/** Every created identity, in input order. */
			created: CreatedFieldIdentity[];
			/** What planning each item's `caseWrite` said about it, such as a
			 *  starting value read from the case (`planFieldCaseWrite`). */
			notes: Array<{ uuid: Uuid; id: string; note: string }>;
	  }
	| {
			ok: false;
			/** Every item field assembly or identifier admission refused. */
			rejected: Array<{ id: string; reason: string }>;
	  };

export function assembleFieldMutations(
	args: FieldAssemblyArgs,
): FieldAssemblyResult {
	const { doc, formUuid, items, occupiedUuids, batchParentUuid, anchor } = args;

	// Resolve the batch's insertion parent — the form root, or an existing
	// container named by stable UUID. When an anchor is given, find
	// the index in that parent's CURRENT order where the batch's top-level
	// block should start; `topLevelNextIndex` then walks forward as each
	// top-level field is placed, so the inserted fields land contiguously
	// in batch order. A field carrying its OWN parentUuid nests under that
	// parent and never consumes an anchor slot.
	let batchInsertParent: Uuid = formUuid;
	if (batchParentUuid) {
		const existing = doc.fields[batchParentUuid];
		if (
			!existing ||
			!isContainer(existing) ||
			findContainingForm(doc, batchParentUuid) !== formUuid
		) {
			return {
				ok: false,
				rejected: [
					{
						id: batchParentUuid,
						reason:
							"batch parentUuid must name a group, repeat, or section in the addressed form.",
					},
				],
			};
		}
		batchInsertParent = existing.uuid;
	}
	let topLevelNextIndex: number | undefined;
	if (anchor?.beforeFieldUuid || anchor?.afterFieldUuid) {
		const order = orderedFieldUuids(doc, batchInsertParent);
		const anchorUuid = anchor.beforeFieldUuid ?? anchor.afterFieldUuid;
		const i = anchorUuid === undefined ? -1 : order.indexOf(anchorUuid);
		if (i === -1) {
			return {
				ok: false,
				rejected: [
					{
						id: anchorUuid ?? "",
						reason:
							"the insertion anchor must name an existing sibling in the insertion parent.",
					},
				],
			};
		}
		topLevelNextIndex = anchor.beforeFieldUuid ? i : i + 1;
	}
	// The anchor's start slot in the parent's DISPLAY order, captured BEFORE
	// the placement loop advances `topLevelNextIndex` — the second-pass order
	// minting keys the anchored block BETWEEN the neighbors at this slot.
	const anchorStartIndex = topLevelNextIndex;

	// Assign final identities before assembling any item. This complete overlay
	// lets expression references point forward while topology remains ordered.
	const assigned = items.map((input) => {
		const raw = prepareFlatFieldIdentities(input);
		return {
			raw,
			// Catalog defaults may themselves mint inline-option UUIDs. Establish
			// them before ANY collision/admission check, then carry this exact
			// processed object through assembly unchanged.
			processed: applyDefaults(stripEmpty(raw), doc.caseTypes),
			uuid: input.fieldUuid ?? asUuid(crypto.randomUUID()),
		};
	});
	const predeclared = new Map<Uuid, string>();
	const identityRejections: Array<{ id: string; reason: string }> = [];
	for (const { raw, processed, uuid } of assigned) {
		const declarations: Array<{ uuid: Uuid; label: string }> = [
			{ uuid, label: `field "${raw.id}"` },
			...(processed.optionsSource?.kind === "inline"
				? processed.optionsSource.options.map((option) => ({
						uuid: option.uuid,
						label: `option "${option.value}" on field "${raw.id}"`,
					}))
				: []),
		];
		for (const declaration of declarations) {
			const prior = predeclared.get(declaration.uuid);
			if (prior !== undefined) {
				identityRejections.push({
					id: raw.id,
					reason: `UUID ${declaration.uuid} for ${declaration.label} is also declared by ${prior} in this call.`,
				});
				continue;
			}
			const existing = findAuthoredBlueprintIdentity(doc, declaration.uuid);
			if (existing !== undefined || occupiedUuids?.has(declaration.uuid)) {
				identityRejections.push({
					id: raw.id,
					reason: `UUID ${declaration.uuid} for ${declaration.label} already belongs to ${existing?.kind ?? "another authored object"} in this app or creation call.`,
				});
				continue;
			}
			predeclared.set(declaration.uuid, declaration.label);
		}
	}
	if (identityRejections.length > 0) {
		return { ok: false, rejected: identityRejections };
	}

	const userRepeatHolders = batchUserRepeatHolders(
		assigned.map(({ processed, uuid }) => ({
			uuid,
			parentUuid: processed.parentUuid,
			kind: processed.kind,
			repeat: processed.repeat,
		})),
	);
	const mutations: Mutation[] = [];
	const rejected: Array<{ id: string; reason: string }> = [];
	const pendingByParent = new Map<Uuid, Set<string>>();
	const earlierFields = new Map<Uuid, Field>();

	for (const { raw, processed, uuid: fieldUuid } of assigned) {
		// Resolve parentUuid: the field's OWN value wins; if it didn't
		// set one, fall back to the batch-level value; if neither is
		// set, the field lands at the form's top level.
		const parentUuid = processed.parentUuid ?? batchParentUuid ?? formUuid;
		if (parentUuid !== formUuid) {
			const earlier = earlierFields.get(parentUuid);
			if (earlier) {
				if (!isContainer(earlier)) {
					rejected.push({
						id: raw.id,
						reason: `parentUuid ${parentUuid} names an earlier non-container field.`,
					});
					continue;
				}
			} else {
				const existing = doc.fields[parentUuid];
				if (
					!existing ||
					!isContainer(existing) ||
					findContainingForm(doc, parentUuid) !== formUuid
				) {
					rejected.push({
						id: raw.id,
						reason: predeclared.has(parentUuid)
							? `parentUuid ${parentUuid} names a field declared later in this call; topology parents must appear earlier.`
							: `parentUuid ${parentUuid} must name a group, repeat, or section in the addressed form.`,
					});
					continue;
				}
			}
		}

		const assembled = flatFieldToField(
			processed,
			fieldUuid,
			userRepeatHolders.has(fieldUuid),
		);
		if (!assembled.ok) {
			// Structural creation is all-or-nothing. A field that cannot become
			// its requested domain kind rejects the complete assembly just like an
			// identifier failure; silently omitting it would make returned identities
			// and the supposedly complete form disagree with persisted reality.
			rejected.push({ id: raw.id, reason: assembled.reason });
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

		earlierFields.set(fieldUuid, field);
		// Top-level batch fields honor the anchor (a contiguous block at
		// the resolved index, walking forward per field); everything else
		// — fields nested under their own parentUuid, or any field when no
		// anchor was given — appends.
		if (topLevelNextIndex !== undefined && parentUuid === batchInsertParent) {
			// Placement is filled in below, once every field in the batch exists
			// and each can name the one it follows.
			mutations.push({ kind: "addField", parentUuid, field });
			topLevelNextIndex += 1;
		} else {
			mutations.push({ kind: "addField", parentUuid, field });
		}
	}

	if (rejected.length > 0) return { ok: false, rejected };
	// Place every born field. An ANCHORED batch (a top-level block placed at
	// `beforeFieldUuid` / `afterFieldUuid`) lands AT the anchor rather than at the
	// end, so its first field follows the anchor's predecessor and each
	// subsequent one follows its own predecessor in the batch. Every other field
	// appends under its parent, and a chain of `after` through the batch is what
	// keeps fields written to one parent in the order they were authored.
	//
	// A minted container parent, added earlier in this same batch, has no fields
	// in the document yet — its children simply append, which now needs no
	// special case at all.
	const anchorAfter =
		anchorStartIndex === undefined
			? undefined
			: (() => {
					const siblings = orderedFieldUuids(doc, batchInsertParent);
					const at = Math.max(0, Math.min(anchorStartIndex, siblings.length));
					return at === 0 ? null : (siblings[at - 1] ?? null);
				})();
	const lastPlacedByParent = new Map<string, Uuid | null | undefined>();
	if (anchorAfter !== undefined) {
		lastPlacedByParent.set(batchInsertParent, anchorAfter);
	}
	for (const mut of mutations) {
		if (mut.kind !== "addField") continue;
		const after = lastPlacedByParent.get(mut.parentUuid);
		if (after !== undefined) mut.after = after;
		lastPlacedByParent.set(mut.parentUuid, asUuid(mut.field.uuid));
	}
	// A field holds no destination: each item's `caseWrite` is planned into
	// the form's case operations once every field of the batch exists, by
	// the one "Saves to" planner, which also declares the case types and
	// properties its writes need. A child case is created with its name, so
	// the writes of `case_name` are planned first.
	const writes = assigned.flatMap(({ raw, uuid }) =>
		raw.caseWrite == null
			? []
			: [{ uuid, id: raw.id, caseWrite: raw.caseWrite }],
	);
	writes.sort(
		(a, b) =>
			Number(b.caseWrite.property === "case_name") -
			Number(a.caseWrite.property === "case_name"),
	);
	const writeMutations: Mutation[] = [];
	const notes: Array<{ uuid: Uuid; id: string; note: string }> = [];
	let candidate = writes.length === 0 ? doc : applyToDoc(doc, mutations);
	for (const write of writes) {
		const plan = planFieldCaseWrite(candidate, write.uuid, {
			caseType: write.caseWrite.caseType,
			property: write.caseWrite.property,
		});
		if (!plan.ok) {
			rejected.push({ id: write.id, reason: plan.message });
			continue;
		}
		writeMutations.push(...plan.mutations);
		candidate = applyToDoc(candidate, plan.mutations);
		for (const note of plan.notes)
			notes.push({ uuid: write.uuid, id: write.id, note });
	}
	if (rejected.length > 0) return { ok: false, rejected };
	return {
		ok: true,
		mutations: [...mutations, ...writeMutations],
		notes,
		created: mutations
			.filter(
				(mut): mut is Extract<Mutation, { kind: "addField" }> =>
					mut.kind === "addField",
			)
			.map((mut) => ({
				uuid: mut.field.uuid,
				id: mut.field.id,
				options:
					"optionsSource" in mut.field &&
					mut.field.optionsSource.kind === "inline"
						? mut.field.optionsSource.options.map((option) => ({
								uuid: option.uuid,
								value: option.value,
							}))
						: [],
			})),
	};
}

/**
 * Compose the person-to-person error for an `ok: false` assembly: every
 * failing id with its reason, plus the frame (nothing was added, fix and
 * re-issue). Shared by the field-landing tools so the agent reads one
 * message shape wherever ids bounce.
 */
export function describeRejectedFields(
	formName: string,
	totalCount: number,
	rejected: ReadonlyArray<{ id: string; reason: string }>,
): string {
	const lines = rejected.map((r) => `- "${r.id}": ${r.reason}`).join("\n");
	return `No fields were added to "${formName}" — ${rejected.length} of ${totalCount} field(s) could not be assembled:\n${lines}\nFix the listed field(s) and re-issue the call.`;
}
