/**
 * The canonical form of a document: every pair of documents that print one
 * export, or that differ only in content no export holds, replaced by the
 * member a reading returns. A Nova document is not always in the reader's
 * image, so a read back of its export is compared with this form of it.
 *
 * The list is the reader's own choices (`assemble.ts::READER_CANONICAL_CHOICES`,
 * each written by the reader module that makes it) and the print collisions
 * of one expression slot (`expressions/canonical.ts::canonicalExpression`),
 * applied to every slot of the document. Nothing here parses: each row is a
 * rewrite over the typed document, and each rewrite of a slot is taken only
 * where the slot's production print is the same before and after it
 * (`canonicalSlots`).
 */

import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	type LanguageTag,
	type TranslationUnitId,
	translationSourceFingerprintsEqual,
} from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression/context";
import {
	displayConditionForEmission,
	effectiveFilterForEmission,
} from "@/lib/domain/expression/simplify";
import { type Expression, isExpression } from "@/lib/domain/expression/types";
import {
	type ExpressionCarrierRef,
	expressionSlotValues,
	rewriteExpressionSlotValues,
} from "@/lib/domain/referenceSlots";
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";
import { userPropertySlugsByUuid } from "@/lib/domain/users";
import type { Uuid } from "@/lib/domain/uuid";
import { identityLookupWireNaming } from "../lookup/naming";
import { READER_CANONICAL_CHOICES } from "./assemble";
import { withCandidate } from "./candidate";
import {
	canonicalExpression,
	workerPropertyNamed,
} from "./expressions/canonical";
import { printSlotUnder, slotPrintUnder } from "./expressions/readExpression";
import { sameJson } from "./jsonCursor";

/** A rewrite of an expression slot the slot's print refused: the row's two members print
 *  differently there, which is Nova's own defect. Names the row and the slot's kind, never the
 *  expression. */
export interface WithheldRewrite {
	readonly rowId: string;
	readonly slot: string;
}

export interface Canonicalization {
	readonly id: string;
	/** `one-wire`: two documents print the same bytes. `not-carried`: content no export holds. */
	readonly kind: "one-wire" | "not-carried";
	/** The document with every instance of the pair replaced by the member the reader returns;
	 *  `withheld` is told each rewrite a slot's print refused. */
	apply(
		doc: BlueprintDoc,
		withheld?: (rewrite: WithheldRewrite) => void,
	): BlueprintDoc;
}

/** The slot a menu's case list filter is held in. */
const CASE_LIST_FILTER_SLOT = "case_list_filter";

/** Every expression owner of a document, menus first, in the order the
 *  reference slots walk them. */
function carriers(doc: BlueprintDoc): ExpressionCarrierRef[] {
	return [
		...doc.moduleOrder.map((uuid) => ({ entity: "module" as const, uuid })),
		...(Object.keys(doc.forms) as Uuid[]).map((uuid) => ({
			entity: "form" as const,
			uuid,
		})),
		...(Object.keys(doc.fields) as Uuid[]).map((uuid) => ({
			entity: "field" as const,
			uuid,
		})),
	];
}

/**
 * Every expression slot of `doc` holding the canonical tree of what it
 * stores, and no case list filter where that tree is `match-all` and no
 * menu's or form's display condition whose tree is `match-all`, which the
 * emitter writes none for (`effectiveFilterForEmission`,
 * `displayConditionForEmission`), and no Search field's requirement
 * condition that is `match-all`, which prints as the requirement with no
 * condition does. Each slot is canonicalized in its own context over
 * `doc`, with no Project lookup types (a slot's print collisions never read a
 * column's type) and under the identity lookup naming, which binds the same
 * questions in a Save to Case block's place as any naming does. Each rewrite
 * of a slot is taken only where the slot's print under that naming
 * (`readExpression.ts::printSlotUnder`) is the same with the rewritten node
 * in place; a rewrite the print refuses is left out and told to `withheld`.
 */
