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
 *
 * A menu's kind, ordinary or advanced, is document-wide in the same way: it
 * decides where every form of the menu keeps its case changes and the
 * session values every link into the menu reads. The commit gate takes the
 * absolute gate for any batch whose candidate emits some menu as another
 * kind (`commitVerdicts.ts`, through `lib/commcare/moduleKind.ts`), whatever
 * edit did it. Which creates a form's links carry also decides the session
 * values that form's entry gives, which links from other forms read, so an
 * edit that can change them takes it here: a held kind, a form's links, and
 * in a form with links an operation added, removed or reordered, or an
 * operation's links, repeat and target.
 */

import { formHoldsPlacement } from "@/lib/doc/heldIdentity";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import {
	caseListRegistrationFormOf,
	formLinkEntries,
	orderedCaseOperations,
} from "@/lib/domain";
import { modulesSelectingThrough } from "@/lib/domain/entryDatumSupplies";
import { inferenceFingerprint } from "@/lib/domain/expression/inference";
import { childModuleUuids, moduleParent } from "@/lib/domain/moduleHierarchy";

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
		if (formLinkEntries(form).length > 0) scope.formUuids.add(form.uuid);
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
	 * under it whose selections align with its own: a switch
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
	/* A held placement's rules read the whole form and its module, and a
	 * field edit can strand a hold, so a form that holds one takes its
	 * module's scope. A form that holds none keeps its own. */
	if (formHoldsPlacement(doc, formUuid)) {
		const moduleUuid = owningModule(doc, formUuid);
		if (moduleUuid === undefined) return false;
		addWholeModule(doc, moduleUuid, scope);
	}
	addFormLinkSources(doc, scope);
	return true;
}

/** The whole-module scope: the module's rules and every form of it. */
function addWholeModule(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	scope: MutableScope,
): void {
	scope.moduleUuids.add(moduleUuid);
	for (const formUuid of doc.formOrder[moduleUuid] ?? [])
		scope.formUuids.add(formUuid);
}

/** Every form in a module can read its Search: the forms of a menu whose
 * forms read the search read what it found, and its case list registration
 * form reads the Search fields. A Search edit can withdraw that supply, so each of those forms'
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

/** Whether an edit of an existing case operation can change which creates
 *  its form's links carry: a create's place among the form's new cases (a
 *  reorder), its links, its repeat, or its target (a key in `idFrom`). */
