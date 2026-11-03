/**
 * `FORM_LINK_NEEDS_NEW_CASE_DATUM` (soundness, located at the form): an
 * after-submit link hands a new case to its target, and the place the
 * create is kept gives that case no session value for the target to read.
 *
 * A link's target reads a new case through the session value HQ's entry
 * gives it (`suite_xml/post_process/workflow.py::_find_best_match` over
 * `suite_xml/sections/entries.py::EntriesHelper.get_new_case_id_datums_meta`
 * for a basic form, `configure_entry_advanced_form` for an advanced one). A
 * basic form gives one to the registration's own case and to a subcase at
 * the form root; an advanced form gives one to every open action outside a
 * repeat. So a carried create (`formLinkProjection.ts::carriedCreateLinks`)
 * that a basic form keeps elsewhere makes its menu advanced
 * (`moduleKind.ts::emittedModuleKind`), and this rule refuses the document
 * exactly where that cannot help: the menu stays basic because something
 * keeps it from being advanced (`lib/domain/advancedModule.ts::
 * advancedKindBlockers`), or the menu is advanced and the create cannot be
 * an open action (`advancedPlacement.ts::openActionIneligibility`).
 *
 * The finding names the link that carries the create, why, and two ways
 * out: sending the link to a menu, where workers choose the case, or the
 * change that lets the case be handed on.
 */

