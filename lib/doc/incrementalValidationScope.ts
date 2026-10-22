/**
 * Dependency footprints for validity-preserving Builder commits.
 *
 * The Blueprint store contains a valid snapshot. For a mutation family whose
 * writes are confined to one known form or module, the scoped validator can
 * re-check that complete footprint while still running every app-wide and
 * lookup rule. The scoped-run equivalence then proves the untouched portion
 * remains valid. Unknown, cross-scope, or structurally ambiguous mutations
 * return `undefined` and take the absolute whole-document gate.
 *
 * Expression inference is document-wide: a Hidden Value's type, a case
 * operation's write opinion and every effective case-property type are one
 * fixpoint over all forms, so an edit in one form can move a verdict in any
 * other form or module through it. A form outside the footprint was not
 * edited, and its verdicts read only its own content, its module, and those
 * inferred facts. A batch therefore keeps its footprint only while
 * `inferenceFingerprint` is the same before and after it; any change to an
 * inferred fact takes the absolute gate.
 */

import { findContainingForm } from "@/lib/doc/mutations/helpers";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import { noMatchesFormOf, orderedCaseOperations } from "@/lib/domain";
import { modulesSelectingThrough } from "@/lib/domain/entryDatumSupplies";
import { inferenceFingerprint } from "@/lib/domain/expression/inference";
import { moduleParent } from "@/lib/domain/moduleHierarchy";

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

/** Selection changes alter four bounded validator dependencies: the edited
 * module's own topology, its direct parent's child-consumer topology, every
 * form the edited module owns, and every source form whose link may target the
 * edited module. The document snapshot is valid before the edit, so any
 * missing structural owner makes the footprint unprovable and falls back to
 * the absolute gate. */
function addCaseSelectionDependencies(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	scope: MutableScope,
): boolean {
	const module = doc.modules[moduleUuid];
	if (module === undefined) return false;

	scope.moduleUuids.add(moduleUuid);
	if (module.parentModuleUuid !== undefined) {
		if (doc.modules[module.parentModuleUuid] === undefined) return false;
		scope.moduleUuids.add(module.parentModuleUuid);
	}

	for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
		if (doc.forms[formUuid] === undefined) return false;
		scope.formUuids.add(formUuid);
	}
	/* A case list, a search or a form menu that reads the case chosen in this
	 * module runs in a module that chooses through it, or in a menu nested
	 * under it whose selections align with its own (part 05 §1.7): a switch
	 * to several cases refuses those reads, so their rules must run. */
	const readers = new Set<Uuid>(modulesSelectingThrough(doc, moduleUuid));
	for (let grew = true; grew; ) {
		grew = false;
		for (const candidate of Object.keys(doc.modules) as Uuid[]) {
			const parent = moduleParent(doc, candidate);
			if (
				!readers.has(candidate) &&
				parent !== undefined &&
				parent !== null &&
				(parent === moduleUuid || readers.has(parent))
			) {
				readers.add(candidate);
				grew = true;
			}
		}
	}
	for (const reader of readers) {
		scope.moduleUuids.add(reader);
		for (const formUuid of doc.formOrder[reader] ?? [])
			scope.formUuids.add(formUuid);
	}
	addFormLinkSources(doc, scope);
	return true;
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

/** Every form in a module can read its Search: a Search-first module's
 * forms read what the search found, and its no-matches form reads the
 * prompts. A Search edit can withdraw that supply, so each of those forms'
 * own rules must run, and so must every link source, whose target's frame
 * the Search shapes. */
function addModuleSearchReaders(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	scope: MutableScope,
): void {
	scope.moduleUuids.add(moduleUuid);
	for (const formUuid of doc.formOrder[moduleUuid] ?? [])
		scope.formUuids.add(formUuid);
	addFormLinkSources(doc, scope);
}

/** Return the exact validator footprint for a conservatively safe batch.
 * `doc` is the valid snapshot the batch applies to and `nextDoc` the
 * candidate it produces. */
export function incrementalValidationScope(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
	nextDoc: BlueprintDoc,
): IncrementalValidationScope | undefined {
	const scope = mutationFootprint(doc, mutations);
	if (scope === undefined) return undefined;
	if (
		nextDoc !== doc &&
		inferenceFingerprint(doc) !== inferenceFingerprint(nextDoc)
	)
		return undefined;
	return scope;
}

function mutationFootprint(
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
			case "moveSearchInput":
				scope.moduleUuids.add(mutation.moduleUuid);
				break;
			/* A no-matches registration form reads the module's Search prompts
			 * by identity: an input's kind types every read of it there, and
			 * removing one can leave a dangling read on that form. */
			case "updateSearchInput":
			case "removeSearchInput": {
				scope.moduleUuids.add(mutation.moduleUuid);
				const noMatchesForm = noMatchesFormOf(doc, mutation.moduleUuid);
				if (noMatchesForm !== undefined)
					scope.formUuids.add(noMatchesForm.uuid);
				break;
			}
			case "setCaseListMeta":
				if (
					Object.hasOwn(mutation.patch, "selection") &&
					!addCaseSelectionDependencies(doc, mutation.uuid, scope)
				) {
					return undefined;
				}
				if (!Object.hasOwn(mutation.patch, "selection")) {
					scope.moduleUuids.add(mutation.uuid);
				}
				break;
			case "setModuleMedia":
				scope.moduleUuids.add(mutation.uuid);
				break;
			case "renameModule":
				scope.moduleUuids.add(mutation.uuid);
				break;
			case "updateModule": {
				/* A module case-type/mode change alters the session requirements seen
				 * by form links elsewhere in the app. Opening the module on Search
				 * gives its search instance to a submenu or a parent-select child,
				 * whose own rules must run, and rewrites its forms' after-submit
				 * destinations. All other module settings own only this module's
				 * rules. */
				if (
					Object.hasOwn(mutation.patch, "caseType") ||
					Object.hasOwn(mutation.patch, "parentCaseModuleUuid") ||
					Object.hasOwn(mutation.patch, "caseListOnly") ||
					mutation.caseSearchConfigPatch?.searchFirst === true
				) {
					return undefined;
				}
				scope.moduleUuids.add(mutation.uuid);
				/* Any other Search change, a patch or a semantic operation, can
				 * take away the search results or the Search answers a form in
				 * the module reads; those forms' own rules must run. */
				if (
					mutation.caseSearchConfigPatch !== undefined ||
					mutation.caseSearchConfigOperation !== undefined
				)
					addModuleSearchReaders(doc, mutation.uuid, scope);
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
				 * links whose findings are anchored on other forms. An entry change
				 * moves the form on or off the module menu, which the module's
				 * structural rules and every link targeting the form read. Other
				 * form settings are confined to this form. */
				if (
					mutation.caseOperationChange !== undefined ||
					mutation.caseOperationPatch !== undefined ||
					Object.hasOwn(mutation.patch, "type") ||
					Object.hasOwn(mutation.patch, "entry")
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

			/* App-owned scalar presentation has no module/form dependency, and
			 * no rule reads the app settings. */
			case "setAppName":
			case "setAppLogo":
			case "setAppSettings":
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