function changesCarriedCreates(
	patch: Extract<Mutation, { kind: "updateForm" }>["caseOperationPatch"],
): boolean {
	if (patch === undefined) return false;
	switch (patch.operation) {
		case "move":
		case "add-link":
		case "update-link":
		case "remove-link":
		case "move-link":
			return true;
		case "update":
			return (
				Object.hasOwn(patch.patch, "forEach") ||
				Object.hasOwn(patch.patch, "target")
			);
		default:
			return false;
	}
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
			/* A case list registration form reads the module's Search fields by
			 * identity: an input's kind types every read of it there, and
			 * removing one can leave a dangling read on that form. */
			case "updateSearchInput":
			case "removeSearchInput": {
				scope.moduleUuids.add(mutation.moduleUuid);
				const registrationForm = caseListRegistrationFormOf(
					doc,
					mutation.moduleUuid,
				);
				if (registrationForm !== undefined)
					scope.formUuids.add(registrationForm);
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
			/* Whether the menu lists its case list is read by the module's own
			 * rules (`NO_FORMS_OR_CASE_LIST`), by its child modules' parent
			 * rules, by the destinations its forms are offered (a bare case
			 * list), and by the session an entry through the list supplies,
			 * which links into the module read. */
			case "setCaseListMenuItem": {
				if (doc.modules[mutation.uuid] === undefined) return undefined;
				addWholeModule(doc, mutation.uuid, scope);
				for (const child of childModuleUuids(doc, mutation.uuid))
					addWholeModule(doc, child, scope);
				addFormLinkSources(doc, scope);
				break;
			}
			case "renameModule":
				scope.moduleUuids.add(mutation.uuid);
				break;
			case "updateModule": {
				/* A module case-type/mode change alters the session requirements seen
				 * by form links elsewhere in the app. Turning Forms read the search
				 * on or off gives or takes its search instance from a submenu or a
				 * parent-select child, whose own rules must run, and the platform
				 * rule reads it; it rewrites its forms' after-submit destinations
				 * too. Naming a case list registration form moves a form on or off
				 * the menu, which the module's structural rules and every link
				 * targeting the form read. All other module settings own only this
				 * module's rules. */
				if (
					Object.hasOwn(mutation.patch, "caseType") ||
					Object.hasOwn(mutation.patch, "parentCaseModuleUuid") ||
					Object.hasOwn(mutation.patch, "caseListRegistrationForm") ||
					(mutation.caseSearchConfigPatch !== undefined &&
						Object.hasOwn(mutation.caseSearchConfigPatch, "formsReadSearch"))
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

			/* Media mutates only its owning form. */
			case "setFormMedia":
				scope.formUuids.add(mutation.uuid);
				break;
			case "renameForm":
				scope.formUuids.add(mutation.uuid);
				break;
			case "updateForm": {
				/* A type change moves the form between the case-loading and the
				 * other forms, which decides whether its module lands on its case
				 * list (`isCaseFirstModule`), what a child menu selecting through it
				 * reads, and the action inventory links elsewhere consume. It takes
				 * the whole-document gate. */
				if (Object.hasOwn(mutation.patch, "type")) {
					return undefined;
				}
				/* Which creates a form's links carry decides where the form keeps
				 * them and the session values its entry gives them, which links
				 * from other forms read: in a form with links, an operation
				 * added, removed, reordered, or given other links, another
				 * repeat or another target. */
				if (
					(doc.forms[mutation.uuid]?.formLinks?.length ?? 0) > 0 &&
					(mutation.caseOperationChange !== undefined ||
						(mutation.caseOperationPatch !== undefined &&
							changesCarriedCreates(mutation.caseOperationPatch)))
				) {
					return undefined;
				}
				const moduleUuid = owningModule(doc, mutation.uuid);
				if (moduleUuid === undefined) return undefined;
				/* A case change, or the form's open or close condition, decides
				 * where its form's case changes are placed, which reads the whole
				 * form and its module (part 01 §13.3), so the module and every form
				 * in it re-run. Operation writes declare and type case properties
				 * that case-list rules in any module and operations in any form
				 * read, and the action inventory reaches links whose findings sit
				 * on other forms. Other form settings are confined to this form. */
				if (
					mutation.caseOperationChange !== undefined ||
					mutation.caseOperationPatch !== undefined ||
					Object.hasOwn(mutation.patch, "openCondition") ||
					Object.hasOwn(mutation.patch, "closeCondition")
				) {
					addWholeModule(doc, moduleUuid, scope);
					if (
						mutation.caseOperationChange !== undefined ||
						mutation.caseOperationPatch !== undefined
					) {
						addAllModuleRules(doc, scope);
						addCaseOperationForms(doc, scope);
					}
					addFormLinkSources(doc, scope);
				}
				scope.formUuids.add(mutation.uuid);
				break;
			}
			/* A form's links decide which of its creates they carry, and so its
			 * menu's kind (`lib/commcare/moduleKind.ts`), which moves every form
			 * of the menu and every link into it. */
			case "addFormLink":
			case "updateFormLink":
			case "removeFormLink":
			case "moveFormLink":
				return undefined;
			/* An otherwise link carries creates as a destination does, so a
			 * change that holds a link on either side takes the whole-document
			 * gate with the four link kinds. A built-in otherwise changes only
			 * where its own form goes. A later change of the menu's shape moves
			 * it to the nearest destination still offered in the same reducer
			 * step (`mutations/modules.ts::reconcilePostSubmitWithMenuShape`). */
			case "setFormOtherwise": {
				const form = doc.forms[mutation.formUuid];
				if (form === undefined) return undefined;
				if (
					form.otherwise?.kind === "link" ||
					mutation.otherwise?.kind === "link"
				) {
					return undefined;
				}
				scope.formUuids.add(mutation.formUuid);
				break;
			}
			/* A held placement decides where its form's case changes are
			 * placed, which reads the whole form and its module (part 01
			 * §13.3), so the module of each target's form re-runs. */
			case "holdPlacements":
				for (const hold of mutation.holds) {
					/* A menu's held kind decides its kind, which moves every form
					 * of it and every link into it. */
					if (hold.target === "module-kind") return undefined;
					const formUuid =
						hold.target === "query-repeat"
							? findContainingForm(doc, hold.fieldUuid)
							: hold.formUuid;
					const moduleUuid =
						formUuid === undefined ? undefined : owningModule(doc, formUuid);
					if (moduleUuid === undefined) return undefined;
					addWholeModule(doc, moduleUuid, scope);
				}
				break;

			/* The app's name and logo have no module or form dependency. */
			case "setAppName":
			case "setAppLogo":
				break;
			/* The platform declaration is read by the platform rule and by the
			 * checker in every slot, so a patch that names it takes the
			 * whole-document gate; the two home-screen switches are read by no
			 * rule. */
			case "setAppSettings":
				if (mutation.settings.runsOnlyOn !== undefined) return undefined;
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