import { openActionIneligibility } from "@/lib/commcare/advancedPlacement";
import { carriedCreateLinks } from "@/lib/commcare/formLinkProjection";
import { planPlacements } from "@/lib/commcare/placement";
import {
	type AdvancedIneligibility,
	type AdvancedKindBlocker,
	advancedKindBlockers,
	type BlueprintDoc,
	type CaseOperation,
	type CasePlacement,
	type FormLinkTarget,
	ownRecordValue,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";

/** Why a carried create gets no session value: the first that holds. */
export type NewCaseDatumCause =
	| {
			readonly kind: "blocker";
			readonly blocker: AdvancedKindBlocker;
			readonly moduleName: string;
	  }
	| { readonly kind: "ineligible"; readonly reason: AdvancedIneligibility };

/** The reason clause and the remedy clause of a cause, which the finding
 *  carries for the validator's message and the builder's sentence. */
export function newCaseDatumCauseWords(
	cause: NewCaseDatumCause,
	caseType: string,
): { readonly reason: string; readonly remedy: string } {
	if (cause.kind === "blocker") {
		const { blocker, moduleName } = cause;
		switch (blocker.kind) {
			case "several-cases":
				return {
					reason: `"${moduleName}" lets workers choose several cases, and CommCare HQ can hand a new case on only from a menu where they choose one`,
					remedy: `let workers choose one case in "${moduleName}"`,
				};
			case "forms-read-search":
				return {
					reason: `the forms in "${moduleName}" read its search, which CommCare HQ can't keep while handing a new case on`,
					remedy: `turn off Forms read the search in "${moduleName}"`,
				};
			case "case-list-menu-item-narrowed": {
				const what =
					blocker.why === "filter"
						? "filter"
						: blocker.why === "hidden-owners"
							? "hidden owners"
							: "parent case";
				return {
					reason: `"${moduleName}" shows its case list in the menu, and handing a new case on would make that list show every open case, without its ${what}`,
					remedy: "remove the case list from the menu",
				};
			}
			case "chain-index":
				return {
					reason: `${blocker.childType} cases link to their ${blocker.parentType} case under more than one name (${blocker.identifiers.join(", ")}), so CommCare HQ couldn't tell which ones to list`,
					remedy: "link them under one name",
				};
			default: {
				const _exhaustive: never = blocker;
				return _exhaustive;
			}
		}
	}
	switch (cause.reason) {
		case "value-not-a-question":
			return {
				reason: "the new case saves a calculated value",
				remedy: "save that value from a question",
			};
		case "name-repeat":
			return {
				reason: "the new case takes its name from a question in another repeat",
				remedy: "name it from a question in its own repeat",
			};
		case "write-condition":
			return {
				reason: "one of its values is saved only when a condition holds",
				remedy: "save that value every time",
			};
		case "condition-not-stateable":
			return {
				reason: "CommCare HQ can't state the condition it is created under",
				remedy: "compare a question with one of its choices",
			};
		case "owner":
			return {
				reason: "its owner comes from a place in your organization",
				remedy: "let the worker who submits it own it",
			};
		case "link-target":
			return {
				reason: "it links to a case this form doesn't choose or create first",
				remedy: "link it to the case this form opens or creates",
			};
		case "link-renamed-load":
			return {
				reason: "it links to a case this menu shares with the menu above it",
				remedy: "link it to this form's own case",
			};
		case "repeat-shared":
			return {
				reason:
					"it shares its repeat with another new case that links to nothing",
				remedy: "link both to a case",
			};
		case "type-not-a-menu":
			return {
				reason: `no menu lists ${caseType} cases`,
				remedy: `add a menu for ${caseType} cases`,
			};
		case "case-changed-before-create":
			return {
				reason:
					"another case change in the form updates or closes it, which CommCare HQ would do before creating it",
				remedy: "save those values when it is created",
			};
		// A carried create is a `create` with no repeat and no key, or the
		// registration's own case, so the clauses below never reach this
		// rule; each still reads as a person would say it.
		case "scope":
			return {
				reason: "CommCare HQ can't create it through a case action",
				remedy: "create it at the top of the form",
			};
		case "keyed":
			return {
				reason: "its case id comes from an answer",
				remedy: "give it a new id each time it is created",
			};
		case "via-on-indexed-load":
			return {
				reason: "one of its saves goes to a case above it",
				remedy: "save that value on the new case itself",
			};
		case "retype":
			return {
				reason: "it changes its case's type",
				remedy: "keep its case type",
			};
		case "worker-property-name":
			return {
				reason:
					"one of its saves names a worker property case actions can't save",
				remedy: "rename that worker property",
			};
		default: {
			const _exhaustive: never = cause.reason;
			return _exhaustive;
		}
	}
}

/** The validator's message: the voice the SA and MCP read. The builder's
 *  sentence frames the same clauses (`lib/doc/userFacingErrors.ts`). */
export function formLinkNeedsNewCaseDatumMessage(parts: {
	readonly formName: string;
	readonly targetName: string;
	readonly caseType: string;
	readonly reason: string;
	readonly remedy: string;
	readonly menuName: string | undefined;
}): string {
	const { formName, targetName, caseType, reason, remedy, menuName } = parts;
	const instead =
		menuName === undefined
			? "You can send that link to the app's home screen instead"
			: `You can send that link to the "${menuName}" menu instead, where workers choose the case`;
	return `"${formName}" can't hand its new ${caseType} case to "${targetName}" after it is submitted: ${reason}. ${instead}, or ${remedy}.`;
}

/**
 * The menu a link to `target` could go to instead, where workers choose
 * the case: the target's own menu where CommCare HQ offers it as a link
 * target, else the menu above it. HQ's form settings offer a menu that is
 * at the top level, or a child menu whose parent lists the same case type
 * as the source menu's parent (`views/forms.py::_get_linkable_forms_context`,
 * `is_top_level` and `is_child_match`). Every top-level menu is offered, so
 * only a target whose menu is gone has none.
 */
export function offeredMenuFor(
	doc: BlueprintDoc,
	sourceModuleUuid: Uuid,
	target: FormLinkTarget,
): Uuid | undefined {
	const candidate = ownRecordValue(doc.modules, target.moduleUuid);
	if (candidate === undefined) return undefined;
	const candidateParent = candidate.parentModuleUuid;
	if (candidateParent === undefined) return target.moduleUuid;
	const sourceParent = ownRecordValue(
		doc.modules,
		sourceModuleUuid,
	)?.parentModuleUuid;
	const sourceRoot =
		sourceParent === undefined
			? undefined
			: ownRecordValue(doc.modules, sourceParent);
	const candidateRoot = ownRecordValue(doc.modules, candidateParent);
	if (
		sourceRoot !== undefined &&
		candidateRoot !== undefined &&
		sourceRoot.caseType === candidateRoot.caseType
	)
		return target.moduleUuid;
	return candidateRoot === undefined ? undefined : candidateParent;
}

/** Whether `placement` gives the created case of `operation` a session
 *  value in a form of `formKind`. */
function givesDatum(
	formKind: "basic" | "advanced",
	registration: boolean,
	operation: CaseOperation,
	placement: CasePlacement | undefined,
): boolean {
	if (placement === undefined) return false;
	const opens =
		(operation.action === "own" && registration) ||
		(operation.action === "create" && operation.forEach === undefined);
	if (!opens) return false;
	if (formKind === "advanced")
		return placement.kind === "advanced" && placement.row !== true;
	if (placement.kind !== "basic") return false;
	return operation.action === "own"
		? placement.slot === "own"
		: placement.slot === "subcase";
}

function targetName(doc: BlueprintDoc, target: FormLinkTarget): string {
	return target.type === "form"
		? (ownRecordValue(doc.forms, target.formUuid)?.name ?? "")
		: (ownRecordValue(doc.modules, target.moduleUuid)?.name ?? "");
}

/** Every `FORM_LINK_NEEDS_NEW_CASE_DATUM` finding of `formUuid`, one per
 *  carried create that gets no session value, in operation order. */
export function formLinkNeedsNewCaseDatum(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleUuid: Uuid,
): ValidationError[] {
	const form = ownRecordValue(doc.forms, formUuid);
	const module = ownRecordValue(doc.modules, moduleUuid);
	if (form === undefined || module === undefined) return [];
	const carried = carriedCreateLinks(doc, formUuid);
	if (carried.size === 0) return [];
	const plan = planPlacements(doc, formUuid);
	const operations = form.caseOperations ?? [];
	const registration = form.type === "registration";
	const errors: ValidationError[] = [];
	for (const [operationUuid, linkUuid] of carried) {
		const operation = operations.find((op) => op.uuid === operationUuid);
		const link = form.formLinks?.find((l) => l.uuid === linkUuid);
		if (operation === undefined || link === undefined) continue;
		const placement = plan.placements.get(operationUuid)?.placement;
		if (givesDatum(plan.formKind, registration, operation, placement)) continue;
		let cause: NewCaseDatumCause | undefined;
		if (plan.formKind === "basic") {
			// A basic menu whose carried create gets no session value is one a
			// blocker keeps basic; with no blocker it would be advanced.
			const blocker = advancedKindBlockers(doc, moduleUuid)[0];
			if (blocker !== undefined)
				cause = { kind: "blocker", blocker, moduleName: module.name };
		} else {
			// An advanced form gives a create an open action wherever no
			// clause keeps it from one.
			const reason = openActionIneligibility(
				doc,
				formUuid,
				operation.action === "own" ? "own" : operation.uuid,
			);
			if (reason !== undefined) cause = { kind: "ineligible", reason };
		}
		if (cause === undefined) continue;
		const caseType =
			operation.action === "create"
				? operation.caseType
				: (module.caseType ?? "");
		const { reason, remedy } = newCaseDatumCauseWords(cause, caseType);
		const menuUuid = offeredMenuFor(doc, moduleUuid, link.target);
		const menuName =
			menuUuid === undefined
				? undefined
				: ownRecordValue(doc.modules, menuUuid)?.name;
		const words = {
			formName: form.name,
			targetName: targetName(doc, link.target),
			caseType,
			reason,
			remedy,
			menuName,
		};
		errors.push(
			validationError(
				"FORM_LINK_NEEDS_NEW_CASE_DATUM",
				"form",
				formLinkNeedsNewCaseDatumMessage(words),
				{
					moduleUuid,
					moduleName: module.name,
					formUuid,
					formName: form.name,
				},
				{
					formUuid,
					formName: form.name,
					linkUuid,
					targetName: words.targetName,
					operationUuid,
					caseType,
					cause: JSON.stringify(cause),
					reason,
					remedy,
					...(menuName !== undefined && { menuName }),
				},
			),
		);
	}
	return errors;
}
