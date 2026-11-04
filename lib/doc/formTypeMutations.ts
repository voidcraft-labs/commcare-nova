// lib/doc/formTypeMutations.ts
//
// The planners that keep a form's own case where it belongs when the form's
// type, its module's case type or its module changes.
//
// The own arm (`action: "own"`) stands first in every registration, follow-up
// and close form of a module with a case type, and on no other form
// (`CASE_OWN_OPERATION`). It stores no case type: its type is its module's,
// and its lifecycle is the form's type with `openCondition` and
// `closeCondition`. So a change of any of those carries the arm, the two
// conditions and the catalog entries its writes need in the same batch, and
// the gesture lands valid. Each planner returns ordinary mutations; the
// commit gate still judges the batch.
//
// A held own close (`Form.ownClosePlacement`) is left alone here: whether a
// held placement survives is decided by the placement planner of pull request
// 5 (`placementMoves.ts`), never by the type change itself.

import type {
	BlueprintDoc,
	Expression,
	Form,
	FormType,
	OwnCaseOperation,
	Uuid,
} from "@/lib/domain";
import type { CaseTypeRetirement } from "./caseTypeRetirement";
import { findContainingForm } from "./mutations/helpers";
import {
	bareFieldRead,
	caseTypeCatalogMutations,
	catalogMutationsForOperations,
	ownCaseOperation,
} from "./scaffolds";
import type { Mutation } from "./types";

/** A planned form-type change, or the sentence that says why it can't land. */
export type FormTypeChangePlan =
	| { readonly ok: true; readonly mutations: readonly Mutation[] }
	| { readonly ok: false; readonly message: string };

export interface FormTypeChangeOptions {
	/** The question a registration names its new case from, when the own
	 *  case has no name yet (a survey, follow-up or close form becoming a
	 *  registration). */
	readonly nameField?: Uuid;
}

/** The refusal for a registration whose new case would have no name. */
export const CHOOSE_NAME_QUESTION_MESSAGE =
	"Choose the question that names the new case.";
/** The refusal for a registration whose own case keeps a write a new case
 *  cannot hold. */
export const NEW_CASE_WRITE_FACETS_MESSAGE =
	"A new case has no earlier value or case above it. Remove Save only if changed and any save to a case above it first.";

const FORM_GONE_MESSAGE = "This form is no longer part of the app.";

function owningModuleUuid(doc: BlueprintDoc, formUuid: Uuid): Uuid | undefined {
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		if (formUuids.includes(formUuid)) return moduleUuid as Uuid;
	}
	return undefined;
}

function ownOperationOf(form: Form): OwnCaseOperation | undefined {
	return form.caseOperations?.find(
		(operation): operation is OwnCaseOperation => operation.action === "own",
	);
}

function otherOperationIds(form: Form): Set<string> {
	return new Set(
		(form.caseOperations ?? [])
			.filter((operation) => operation.action !== "own")
			.map((operation) => operation.id),
	);
}

function updateFormPatch(
	formUuid: Uuid,
	patch: Extract<Mutation, { kind: "updateForm" }>["patch"],
): Mutation {
	return { kind: "updateForm", uuid: formUuid, patch };
}

function addOwnMutation(formUuid: Uuid, own: OwnCaseOperation): Mutation {
	return {
		kind: "updateForm",
		uuid: formUuid,
		patch: {},
		caseOperationChange: { operation: "add", value: own },
	};
}

/**
 * The batch that changes `formUuid`'s type to `type`, carrying its own case
 * and its open and close conditions (the table below):
 *
 * - survey → registration adds the own case, named by a bare read of
 *   `options.nameField`; survey → follow-up or close adds it with no writes.
 * - to survey removes the own case (its writes go with it) and both
 *   conditions.
 * - registration → follow-up or close keeps the own case and clears the open
 *   condition; follow-up clears the close condition, close keeps one that is
 *   not `match-all`.
 * - follow-up or close → registration keeps the own case, refuses a write a
 *   new case cannot hold, names the case from `options.nameField` when it has
 *   no name, and drops the close condition.
 * - close → follow-up drops the close condition.
 *
 * The own case belongs only to a form of a module with a case type, so on a
 * form of a module without one the planner changes the type alone and the
 * gate judges it.
 */
