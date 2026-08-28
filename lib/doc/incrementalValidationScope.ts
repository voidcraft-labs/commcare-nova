/**
 * Dependency footprints for validity-preserving Builder commits.
 *
 * The Blueprint store contains a valid snapshot. For a mutation family whose
 * writes are confined to one known form or module, the scoped validator can
 * re-check that complete footprint while still running every app-wide and
 * lookup rule. The scoped-run equivalence then proves the untouched portion
 * remains valid. Unknown, cross-scope, or structurally ambiguous mutations
 * return `undefined` and take the absolute whole-document gate.
 */

import { findContainingForm } from "@/lib/doc/mutations/helpers";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import { orderedCaseOperations } from "@/lib/domain";

/** Structural twin of the validator scope kept on the domain side of the
 * CommCare boundary. `commitVerdicts` is the allowlisted adapter that passes
 * this footprint into the validator. */
export interface IncrementalValidationScope {
	readonly moduleUuids?: ReadonlySet<Uuid>;
	readonly formUuids?: ReadonlySet<Uuid>;
}

interface MutableScope {
	readonly moduleUuids: Set<Uuid>;
	readonly formUuids: Set<Uuid>;
}

function addAllModuleRules(doc: BlueprintDoc, scope: MutableScope): void {
	for (const moduleUuid of doc.moduleOrder) scope.moduleUuids.add(moduleUuid);
}

/** Case-operation expression types are derived against the app-wide writer
 * catalog. Retargeting one ordinary field can therefore add a type opinion to
 * an operation in another form even though that form's own entity is
 * unchanged. Re-run exactly the forms that own operations; forms without an
 * operation cannot produce a case-operation finding. */
function addCaseOperationForms(doc: BlueprintDoc, scope: MutableScope): void {
	for (const form of Object.values(doc.forms)) {
		if (orderedCaseOperations(form).length > 0) scope.formUuids.add(form.uuid);
	}
}

function owningModule(doc: BlueprintDoc, formUuid: Uuid): Uuid | undefined {
	return doc.moduleOrder.find((moduleUuid) =>
		(doc.formOrder[moduleUuid] ?? []).includes(formUuid),
	);
}

/** Form-link validation on a source form derives the action inventory of its
 * targets. A field edit in any target can therefore change a finding anchored
 * at that source. Including every authored link source is conservative and
 * usually empty; it keeps the footprint sound without rebuilding a parallel
 * form-link dependency graph. */
function addFormLinkSources(doc: BlueprintDoc, scope: MutableScope): void {
	for (const form of Object.values(doc.forms)) {
		if ((form.formLinks?.length ?? 0) > 0) scope.formUuids.add(form.uuid);
	}
}

function addFieldForm(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	scope: MutableScope,
): boolean {
	const formUuid = findContainingForm(doc, fieldUuid);
	if (formUuid === undefined) return false;
	scope.formUuids.add(formUuid);
	addFormLinkSources(doc, scope);
	return true;
}

/** Return the exact validator footprint for a conservatively safe batch. */
export function incrementalValidationScope(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): IncrementalValidationScope | undefined {
	if (mutations.length === 0) return undefined;
	const scope: MutableScope = {
		moduleUuids: new Set(),
		formUuids: new Set(),
	};

	for (const mutation of mutations) {
		switch (mutation.kind) {
			/* A field scalar or option edit can alter field/form/deep findings in
			 * its containing form. Cross-form writer/type/translation and lookup
			 * constraints are app-wide or lookup rules, which always run. */
			case "updateField":
				/* A case destination contributes to the effective case-property
				 * catalog consumed by case-list rules in any module. Re-run every
				 * module rule when that destination changes; module scope is
				 * independent from form scope, so this does not walk their forms. */
				if (Object.hasOwn(mutation.patch, "caseWrite")) {
					addAllModuleRules(doc, scope);
					addCaseOperationForms(doc, scope);
				}
				if (!addFieldForm(doc, mutation.uuid, scope)) return undefined;
				break;
			case "setFieldMedia":
				if (!addFieldForm(doc, mutation.fieldUuid, scope)) {
					return undefined;
				}
				break;
			case "addOption":
			case "updateOption":
			case "removeOption":
			case "moveOption":
				if (!addFieldForm(doc, mutation.fieldUuid, scope)) return undefined;
				break;

			/* These collections are owned wholly by one module. */
			case "addColumn":
			case "updateColumn":
			case "removeColumn":
			case "moveColumn":
			case "addSearchInput":
			case "updateSearchInput":
			case "removeSearchInput":
			case "moveSearchInput":
				scope.moduleUuids.add(mutation.moduleUuid);
				break;
			case "setCaseListMeta":
			case "setModuleMedia":
				scope.moduleUuids.add(mutation.uuid);
				break;
			case "renameModule":
				scope.moduleUuids.add(mutation.uuid);
				break;
			case "updateModule": {
				/* A module case-type/mode change alters the session requirements seen
				 * by form links elsewhere in the app. All other module settings own
				 * only this module's rules. */
				if (
					Object.hasOwn(mutation.patch, "caseType") ||
					Object.hasOwn(mutation.patch, "caseListOnly")
				) {
					return undefined;
				}
				scope.moduleUuids.add(mutation.uuid);
				break;
			}

			/* Media and after-submit links mutate only their owning form. Link
			 * cycles remain covered because cycle detection is app-wide. */
			case "setFormMedia":
				scope.formUuids.add(mutation.uuid);
				break;
			case "renameForm":
				scope.formUuids.add(mutation.uuid);
				break;
			case "updateForm": {
				/* Type and case-action changes alter the action inventory consumed by
				 * links whose findings are anchored on other forms. Other form
				 * settings are confined to this form. */
				if (
					mutation.caseOperationChange !== undefined ||
					mutation.caseOperationPatch !== undefined ||
					Object.hasOwn(mutation.patch, "type")
				) {
					return undefined;
				}
				const moduleUuid = owningModule(doc, mutation.uuid);
				if (moduleUuid === undefined) return undefined;
				scope.formUuids.add(mutation.uuid);
				break;
			}
			case "addFormLink":
			case "updateFormLink":
			case "removeFormLink":
			case "moveFormLink":
				scope.formUuids.add(mutation.formUuid);
				break;

			/* App-owned scalar presentation has no module/form dependency. */
			case "setAppName":
			case "setAppLogo":
				break;

			default:
				return undefined;
		}
	}

	return {
		...(scope.moduleUuids.size > 0 && { moduleUuids: scope.moduleUuids }),
		...(scope.formUuids.size > 0 && { formUuids: scope.formUuids }),
	};
}