function canonicalSlots(
	doc: BlueprintDoc,
	withheld?: (rewrite: WithheldRewrite) => void,
): BlueprintDoc {
	const naming = identityLookupWireNaming();
	const lookupTypes = new Map();
	const replacements = new Map<string, Expression[]>();
	const droppedFilters = new Set<Uuid>();
	const droppedDisplayConditions = new Set<Uuid>();
	const droppedRequirementConditions: [Uuid, Uuid][] = [];
	let changed = false;
	const ownerKey = (owner: ExpressionCarrierRef) =>
		`${owner.entity}:${owner.uuid}`;
	for (const owner of carriers(doc)) {
		const trees: Expression[] = [];
		for (const { ref, expression } of expressionSlotValues(doc, owner)) {
			const context = slotContext(doc, ref, lookupTypes);
			const told = new Set<string>();
			const tree =
				context === undefined
					? expression
					: canonicalExpression(
							expression,
							context,
							slotPrintUnder(doc, ref, naming),
							{
								print: (candidate) =>
									printSlotUnder(doc, ref, candidate, naming),
								withheld: (rowId) => {
									if (told.has(rowId)) return;
									told.add(rowId);
									withheld?.({ rowId, slot: ref.slot });
								},
							},
						);
			if (
				ref.entity === "module" &&
				ref.slot === CASE_LIST_FILTER_SLOT &&
				effectiveFilterForEmission(tree) === undefined
			)
				droppedFilters.add(ref.uuid);
			if (
				(ref.slot === "module_display_condition" ||
					ref.slot === "form_display_condition") &&
				displayConditionForEmission(tree) === undefined
			)
				droppedDisplayConditions.add(ref.uuid);
			if (
				ref.entity === "module" &&
				ref.slot === "search_input_required_when" &&
				tree.kind === "match-all"
			)
				droppedRequirementConditions.push([
					ref.uuid,
					ref.member.searchInputUuid,
				]);
			if (!sameJson(tree, expression)) changed = true;
			trees.push(sameJson(tree, expression) ? expression : tree);
		}
		if (trees.length > 0) replacements.set(ownerKey(owner), trees);
	}
	if (
		!changed &&
		droppedFilters.size === 0 &&
		droppedDisplayConditions.size === 0 &&
		droppedRequirementConditions.length === 0
	)
		return doc;
	return withCandidate(doc, (draft) => {
		for (const owner of carriers(doc)) {
			const trees = replacements.get(ownerKey(owner));
			if (trees === undefined) continue;
			// The walk over the draft meets the slots in the order the walk over
			// `doc` did, the two documents having one shape.
			let at = 0;
			rewriteExpressionSlotValues(draft, owner, (value) => {
				if (!isExpression(value)) return value;
				const tree = trees[at++];
				return tree === undefined || sameJson(tree, value) ? value : tree;
			});
		}
		for (const uuid of droppedFilters) {
			const config = draft.modules[uuid]?.caseListConfig;
			if (config !== undefined) delete config.filter;
		}
		for (const uuid of droppedDisplayConditions) {
			const module = draft.modules[uuid];
			if (module !== undefined) delete module.displayCondition;
			const form = draft.forms[uuid];
			if (form !== undefined) delete form.displayCondition;
		}
		for (const [moduleUuid, inputUuid] of droppedRequirementConditions) {
			const input = draft.modules[
				moduleUuid
			]?.caseListConfig?.searchInputs.find((one) => one.uuid === inputUuid);
			if (input !== undefined && "required" in input && input.required)
				delete input.required.when;
		}
	});
}

/** Whether `value` holds a text's read of a worker field by name. */
function holdsNamedProseRead(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(holdsNamedProseRead);
	if (value === null || typeof value !== "object") return false;
	const node = value as Record<string, unknown>;
	if (node.kind === "user-ref" && typeof node.property === "string")
		return true;
	return Object.values(node).some(holdsNamedProseRead);
}

/**
 * Every text's read of a worker field by name (a prose `user-ref`) where the
 * app holds the worker property that name prints as
 * (`expressions/canonical.ts::workerPropertyNamed`), as the read of that
 * property (`user-property-ref`): both print `#user/<slug>`'s path, and a
 * reading binds the path to the property and stores the reference part
 * `proseExpression.ts::canonicalProseAtom` gives its read. A text holds a
 * reference part in no expression slot, so the slot rows never meet it.
 *
 * A translation of such a text holds the same reference parts as its source
 * (`translationUnits.ts::proseReferenceIdentity`), and a reading binds each
 * language's text alike, so each current translation of a text the row moves
 * is moved with it and stays current: it holds the same reads, and the
 * fingerprint of the moved source. Left as it was, it would no longer match
 * its source, and the export, which prints it, would be compared with a
 * document that drops it.
 */
