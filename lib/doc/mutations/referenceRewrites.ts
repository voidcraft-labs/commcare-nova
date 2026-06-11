/**
 * Registry-driven reference rewriting for the rename / move reducers.
 *
 * `lib/domain/referenceSlots.ts` is the single enumeration of every
 * blueprint slot that can carry a reference; the rewrite passes here
 * iterate its projections instead of hand-rolled key lists, so a slot
 * registered there is covered by the rename cascade by construction.
 * Each entity's walker is an exhaustive switch over the registry's
 * slot ids — adding a slot to the registry without deciding how the
 * cascade handles it is a compile error, not a silent rewriter gap
 * (the gap this closed: `required` sat outside the old hand-rolled
 * list, so renames silently broke `required` expressions; the
 * `help` / `validate_msg` / option-label prose surfaces never rewrote
 * at all).
 *
 * Everything here mutates the given entity in place (callers hand in
 * Immer drafts) and is total — absent optional slots and shape
 * mismatches rewrite nothing rather than throw.
 */

import type { Field, Form, Module } from "@/lib/domain";
import {
	FORM_REFERENCE_SLOTS,
	fieldReferenceSlotsFor,
	isXPathExpression,
	MODULE_REFERENCE_SLOTS,
	readSlotValues,
	renameCasePropertyInXPath,
	rewriteSlotStrings,
	type XPathCasePropertyRename,
} from "@/lib/domain";
import {
	type CasePropertyRename,
	relationDestinationCaseType,
	renameCasePropertyInExpression,
	renameCasePropertyInPredicate,
} from "@/lib/domain/predicate";
import { transformBareHashtags } from "@/lib/preview/engine/labelRefs";

/**
 * What one field-slot rewrite pass carries:
 *
 *   - `xpath` — the string rewriter for string-stored XPath slots and
 *     for the hashtag substrings embedded in prose (prose is located
 *     by the shared matcher first; surrounding text is never parsed
 *     as XPath).
 *   - `caseLeafRename` — present only on the case-property cascade:
 *     AST-stored slots rename matching leaves STRUCTURALLY
 *     (`renameCasePropertyInXPath`). Form-local rename/move passes
 *     leave it absent because AST slots need nothing from them —
 *     identity leaves resolve at print, so there is no rewrite.
 */
export interface FieldSlotRewriteOps {
	xpath: (expr: string) => string;
	caseLeafRename?: {
		rename: XPathCasePropertyRename;
		/** True when the carrier's owning module has the renamed case
		 *  type — gates the transitional contextual `#case/…` leaves,
		 *  which follow the module's type rather than naming one. */
		contextualMatches: boolean;
	};
}

/**
 * Apply one rewrite pass to every reference-carrying slot a field of
 * this kind declares. Returns the number of slot values changed (an
 * option list counts one per rewritten option label; an AST slot
 * counts one per slot whose leaves changed).
 *
 * The slot list is the registry's per-kind projection
 * (`fieldReferenceSlotsFor`), narrowed by `repeat_mode` for the
 * repeat union so only the active variant's slot is walked.
 */
export function rewriteFieldReferenceSlots(
	field: Field,
	ops: FieldSlotRewriteOps,
): number {
	const repeatMode = field.kind === "repeat" ? field.repeat_mode : undefined;
	let changed = 0;
	for (const slot of fieldReferenceSlotsFor(field.kind, repeatMode)) {
		switch (slot.kind) {
			case "xpath":
				changed += rewriteSlotStrings(field, slot.path, ops.xpath);
				break;
			case "xpath-ast": {
				const leafRename = ops.caseLeafRename;
				if (leafRename === undefined) break;
				for (const entry of readSlotValues(field, slot.path)) {
					if (!isXPathExpression(entry.value)) continue;
					const renamed = renameCasePropertyInXPath(
						entry.value,
						leafRename.rename,
						{ contextualMatches: leafRename.contextualMatches },
					);
					if (renamed > 0) changed++;
				}
				break;
			}
			case "prose":
				changed += rewriteSlotStrings(field, slot.path, (text) =>
					transformBareHashtags(text, ops.xpath),
				);
				break;
			case "case-type-ref":
				// Names a case TYPE (`case_property_on`) — field renames and
				// case-property renames never change a type name.
				break;
			case "predicate-ast":
			case "field-id-ref":
			case "entity-uuid":
			case "case-property-ref":
				// No field slot carries these kinds today. A new one must
				// pick up its rewrite arm here — until then this is
				// unreachable, kept explicit so the registry's kind union
				// stays exhaustively handled.
				break;
			default: {
				const _exhaustive: never = slot.kind;
				break;
			}
		}
	}
	return changed;
}

