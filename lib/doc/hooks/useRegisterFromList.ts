"use client";

/**
 * What a case list's "Register from this list" setting and a form's
 * "Also offered on" row read, projected from the document once per
 * snapshot: the `always` arm the host holds, the forms it may offer (each
 * with the batch that offers it, `lib/doc/alwaysOfferedRegistration.ts`),
 * the host's shape, and the form's own after-submit where that is in force.
 */

import { useCallback, useMemo } from "react";
import {
	type AlwaysOfferedRegistrationChoice,
	afterEmptySearchOfferBlocked,
	alwaysOfferedRegistrationChoices,
	alwaysOfferedRegistrationMutations,
} from "@/lib/doc/alwaysOfferedRegistration";
import {
	type AlwaysOfferedRegistration,
	afterEmptySearchRegistrationFormOf,
	alwaysOfferedRegistrationOf,
	type CommitOutcome,
	caseListRegistrationReturnOf,
	caseListsOffering,
	effectivePostSubmit,
	menuFormUuidsOf,
	menuScreenOf,
	moduleUuidOfForm,
	type PostSubmitDestination,
	screenChoosesCaseFirst,
	type Uuid,
} from "@/lib/domain";
import { useBlueprintDoc, useBlueprintDocApi } from "./useBlueprintDoc";
import { useBlueprintMutations } from "./useBlueprintMutations";

export interface RegisterFromListFacts {
	readonly hostName: string;
	readonly caseType: string | undefined;
	/** The host's `always` arm, and the name of the form it names. */
	readonly stored: AlwaysOfferedRegistration | undefined;
	readonly storedFormName: string | undefined;
	/** The form the host offers after an empty search, which takes the slot. */
	readonly afterEmptySearchFormName: string | undefined;
	readonly choices: readonly AlwaysOfferedRegistrationChoice[];
	/** The host has no menu forms: its frame is its command alone. */
	readonly bare: boolean;
	/** The host's screen chooses a case before a form. */
	readonly caseFirst: boolean;
	/** The form's own after-submit where it is in force from the list. */
	readonly ownAfterSubmit:
		| {
				readonly formUuid: Uuid;
				readonly formModuleUuid: Uuid;
				readonly formName: string;
				readonly destination: PostSubmitDestination | "links";
		  }
		| undefined;
}

/** Keyed on the menus, the forms and the case types, which every fact here
 *  reads, so a question's edit inside a form re-renders nothing. */
export function useRegisterFromList(hostUuid: Uuid): RegisterFromListFacts {
	const modules = useBlueprintDoc((state) => state.modules);
	const moduleOrder = useBlueprintDoc((state) => state.moduleOrder);
	const forms = useBlueprintDoc((state) => state.forms);
	const formOrder = useBlueprintDoc((state) => state.formOrder);
	const caseTypes = useBlueprintDoc((state) => state.caseTypes);
	return useMemo(() => {
		const doc = { modules, moduleOrder, forms, formOrder, caseTypes };
		const host = doc.modules[hostUuid];
		const stored = alwaysOfferedRegistrationOf(doc, hostUuid);
		const afterEmptySearch = afterEmptySearchRegistrationFormOf(doc, hostUuid);
		const returnTo = caseListRegistrationReturnOf(doc, hostUuid);
		const storedForm =
			stored === undefined ? undefined : doc.forms[stored.formUuid];
		const storedModule =
			stored === undefined ? undefined : moduleUuidOfForm(doc, stored.formUuid);
		return {
			hostName: host?.name ?? "",
			caseType: host?.caseType,
			stored,
			storedFormName: storedForm?.name,
			afterEmptySearchFormName:
				afterEmptySearch === undefined
					? undefined
					: doc.forms[afterEmptySearch]?.name,
			choices: alwaysOfferedRegistrationChoices(doc, hostUuid),
			bare: menuFormUuidsOf(doc, hostUuid).length === 0,
			caseFirst: screenChoosesCaseFirst(doc, menuScreenOf(doc, hostUuid)),
			ownAfterSubmit:
				returnTo?.kind === "own" &&
				stored !== undefined &&
				storedForm !== undefined &&
				storedModule !== undefined
					? {
							formUuid: stored.formUuid,
							formModuleUuid: storedModule,
							formName: storedForm.name,
							destination:
								storedForm.formLinks !== undefined
									? "links"
									: (effectivePostSubmit(doc, stored.formUuid) ?? "app_home"),
						}
					: undefined,
		};
	}, [modules, moduleOrder, forms, formOrder, caseTypes, hostUuid]);
}

/** The case lists that always offer the form, in module order, each with its
 *  menu's name. */
export function useCaseListsOffering(
	formUuid: Uuid,
): readonly { readonly hostModuleUuid: Uuid; readonly hostName: string }[] {
	const modules = useBlueprintDoc((state) => state.modules);
	const moduleOrder = useBlueprintDoc((state) => state.moduleOrder);
	return useMemo(
		() =>
			caseListsOffering({ modules, moduleOrder }, formUuid).map(
				(hostModuleUuid) => ({
					hostModuleUuid,
					hostName: modules[hostModuleUuid]?.name ?? "",
				}),
			),
		[modules, moduleOrder, formUuid],
	);
}

/** The builder's sentence where offering a form after an empty search would
 *  replace the host list's offer of another menu's form; undefined where the
 *  list offers none. */
export function useAfterEmptySearchOfferBlocked(
	hostUuid: Uuid,
): string | undefined {
	return useBlueprintDoc(
		(doc) => afterEmptySearchOfferBlocked(doc, hostUuid)?.userMessage,
	);
}

/**
 * Set the host's `always` arm whole, or clear it with `null`, on the `inline`
 * flavor: the planner reads the document at the call, and a refusal (the
 * planner's or the gate's) comes back for the setting to show.
 */
export function useSetAlwaysOfferedRegistration(
	hostUuid: Uuid,
): (slot: AlwaysOfferedRegistration | null) => CommitOutcome {
	const docApi = useBlueprintDocApi();
	const { inline } = useBlueprintMutations();
	return useCallback(
		(slot) => {
			const planned = alwaysOfferedRegistrationMutations(
				docApi.getState(),
				hostUuid,
				slot,
			);
			if (planned.kind === "blocked")
				return { ok: false, messages: [planned.userMessage] };
			if (planned.mutations.length === 0) return { ok: true };
			return inline.commitMany(planned.mutations);
		},
		[docApi, hostUuid, inline],
	);
}