function proseNamedReadsAsProperties(doc: BlueprintDoc): BlueprintDoc {
	const slugs = userPropertySlugsByUuid(doc);
	if (slugs.size === 0) return doc;
	const named = (Object.keys(doc.fields) as Uuid[]).filter((uuid) => {
		const field = doc.fields[uuid];
		return field !== undefined && holdsNamedProseRead(field);
	});
	const rewrite = (value: unknown): boolean => {
		if (value === null || typeof value !== "object") return false;
		let changed = false;
		for (const [key, child] of Object.entries(value)) {
			if (child === null || typeof child !== "object") continue;
			const part = child as Record<string, unknown>;
			const held =
				part.kind === "user-ref" && typeof part.property === "string"
					? workerPropertyNamed(part.property, slugs)
					: undefined;
			if (held !== undefined) {
				(value as Record<string, unknown>)[key] = {
					kind: "user-property-ref",
					userPropertyUuid: held,
				};
				changed = true;
			} else if (rewrite(child)) changed = true;
		}
		return changed;
	};
	const moves = named.filter((uuid) =>
		rewrite(structuredClone(doc.fields[uuid])),
	);
	if (moves.length === 0) return doc;
	const moved = withCandidate(doc, (draft) => {
		for (const uuid of moves) rewrite(draft.fields[uuid]);
	});

	// Each translation that was current for a text whose source the rewrite moved.
	const before = snapshotTranslationUnits(doc);
	const after = snapshotTranslationUnits(moved);
	const carried: [LanguageTag, TranslationUnitId, string][] = [];
	for (const [language, entries] of Object.entries(
		doc.localization?.translations ?? {},
	))
		for (const [unit, entry] of Object.entries(entries ?? {})) {
			const was = before.get(unit as TranslationUnitId);
			const now = after.get(unit as TranslationUnitId);
			if (
				was === undefined ||
				now === undefined ||
				entry === undefined ||
				translationSourceFingerprintsEqual(
					was.sourceFingerprint,
					now.sourceFingerprint,
				) ||
				!translationSourceFingerprintsEqual(
					entry.sourceFingerprint,
					was.sourceFingerprint,
				)
			)
				continue;
			carried.push([
				language as LanguageTag,
				unit as TranslationUnitId,
				now.sourceFingerprint,
			]);
		}
	if (carried.length === 0) return moved;
	return withCandidate(moved, (draft) => {
		for (const [language, unit, fingerprint] of carried) {
			const entry = draft.localization?.translations[language]?.[unit];
			if (entry === undefined) continue;
			rewrite(entry);
			entry.sourceFingerprint = fingerprint;
		}
	});
}

export const CANONICALIZATIONS: readonly Canonicalization[] = [
	...READER_CANONICAL_CHOICES.map(
		(choice): Canonicalization => ({
			id: choice.id,
			kind: choice.kind,
			apply: choice.apply,
		}),
	),
	{
		/** Two trees of one slot that print the same bytes there
		 *  (`expressions/canonical.ts::PRINT_COLLISIONS`): the reader returns the
		 *  canonical one, and no case list filter and no menu's or form's
		 *  display condition where that tree is `match-all`; and a text's read of a worker field by name where a worker property
		 *  prints the same path, which the reader returns as that property's
		 *  read (`proseNamedReadsAsProperties`). */
		id: "expression-print-collisions",
		kind: "one-wire",
		apply: (doc, withheld) =>
			proseNamedReadsAsProperties(canonicalSlots(doc, withheld)),
	},
];

/** The document as it is stored, for a comparison that no derived slot and
 *  no fresh object of an unchanged document moves. */
function stored(doc: BlueprintDoc): unknown {
	return toPersistableDoc(doc);
}

/** Every row applied in list order, repeated until none changes the document. */
export function canonDocument(
	doc: BlueprintDoc,
	withheld?: (rewrite: WithheldRewrite) => void,
): BlueprintDoc {
	const steps = canonDocumentSteps(doc, withheld);
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}

/**
 * `canonDocument` a row at a time: it stops after each row until it is
 * resumed, so a caller on a request can let the event loop turn while a
 * document at the bring-in byte cap is put in its canonical form.
 */
export function* canonDocumentSteps(
	doc: BlueprintDoc,
	withheld?: (rewrite: WithheldRewrite) => void,
): Generator<void, BlueprintDoc, void> {
	let current = doc;
	for (let pass = 0; pass < CANONICALIZATIONS.length; pass++) {
		let next = current;
		for (const row of CANONICALIZATIONS) {
			next = row.apply(next, withheld);
			yield;
		}
		if (sameJson(stored(next), stored(current))) return current;
		current = next;
	}
	throw new Error(
		"Nova's canonical form of a document did not settle. Each canonicalization returns the member of its pair the reader returns, so applying one twice changes nothing; look at the row whose result another row undoes.",
	);
}