/**
 * Context for one form-level rewrite pass.
 *
 * `xpath` rewrites the form's XPath-carrying wiring slots — form-link
 * conditions, form-link datum values, and the Connect expression
 * slots. Per CCHQ's end-of-form navigation semantics
 * (`commcare-hq/.../suite_xml/post_process/workflow.py::
 * EndOfFormNavigationWorkflow._get_link_frame` installs `link.xpath`
 * verbatim as the SOURCE form's stack-frame condition, and manual
 * datum values are evaluated in the same post-submit context), these
 * slots reference the fields of the form that OWNS them — so a rename
 * pass runs against the renamed field's own containing form, never
 * against forms that merely link INTO it. Connect slots likewise
 * validate against their own form's field paths
 * (`lib/commcare/validator/index.ts` checks them with the form's
 * `validPaths`).
 *
 * `fieldIdRename` drives `closeCondition.field` — a bare leaf-id
 * pointer at a field in the same form. Bare ids are ambiguous when
 * cousins share the leaf (`lib/commcare/formActions.ts::findField`
 * resolves the first match in walk order), so the ref is rewritten
 * only when the renamed field was the UNIQUE holder of the old id in
 * the form: if another field still answers to the old name the ref
 * keeps resolving to it, and rewriting would silently retarget the
 * close condition. Absent on passes that don't change a field id in
 * this form (the case-property hashtag pass, moveField's path pass).
 */
export interface FormSlotRewriteContext {
	xpath: (expr: string) => string;
	fieldIdRename?: {
		oldId: string;
		newId: string;
		/** True iff another field in this form still has `oldId`. */
		oldIdStillTaken: boolean;
	};
}

/**
 * Rewrite one form's form-level reference slots in place. Returns the
 * number of slot values changed.
 *
 * The registry's `formTypes` applicability is deliberately NOT
 * consulted: it encodes which form types a slot is semantically VALID
 * on (validator's concern), while the rewrite keeps whatever value is
 * actually present consistent — a close condition on a form the
 * validator will flag anyway should still follow its field.
 */
export function rewriteFormReferenceSlots(
	form: Form,
	ctx: FormSlotRewriteContext,
): number {
	let changed = 0;
	for (const slot of FORM_REFERENCE_SLOTS) {
		switch (slot.slot) {
			case "form_link_condition":
			case "form_link_datum_xpath":
			case "assessment_user_score":
			case "deliver_entity_id":
			case "deliver_entity_name":
				changed += rewriteSlotStrings(form, slot.path, ctx.xpath);
				break;
			case "close_condition_field": {
				const rename = ctx.fieldIdRename;
				if (rename === undefined || rename.oldIdStillTaken) break;
				if (form.closeCondition?.field === rename.oldId) {
					form.closeCondition.field = rename.newId;
					changed++;
				}
				break;
			}
			case "form_link_target":
				// entity-uuid — stable identity, unaffected by renames/moves.
				break;
			default: {
				const _exhaustive: never = slot;
				break;
			}
		}
	}
	return changed;
}

/** Per-module result of a case-property rename pass. */
export interface ModuleCaseRefRewrites {
	/** `columns[].field` cells renamed (the property-name-as-string
	 *  column pointer; calculated columns have no `field`). */
	columnsRewritten: number;
	/** `PropertyRef` AST nodes + simple search-input `property` slots
	 *  renamed across the module's predicate/expression ASTs. */
	astRefsRewritten: number;
}