export function planFormTypeChange(
	doc: BlueprintDoc,
	formUuid: Uuid,
	type: FormType,
	options: FormTypeChangeOptions = {},
): FormTypeChangePlan {
	const form = doc.forms[formUuid];
	const moduleUuid = owningModuleUuid(doc, formUuid);
	if (form === undefined || moduleUuid === undefined) {
		return { ok: false, message: FORM_GONE_MESSAGE };
	}
	const from = form.type;
	if (from === type) return { ok: true, mutations: [] };
	const caseType = doc.modules[moduleUuid]?.caseType;
	const own = ownOperationOf(form);
	const patch: Extract<Mutation, { kind: "updateForm" }>["patch"] = { type };
	const mutations: Mutation[] = [];

	if (type === "survey") {
		if (form.openCondition !== undefined) patch.openCondition = null;
		if (form.closeCondition !== undefined) patch.closeCondition = null;
		mutations.push(updateFormPatch(formUuid, patch));
		if (own !== undefined) {
			mutations.push({
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationChange: { operation: "remove", uuid: own.uuid },
			});
		}
		return { ok: true, mutations };
	}

	const nameRead = nameReadFrom(doc, formUuid, options.nameField);
	if (type === "registration") {
		if (own !== undefined && ownWritesNeedLoadedCase(own)) {
			return { ok: false, message: NEW_CASE_WRITE_FACETS_MESSAGE };
		}
		if (
			caseType !== undefined &&
			own?.name === undefined &&
			nameRead === undefined
		) {
			return { ok: false, message: CHOOSE_NAME_QUESTION_MESSAGE };
		}
		if (form.closeCondition !== undefined) patch.closeCondition = null;
	} else {
		// Follow-up or close: no open condition. A follow-up closes nothing.
		// A registration's close condition carries to a close form, where
		// absent already means every submission, so only `match-all` drops.
		if (form.openCondition !== undefined) patch.openCondition = null;
		if (
			form.closeCondition !== undefined &&
			(type === "followup" || form.closeCondition.kind === "match-all")
		)
			patch.closeCondition = null;
	}
	mutations.push(updateFormPatch(formUuid, patch));

	if (caseType === undefined) return { ok: true, mutations };
	if (own === undefined) {
		mutations.push(
			addOwnMutation(
				formUuid,
				ownCaseOperation(
					caseType,
					otherOperationIds(form),
					type === "registration" ? nameRead : undefined,
				),
			),
		);
	} else if (
		type === "registration" &&
		own.name === undefined &&
		nameRead !== undefined
	) {
		mutations.push({
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationPatch: {
				operation: "update",
				uuid: own.uuid,
				targetAction: "own",
				patch: { name: nameRead },
			},
		});
	}
	return { ok: true, mutations };
}

/** Whether one of the own case's writes reads the case as the form loaded
 *  it: a save through the indices above it, or a save only if changed. */
function ownWritesNeedLoadedCase(own: OwnCaseOperation): boolean {
	return (own.writes ?? []).some(
		(write) => write.via !== undefined || write.onlyIfChanged !== undefined,
	);
}

function nameReadFrom(
	doc: BlueprintDoc,
	formUuid: Uuid,
	nameField: Uuid | undefined,
): Expression | undefined {
	if (nameField === undefined) return undefined;
	return doc.fields[nameField] !== undefined &&
		findContainingForm(doc, nameField) === formUuid
		? bareFieldRead(nameField)
		: undefined;
}

/**
 * The batch that leads a module case-type change: what the module's forms'
 * own cases need for `nextCaseType`, beside the catalog writes for the old
 * and new type (`caseTypeCatalogMutations`). The caller appends the module
 * patch itself.
 *
 * Clearing the type turns each of the module's forms into a survey first
 * (`planFormTypeChange`), since a form of a module without a case type holds
 * no own case. Setting it declares, on the new type, every property the
 * forms' own cases write, as a new operation's writes are declared, so the
 * retyped own cases write declared properties.
 */
export function moduleCaseTypeChangeMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	retirement: CaseTypeRetirement,
	nextCaseType: string | undefined,
): Mutation[] {
	const formUuids = doc.formOrder[moduleUuid] ?? [];
	const catalog = caseTypeCatalogMutations(doc, retirement, nextCaseType);
	if (nextCaseType === undefined) {
		const conversions: Mutation[] = [];
		for (const formUuid of formUuids) {
			const plan = planFormTypeChange(doc, formUuid, "survey");
			if (plan.ok) conversions.push(...plan.mutations);
		}
		return [...conversions, ...catalog];
	}
	const owns = formUuids.flatMap((formUuid) => {
		const form = doc.forms[formUuid];
		const own = form === undefined ? undefined : ownOperationOf(form);
		return own === undefined
			? []
			: [{ operation: own, ownCaseType: nextCaseType }];
	});
	return [...catalog, ...withoutRedeclarations(catalog, owns, doc)];
}

/**
 * The batch for a move of `formUuid` to `toModuleUuid` after `after` (`null`
 * first): the `moveForm`, led by the declarations its own case's writes need
 * on the destination module's case type when the move crosses modules.
 */
export function moveFormMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	toModuleUuid: Uuid,
	after: Uuid | null,
): Mutation[] {
	const move: Mutation = {
		kind: "moveForm",
		uuid: formUuid,
		toModuleUuid,
		after,
	};
	const form = doc.forms[formUuid];
	const own = form === undefined ? undefined : ownOperationOf(form);
	const destinationType = doc.modules[toModuleUuid]?.caseType;
	if (
		own === undefined ||
		destinationType === undefined ||
		owningModuleUuid(doc, formUuid) === toModuleUuid
	) {
		return [move];
	}
	return [
		...catalogMutationsForOperations(doc, [
			{ operation: own, ownCaseType: destinationType },
		]),
		move,
	];
}

/** The own cases' catalog writes, without a declaration of a type the
 *  catalog batch before them already declares. */
function withoutRedeclarations(
	catalog: readonly Mutation[],
	owns: Parameters<typeof catalogMutationsForOperations>[1],
	doc: BlueprintDoc,
): Mutation[] {
	const declared = new Set(
		catalog.flatMap((mutation) =>
			mutation.kind === "declareCaseType" ? [mutation.caseType] : [],
		),
	);
	return catalogMutationsForOperations(doc, owns).filter(
		(mutation) =>
			mutation.kind !== "declareCaseType" || !declared.has(mutation.caseType),
	);
}
