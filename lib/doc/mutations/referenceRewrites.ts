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
	mapCasePropertiesInProse,
	mapCasePropertiesInXPath,
	type ProseTemplate,
	readSlotValues,
} from "@/lib/domain";
import {
	type CasePropertyNameResolver,
	mapCasePropertiesInExpression,
	mapCasePropertiesInPredicate,
	relationDestinationCaseType,
} from "@/lib/domain/predicate";

/**
 * One case-property cascade over field-owned typed carriers.
 *
 * Form-local references need no rename/move pass: XPath and prose both store
 * field UUID atoms and project the current path at print. The only rewrite is
 * the deliberate structural rename of name-keyed `(caseType, property)`
 * leaves.
 */
export interface FieldSlotRewriteOps {
	resolveCaseProperty: CasePropertyNameResolver;
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
			case "xpath-ast": {
				for (const entry of readSlotValues(field, slot.path)) {
					if (!isXPathExpression(entry.value)) continue;
					const renamed = mapCasePropertiesInXPath(
						entry.value,
						ops.resolveCaseProperty,
					);
					if (renamed > 0) changed++;
				}
				break;
			}
			case "prose":
				for (const entry of readSlotValues(field, slot.path)) {
					changed += mapCasePropertiesInProse(
						entry.value as ProseTemplate,
						ops.resolveCaseProperty,
					);
				}
				break;
			case "case-type-ref":
				// `caseWrite.caseType` names a case TYPE. A property rename
				// never changes it.
				break;
			case "lookup-carrier": {
				if (
					(field.kind === "single_select" || field.kind === "multi_select") &&
					field.optionsSource.kind === "lookup" &&
					field.optionsSource.filter !== undefined
				) {
					changed += mapCasePropertiesInPredicate(
						field.optionsSource.filter,
						ops.resolveCaseProperty,
					);
				}
				break;
			}
			case "case-property-ref": {
				if (!("caseWrite" in field) || field.caseWrite === undefined) break;
				const property = ops.resolveCaseProperty(
					field.caseWrite.caseType,
					field.caseWrite.property,
				);
				if (property !== undefined && property !== field.caseWrite.property) {
					field.caseWrite.property = property;
					changed++;
				}
				break;
			}
			case "predicate-ast":
			case "entity-uuid":
				// No field slot carries these kinds today. A new one must
				// pick up its rewrite arm here.
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
 * Context for one form-level rewrite pass. Every form wiring slot is
 * identity-stored (uuid pointers and expression ASTs), so the only
 * pass with anything to do is the case-property cascade: a structural
 * leaf rename over the form's expression slots (same contract as
 * `FieldSlotRewriteOps.resolveCaseProperty`). Form-link conditions/datums
 * and Connect bindings reference the form's OWN fields (CCHQ's
 * end-of-form navigation evaluates `link.xpath` in the source form's
 * context), which is why the cascade's per-carrier module match is
 * meaningful here at all.
 */