/**
 * Rewrite one module's case-property references in place.
 *
 * Two reference shapes, two scoping rules:
 *
 *   - `columns[].field` and a simple search input's `property` name
 *     a property of a CONTEXTUAL case type — the module's own
 *     `caseType`, walked to the via's destination for inputs that
 *     carry one. They rewrite only when that contextual type is the
 *     renamed type.
 *   - `PropertyRef` AST leaves SELF-encode their case type (origin +
 *     optional walk), so every module's ASTs are walked and matching
 *     is per-node (`renameCasePropertyIn*`'s destination-type rule) —
 *     a household module's filter can legally reach a patient
 *     property through a subcase walk.
 *
 * `searchInputs[].via` itself carries relation identifiers and
 * case-TYPE hints but no property names, so a property rename has
 * nothing to rewrite there (it would participate in a case-type
 * rename, which no mutation performs today).
 */
export function rewriteModuleCaseRefs(
	mod: Module,
	rename: CasePropertyRename,
): ModuleCaseRefRewrites {
	let columnsRewritten = 0;
	let astRefsRewritten = 0;
	const ownTypeMatches = mod.caseType === rename.caseType;
	for (const slot of MODULE_REFERENCE_SLOTS) {
		switch (slot.slot) {
			case "case_type":
				// Names a case TYPE — untouched by a property rename.
				break;
			case "case_list_column_field": {
				if (!ownTypeMatches) break;
				for (const col of mod.caseListConfig?.columns ?? []) {
					if (col.kind === "calculated") continue;
					if (col.field === rename.oldName) {
						col.field = rename.newName;
						columnsRewritten++;
					}
				}
				break;
			}
			case "case_list_column_expression": {
				for (const col of mod.caseListConfig?.columns ?? []) {
					if (col.kind !== "calculated") continue;
					astRefsRewritten += renameCasePropertyInExpression(
						col.expression,
						rename,
					);
				}
				break;
			}
			case "case_list_filter": {
				const filter = mod.caseListConfig?.filter;
				if (filter !== undefined) {
					astRefsRewritten += renameCasePropertyInPredicate(filter, rename);
				}
				break;
			}
			case "search_input_property": {
				for (const inputDef of mod.caseListConfig?.searchInputs ?? []) {
					if (inputDef.kind !== "simple") continue;
					if (inputDef.property !== rename.oldName) continue;
					const destination = relationDestinationCaseType(
						inputDef.via,
						mod.caseType,
					);
					if (destination !== rename.caseType) continue;
					inputDef.property = rename.newName;
					astRefsRewritten++;
				}
				break;
			}
			case "search_input_via":
				// Relation identifiers + case-type hints only — no property
				// names to rename.
				break;
			case "search_input_default": {
				for (const inputDef of mod.caseListConfig?.searchInputs ?? []) {
					if (inputDef.default !== undefined) {
						astRefsRewritten += renameCasePropertyInExpression(
							inputDef.default,
							rename,
						);
					}
				}
				break;
			}
			case "search_input_predicate": {
				for (const inputDef of mod.caseListConfig?.searchInputs ?? []) {
					if (inputDef.kind === "advanced") {
						astRefsRewritten += renameCasePropertyInPredicate(
							inputDef.predicate,
							rename,
						);
					}
				}
				break;
			}
			case "search_button_display_condition": {
				const condition = mod.caseSearchConfig?.searchButtonDisplayCondition;
				if (condition !== undefined) {
					astRefsRewritten += renameCasePropertyInPredicate(condition, rename);
				}
				break;
			}
			case "excluded_owner_ids": {
				const excluded = mod.caseSearchConfig?.excludedOwnerIds;
				if (excluded !== undefined) {
					astRefsRewritten += renameCasePropertyInExpression(excluded, rename);
				}
				break;
			}
			default: {
				const _exhaustive: never = slot;
				break;
			}
		}
	}
	return { columnsRewritten, astRefsRewritten };
}
