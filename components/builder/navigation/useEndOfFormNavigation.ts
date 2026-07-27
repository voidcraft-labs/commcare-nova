// components/builder/navigation/useEndOfFormNavigation.ts
//
// The one derivation both end-of-form navigation surfaces read: the rows,
// the Otherwise destination, and every write. The settings row summarizes
// what the screen edits, so they resolve it once here rather than each
// rebuilding the model from the doc and drifting.
//
// Every write goes through `mutations.inline`: a navigation surface has
// somewhere to put a refusal — beside the destination it is about —
// which is better than a toast over a silently reverted edit.

"use client";

import { useCallback, useMemo } from "react";
import {
	addFormLinkMutation,
	moveFormLinkMutation,
	removeFormLinkMutation,
	updateFormLinkMutation,
} from "@/lib/doc/formLinkMutations";
import {
	useBlueprintDocApi,
	useBlueprintDocShallow,
} from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useDocEntityMaps } from "@/lib/doc/hooks/useDocEntityMaps";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import {
	CASE_LOADING_FORM_TYPES,
	type CaseType,
	type CommitOutcome,
	defaultPostSubmit,
	type FormLink,
	type FormLinkTarget,
	type PostSubmitDestination,
} from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import {
	type EndOfFormNavigationModel,
	endOfFormNavigationModel,
} from "./endOfFormNavigationModel";

export interface ResolvedEndOfFormNavigation {
	readonly formName: string;
	readonly moduleName: string;
	readonly model: EndOfFormNavigationModel;
	/**
	 * The case a guard reads, or `undefined` when the form has none. A
	 * case-loading form reads the case it loaded; a registration form
	 * reads the case it just created. A survey form, or any form in a
	 * module with no case type, has nothing to read and the editor says
	 * so instead of offering case values that would be refused.
	 */
	readonly guardCaseType: string | undefined;
	readonly caseTypes: readonly CaseType[];
	readonly addLink: (target: FormLinkTarget, condition?: Predicate) => Outcome;
	readonly setCondition: (uuid: Uuid, next: Predicate | undefined) => Outcome;
	readonly setTarget: (uuid: Uuid, target: FormLinkTarget) => Outcome;
	readonly moveLink: (uuid: Uuid, beforeUuid: Uuid | undefined) => Outcome;
	readonly removeLink: (uuid: Uuid) => Outcome;
	readonly setPostSubmit: (destination: PostSubmitDestination) => Outcome;
}

type Outcome = CommitOutcome;

/**
 * The session case an end-of-form guard can read.
 *
 * Mirrors `lib/commcare/suite/endOfForm.ts::endOfFormCaseAnchor` — the
 * validator refuses a read the emitter has no anchor for, so the editor
 * must offer exactly what that function admits.
 */
function guardCaseTypeFor(
	formType: string,
	moduleCaseType: string | undefined,
): string | undefined {
	if (moduleCaseType === undefined || moduleCaseType.length === 0) {
		return undefined;
	}
	if (CASE_LOADING_FORM_TYPES.has(formType as never)) return moduleCaseType;
	return formType === "registration" ? moduleCaseType : undefined;
}