export interface FormSlotRewriteContext {
	resolveCaseProperty: CasePropertyNameResolver;
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
			case "form_display_condition":
				if (form.displayCondition !== undefined) {
					changed += mapCasePropertiesInPredicate(
						form.displayCondition,
						ctx.resolveCaseProperty,
					);
				}
				break;
			case "form_link_condition":
			case "form_link_datum_xpath":
			case "assessment_user_score":
			case "deliver_entity_id":
			case "deliver_entity_name": {
				// AST-stored — identity leaves follow renames/moves at print;
				// only a case-property rename touches them, structurally.
				for (const entry of readSlotValues(form, slot.path)) {
					if (!isXPathExpression(entry.value)) continue;
					const renamed = mapCasePropertiesInXPath(
						entry.value,
						ctx.resolveCaseProperty,
					);
					if (renamed > 0) changed++;
				}
				break;
			}
			case "case_operation_target_expression":
			case "case_operation_name":
			case "case_operation_owner":
			case "case_operation_rename":
			case "case_operation_write_value":
			case "case_operation_link_target_expression":
				for (const entry of readSlotValues(form, slot.path)) {
					changed += mapCasePropertiesInExpression(
						entry.value as Parameters<typeof mapCasePropertiesInExpression>[0],
						ctx.resolveCaseProperty,
					);
				}
				break;
			case "case_operation_condition":
			case "case_operation_write_condition":
				for (const entry of readSlotValues(form, slot.path)) {
					changed += mapCasePropertiesInPredicate(
						entry.value as Parameters<typeof mapCasePropertiesInPredicate>[0],
						ctx.resolveCaseProperty,
					);
				}
				break;
			case "case_operation_write_property":
				for (const operation of form.caseOperations ?? []) {
					for (const write of operation.writes ?? []) {
						const caseType = operation.retype ?? operation.caseType;
						const destination = ctx.resolveCaseProperty(
							caseType,
							write.property,
						);
						if (destination === undefined || destination === write.property) {
							continue;
						}
						write.property = destination;
						changed++;
					}
				}
				break;
			case "close_condition_field":
			case "form_link_target":
			case "case_operation_case_type":
			case "case_operation_retype":
			case "case_operation_target_op":
			case "case_operation_target_id_from":
			case "case_operation_repeat":
			case "case_operation_link_target_type":
			case "case_operation_link_target_op":
			case "case_operation_link_target_id_from":
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
	resolveCaseProperty: CasePropertyNameResolver,
): ModuleCaseRefRewrites {
	let columnsRewritten = 0;
	let astRefsRewritten = 0;
	for (const slot of MODULE_REFERENCE_SLOTS) {
		switch (slot.slot) {
			case "module_parent":
				// Entity parentage is unaffected by case-property renames.
				break;
			case "module_display_condition": {
				const condition = mod.displayCondition;
				if (condition !== undefined) {
					astRefsRewritten += mapCasePropertiesInPredicate(
						condition,
						resolveCaseProperty,
					);
				}
				break;
			}
			case "case_type":
				// Names a case TYPE — untouched by a property rename.
				break;
			case "case_list_column_field": {
				for (const col of mod.caseListConfig?.columns ?? []) {
					if (col.kind === "calculated") continue;
					if (mod.caseType === undefined) continue;
					const destination = resolveCaseProperty(mod.caseType, col.field);
					if (destination === undefined || destination === col.field) continue;
					col.field = destination;
					columnsRewritten++;
				}
				break;
			}
			case "case_list_column_expression": {
				for (const col of mod.caseListConfig?.columns ?? []) {
					if (col.kind !== "calculated") continue;
					astRefsRewritten += mapCasePropertiesInExpression(
						col.expression,
						resolveCaseProperty,
					);
				}
				break;
			}
			case "case_list_filter": {
				const filter = mod.caseListConfig?.filter;
				if (filter !== undefined) {
					astRefsRewritten += mapCasePropertiesInPredicate(
						filter,
						resolveCaseProperty,
					);
				}
				break;
			}
			case "search_input_property": {
				for (const inputDef of mod.caseListConfig?.searchInputs ?? []) {
					if (inputDef.kind !== "simple") continue;
					const destination = relationDestinationCaseType(
						inputDef.via,
						mod.caseType,
					);
					if (destination === undefined) continue;
					const property = resolveCaseProperty(destination, inputDef.property);
					if (property === undefined || property === inputDef.property)
						continue;
					inputDef.property = property;
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
					if ("default" in inputDef && inputDef.default !== undefined) {
						astRefsRewritten += mapCasePropertiesInExpression(
							inputDef.default,
							resolveCaseProperty,
						);
					}
				}
				break;
			}
			case "search_input_predicate": {
				for (const inputDef of mod.caseListConfig?.searchInputs ?? []) {
					if (inputDef.kind === "advanced") {
						astRefsRewritten += mapCasePropertiesInPredicate(
							inputDef.predicate,
							resolveCaseProperty,
						);
					}
				}
				break;
			}
			case "search_button_display_condition": {
				const condition =
					mod.caseSearchConfig !== undefined &&
					"searchButtonDisplayCondition" in mod.caseSearchConfig
						? mod.caseSearchConfig.searchButtonDisplayCondition
						: undefined;
				if (condition !== undefined) {
					astRefsRewritten += mapCasePropertiesInPredicate(
						condition,
						resolveCaseProperty,
					);
				}
				break;
			}
			case "excluded_owner_ids": {
				const excluded = mod.caseSearchConfig?.excludedOwnerIds;
				if (excluded !== undefined) {
					astRefsRewritten += mapCasePropertiesInExpression(
						excluded,
						resolveCaseProperty,
					);
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