export function useEndOfFormNavigation(
	moduleUuid: Uuid,
	formUuid: Uuid,
): ResolvedEndOfFormNavigation | null {
	const mod = useModule(moduleUuid);
	const form = useForm(formUuid);
	const caseTypes = useEffectiveCaseTypes();
	const mutations = useBlueprintMutations();
	const docStore = useBlueprintDocApi();
	/* The model names every destination, so it re-derives when any module
	 * or form is renamed or removed — not only when this form's links
	 * change. */
	const entities = useDocEntityMaps();

	const model = useMemo(
		() =>
			form === undefined
				? null
				: endOfFormNavigationModel(
						entities as unknown as BlueprintDoc,
						form,
						defaultPostSubmit(form.type),
					),
		[entities, form],
	);

	const addLink = useCallback(
		(target: FormLinkTarget, condition?: Predicate): Outcome =>
			mutations.inline.commitMany([
				addFormLinkMutation(docStore.getState(), formUuid, {
					uuid: crypto.randomUUID() as Uuid,
					target,
					...(condition !== undefined && { condition }),
				}),
			]),
		[mutations, docStore, formUuid],
	);

	const setCondition = useCallback(
		(uuid: Uuid, next: Predicate | undefined): Outcome => {
			const mutation = updateFormLinkMutation(
				docStore.getState(),
				formUuid,
				uuid,
				{ condition: next },
			);
			/* A stale uuid — the link a co-editor removed under this screen —
			 * is nothing to do, not a failure to report. */
			return mutation === undefined
				? { ok: true }
				: mutations.inline.commitMany([mutation]);
		},
		[mutations, docStore, formUuid],
	);

	const setTarget = useCallback(
		(uuid: Uuid, target: FormLinkTarget): Outcome => {
			const mutation = updateFormLinkMutation(
				docStore.getState(),
				formUuid,
				uuid,
				{ target },
			);
			/* A stale uuid — the link a co-editor removed under this screen —
			 * is nothing to do, not a failure to report. */
			return mutation === undefined
				? { ok: true }
				: mutations.inline.commitMany([mutation]);
		},
		[mutations, docStore, formUuid],
	);

	const moveLink = useCallback(
		(uuid: Uuid, beforeUuid: Uuid | undefined): Outcome => {
			const mutation = moveFormLinkMutation(
				docStore.getState(),
				formUuid,
				uuid,
				beforeUuid,
			);
			/* A stale uuid — the link a co-editor removed under this screen —
			 * is nothing to do, not a failure to report. */
			return mutation === undefined
				? { ok: true }
				: mutations.inline.commitMany([mutation]);
		},
		[mutations, docStore, formUuid],
	);

	const removeLink = useCallback(
		(uuid: Uuid): Outcome =>
			mutations.inline.commitMany([removeFormLinkMutation(formUuid, uuid)]),
		[mutations, formUuid],
	);

	const formType = form?.type;
	const setPostSubmit = useCallback(
		(destination: PostSubmitDestination): Outcome =>
			mutations.inline.commitMany([
				{
					kind: "updateForm",
					uuid: formUuid,
					/* The form-type default is stored as absence, matching every
					 * other optional slot, so the doc never carries redundant
					 * state and a form-type change re-derives the default. */
					patch: {
						postSubmit:
							formType !== undefined &&
							destination === defaultPostSubmit(formType)
								? null
								: destination,
					},
				},
			]),
		[mutations, formUuid, formType],
	);

	return useMemo(() => {
		if (mod === undefined || form === undefined || model === null) return null;
		return {
			formName: form.name,
			moduleName: mod.name,
			model,
			guardCaseType: guardCaseTypeFor(form.type, mod.caseType),
			caseTypes,
			addLink,
			setCondition,
			setTarget,
			moveLink,
			removeLink,
			setPostSubmit,
		};
	}, [
		mod,
		form,
		model,
		caseTypes,
		addLink,
		setCondition,
		setTarget,
		moveLink,
		removeLink,
		setPostSubmit,
	]);
}

/** Every destination a link may point at, in app order. */
export interface DestinationChoice {
	readonly key: string;
	readonly label: string;
	readonly target: FormLinkTarget;
	/** Set when this destination cannot be chosen, saying why. */
	readonly disabledReason?: string;
}

export function useDestinationChoices(
	sourceFormUuid: Uuid,
): readonly DestinationChoice[] {
	const structure = useBlueprintDocShallow((state) => ({
		modules: state.modules,
		forms: state.forms,
		moduleOrder: state.moduleOrder,
		formOrder: state.formOrder,
	}));
	return useMemo(() => {
		const choices: DestinationChoice[] = [];
		for (const moduleUuid of structure.moduleOrder) {
			const mod = structure.modules[moduleUuid];
			if (mod === undefined) continue;
			choices.push({
				key: `m:${moduleUuid}`,
				label: mod.name,
				target: { type: "module", moduleUuid },
			});
			for (const formUuid of structure.formOrder[moduleUuid] ?? []) {
				const form = structure.forms[formUuid];
				if (form === undefined) continue;
				choices.push({
					key: `f:${formUuid}`,
					label: `${mod.name} · ${form.name}`,
					target: { type: "form", moduleUuid, formUuid },
					/* A link back into the same form would loop with no way out,
					 * and the gate refuses it — so it is offered disabled with the
					 * reason rather than silently missing. */
					...(formUuid === sourceFormUuid && {
						disabledReason:
							"This is the form people are submitting, so sending them back into it would loop with no way out.",
					}),
				});
			}
		}
		return choices;
	}, [structure, sourceFormUuid]);
}

/** Whether a link and a destination choice name the same place. */
export function targetsSamePlace(
	link: FormLink,
	choice: DestinationChoice,
): boolean {
	const a = link.target;
	const b = choice.target;
	if (a.type !== b.type) return false;
	if (a.moduleUuid !== b.moduleUuid) return false;
	return (
		a.type === "module" || b.type === "module" || a.formUuid === b.formUuid
	);
}
