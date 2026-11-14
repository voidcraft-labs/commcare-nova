// lib/doc/hooks/useFormLinks.ts
//
// One read/write surface over a form's after-submit destinations and its
// otherwise, shared by the centre-canvas list, the link detail, the rail's
// per-link body, and the form-settings "After submit" row.
//
// It lives with the doc hooks rather than beside its screens because it
// reads the WHOLE document: every planner takes it (whether a destination
// may not run reads what its target selects, which menus HQ offers reads
// every menu's parent and case type, and what a link can carry depends on
// the destination module's forms). Selector-accepting store hooks are
// lib-private, so a surface that needs the whole doc gets a named hook here
// instead.
//
// Selection lives in the URL (`form-links` with an optional `linkUuid`),
// not here: the case-operations precedent.
//
// Every legality question routes to the planners in `formLinkMutations.ts`
// and the verdicts in `formLinkReview.ts`. This hook decides nothing; it
// asks, and hands the answer, with what the batch did beside the asked-for
// change, to the surface that has to explain it.

"use client";

import { useCallback, useMemo } from "react";
import {
	type CommitOutcome,
	type FormLink,
	type FormLinkTarget,
	type FormOtherwise,
	type OtherwiseDestination,
	otherwiseDestinationsOffered,
	type PostSubmitDestination,
} from "@/lib/domain";
import {
	type AfterSubmitPlan,
	afterSubmitPlan,
	type FormLinkCommitPlan,
	type FormLinkRefusal,
	planFormLinkAdd,
	planFormLinkMove,
	planFormLinkRemove,
	planFormLinkUpdate,
	planMakeDestination,
	planMakeOtherwise,
	planSetOtherwise,
} from "../formLinkMutations";
import {
	type FormLinkAddChoices,
	type FormLinkCarryVerdict,
	type FormLinkMoveVerdict,
	type FormLinkRequiredDatum,
	type FormLinkTargetVerdict,
	formLinkAddChoices,
	formLinkCarryVerdict,
	formLinkManualCarryVerdict,
	formLinkMoveVerdicts,
	formLinkRequiredDatums,
	formLinkTargetVerdict,
} from "../formLinkReview";
import type { Uuid } from "../types";
import { firstMenuSharedCaseSentence } from "../userFacingErrors";
import { useBlueprintDoc, useBlueprintDocApi } from "./useBlueprintDoc";
import { useBlueprintMutations } from "./useBlueprintMutations";

/** What a committed batch did beside the change asked for, from the plan's
 *  reports, so the surface can say it (`FormLinkCommitPlan`). */
export interface FormLinkWriteReports {
	readonly movedToOtherwise?: OtherwiseDestination;
	readonly droppedPostSubmit?: PostSubmitDestination;
	readonly droppedOtherwise?: FormOtherwise;
	readonly otherwiseToPostSubmit?: OtherwiseDestination;
	readonly otherwiseToDestination?: Uuid;
	readonly droppedDatums?: readonly string[];
}

/** A write's outcome: refused or committed, and when committed, what the
 *  batch also did. */
export type FormLinkWriteOutcome = CommitOutcome & FormLinkWriteReports;

export type FormLinkMoveCommitOutcome =
	| { readonly ok: true; readonly index: number; readonly total: number }
	| { readonly ok: false; readonly messages: string[] };

export interface FormLinksView {
	/** The destinations, in author order. */
	readonly links: readonly FormLink[];
	/** The after-submit plan; `undefined` once the form is gone. */
	readonly plan: AfterSubmitPlan | undefined;
	/** The built-in otherwise destinations the otherwise picker lists
	 *  (`otherwiseDestinationsOffered`). */
	readonly otherwiseDestinationsOffered: readonly OtherwiseDestination[];
	/** The move verdict for every candidate position of one destination. */
	readonly moveVerdicts: (
		uuid: Uuid,
	) => ReadonlyMap<number, FormLinkMoveVerdict>;
	/** Whether a link may point at a target. */
	readonly targetVerdict: (target: FormLinkTarget) => FormLinkTargetVerdict;
	/** The selection datums a destination needs carried. */
	readonly requiredDatums: (
		target: FormLinkTarget,
	) => readonly FormLinkRequiredDatum[];
	/** Whether those datums can be carried automatically from this form. */
	readonly carryVerdict: (target: FormLinkTarget) => FormLinkCarryVerdict;
	/** Whether this link may replace automatic matching with explicit values. */
	readonly manualCarryVerdict: (
		link: Pick<FormLink, "target">,
	) => FormLinkTargetVerdict;
	/** Which kinds of destination the add control may offer right now. */
	readonly addChoices: () => FormLinkAddChoices;
	/** The remove plan, for the confirm copy (it names what else changes). */
	readonly removalPlan: (uuid: Uuid) => FormLinkCommitPlan;
	/** The otherwise plan, for the confirm copy. */
	readonly otherwisePlan: (next: FormOtherwise | null) => FormLinkCommitPlan;
	/** The plan that makes a destination the otherwise link. */
	readonly makeOtherwisePlan: (uuid: Uuid) => FormLinkCommitPlan;
	/** The plan that makes the otherwise link the last destination. */
	readonly makeDestinationPlan: () => FormLinkCommitPlan;
	/**
	 * The builder's sentence for `FORM_LINK_NEEDS_NEW_CASE_DATUM` when the
	 * gate would refuse adding `next` (no `base`) or replacing `base` with
	 * it because the link can't open a case this form creates; `undefined`
	 * when it wouldn't. A destination picker shows it before the choice.
	 */
	readonly newCaseRefusal: (
		next: FormLink,
		base?: FormLink,
	) => string | undefined;
	readonly add: (link: FormLink, after?: Uuid | null) => FormLinkWriteOutcome;
	readonly update: (next: FormLink, base: FormLink) => FormLinkWriteOutcome;
	readonly remove: (uuid: Uuid) => FormLinkWriteOutcome | undefined;
	readonly move: (
		uuid: Uuid,
		index: number,
	) => FormLinkMoveCommitOutcome | undefined;
	readonly setOtherwise: (next: FormOtherwise | null) => FormLinkWriteOutcome;
	readonly makeOtherwise: (uuid: Uuid) => FormLinkWriteOutcome;
	readonly makeDestination: () => FormLinkWriteOutcome;
}

function refused(message: string): CommitOutcome {
	return { ok: false, messages: [message] };
}

/** The builder's sentence for a planner's refusal: what went wrong, and
 *  what the person can do next. */
function refusalMessage(
	reason: FormLinkRefusal,
	menuNameOf: (moduleUuid: Uuid) => string | undefined,
): string {
	switch (reason.kind) {
		case "form-not-found":
			return "This form is no longer part of the app.";
		case "link-not-found":
			return "This destination is no longer part of the form. Review the latest list and try again.";
		case "duplicate-uuid":
			return "This destination was added elsewhere first. Review the latest list and try again.";
		case "stale-base":
			return "This destination was changed elsewhere first. Review the latest list and try again.";
		case "target-not-found":
			return "That form or module is no longer part of the app. You can choose another one.";
		case "self-target":
			return "A link can't name this form by itself. You can choose Start this form again instead.";
		case "target-not-offered":
			return "CommCare HQ can't link to that submenu from here. You can choose the menu that holds it, or a form inside it.";
		case "menu-carries-values":
			return "A module's form list asks for no values. You can remove the carried values, or send the link to a form inside it.";
		case "selection-cardinality":
			return "That form chooses cases differently from this one, so the link can't hand its cases on. You can choose another destination.";
		case "first-menu-shared-case":
			return firstMenuSharedCaseSentence(
				menuNameOf(reason.aboveModuleUuid) ?? "",
			);
		case "otherwise-unreachable":
			return "Give a destination a condition first, so there is a time when none runs.";
		case "otherwise-not-offered":
			return "This form's menu doesn't offer that destination. You can choose another one.";
		case "otherwise-exists":
			return "This form already has an Otherwise. You can change it instead.";
		case "no-otherwise-link":
			return "This form's Otherwise isn't a link, so there's no destination to make from it.";
	}
}

/** The reports of an ok plan, for the outcome a write returns. */
function reportsOf(
	plan: Extract<FormLinkCommitPlan, { ok: true }>,
): FormLinkWriteReports {
	const { ok: _ok, mutations: _mutations, ...reports } = plan;
	return reports;
}

export function useFormLinks(formUuid: Uuid): FormLinksView {
	const mutations = useBlueprintMutations();
	const docApi = useBlueprintDocApi();
	/* The whole doc: every planner takes it. */
	const doc = useBlueprintDoc((state) => state);

	const links = useMemo(
		() => doc.forms[formUuid]?.formLinks ?? [],
		[doc, formUuid],
	);
	const plan = useMemo(() => afterSubmitPlan(doc, formUuid), [doc, formUuid]);
	const offeredOtherwise = useMemo(
		() => otherwiseDestinationsOffered(doc, formUuid),
		[doc, formUuid],
	);

	const moveVerdicts = useCallback(
		(uuid: Uuid) => formLinkMoveVerdicts(doc, formUuid, uuid),
		[doc, formUuid],
	);
	const targetVerdict = useCallback(
		(target: FormLinkTarget) => formLinkTargetVerdict(doc, formUuid, target),
		[doc, formUuid],
	);
	const requiredDatums = useCallback(
		(target: FormLinkTarget) => formLinkRequiredDatums(doc, formUuid, target),
		[doc, formUuid],
	);
	const carryVerdict = useCallback(
		(target: FormLinkTarget) => formLinkCarryVerdict(doc, formUuid, target),
		[doc, formUuid],
	);
	const manualCarryVerdict = useCallback(
		(link: Pick<FormLink, "target">) =>
			formLinkManualCarryVerdict(doc, formUuid, link.target),
		[doc, formUuid],
	);
	const addChoices = useCallback(
		() => formLinkAddChoices(doc, formUuid),
		[doc, formUuid],
	);
	const removalPlan = useCallback(
		(uuid: Uuid) => planFormLinkRemove(doc, formUuid, uuid),
		[doc, formUuid],
	);
	const otherwisePlan = useCallback(
		(next: FormOtherwise | null) => planSetOtherwise(doc, formUuid, next),
		[doc, formUuid],
	);
	const makeOtherwisePlan = useCallback(
		(uuid: Uuid) => planMakeOtherwise(doc, formUuid, uuid),
		[doc, formUuid],
	);
	const makeDestinationPlan = useCallback(
		() => planMakeDestination(doc, formUuid),
		[doc, formUuid],
	);

	/* Only a link to a form can carry a new case, and only from a form that
	 * creates one: a registration's own case or a create. A menu is the
	 * rule's own remedy, so elsewhere it never fires and no review runs. */
	const newCaseRefusal = useCallback(
		(next: FormLink, base?: FormLink): string | undefined => {
			const current = docApi.getState();
			const form = current.forms[formUuid];
			if (
				next.target.type === "module" ||
				form === undefined ||
				(form.type !== "registration" &&
					!(form.caseOperations ?? []).some((op) => op.action === "create"))
			)
				return undefined;
			const planned =
				base === undefined
					? planFormLinkAdd(current, formUuid, next)
					: planFormLinkUpdate(current, formUuid, next, base);
			if (!planned.ok || planned.mutations.length === 0) return undefined;
			const reviewed = mutations.inline.reviewMany([...planned.mutations]);
			if (reviewed.ok) return undefined;
			const index = (reviewed.findings ?? []).findIndex(
				(finding) => finding.code === "FORM_LINK_NEEDS_NEW_CASE_DATUM",
			);
			return index < 0 ? undefined : reviewed.messages[index];
		},
		[docApi, formUuid, mutations],
	);

	/* Inline, not toasting: a refusal belongs beside the list it is about,
	 * and these surfaces all have somewhere to put it. Every write plans
	 * over the store at invocation, never the render's doc. */
	const commitPlanned = useCallback(
		(planned: FormLinkCommitPlan): FormLinkWriteOutcome => {
			if (!planned.ok)
				return refused(
					refusalMessage(
						planned.reason,
						(moduleUuid) => docApi.getState().modules[moduleUuid]?.name,
					),
				);
			if (planned.mutations.length === 0) return { ok: true };
			const outcome = mutations.inline.commitMany([...planned.mutations]);
			return outcome.ok ? { ...outcome, ...reportsOf(planned) } : outcome;
		},
		[docApi, mutations],
	);

	const add = useCallback(
		(link: FormLink, after?: Uuid | null) =>
			commitPlanned(planFormLinkAdd(docApi.getState(), formUuid, link, after)),
		[commitPlanned, docApi, formUuid],
	);

	const update = useCallback(
		(next: FormLink, base: FormLink) =>
			commitPlanned(
				planFormLinkUpdate(docApi.getState(), formUuid, next, base),
			),
		[commitPlanned, docApi, formUuid],
	);

	const remove = useCallback(
		(uuid: Uuid) => {
			const planned = planFormLinkRemove(docApi.getState(), formUuid, uuid);
			// A refused plan never reaches the store: the link is already gone.
			return planned.ok ? commitPlanned(planned) : undefined;
		},
		[commitPlanned, docApi, formUuid],
	);

	const move = useCallback(
		(uuid: Uuid, index: number) => {
			const planned = planFormLinkMove(
				docApi.getState(),
				formUuid,
				uuid,
				index,
			);
			if (!planned.ok) return undefined;
			const position = (): FormLinkMoveCommitOutcome | undefined => {
				const current = docApi.getState().forms[formUuid]?.formLinks ?? [];
				const at = current.findIndex((link) => link.uuid === uuid);
				return at < 0
					? undefined
					: { ok: true, index: at, total: current.length };
			};
			if (planned.mutations.length === 0) return position();
			const outcome = mutations.inline.commitMany([...planned.mutations]);
			return outcome.ok ? position() : outcome;
		},
		[docApi, formUuid, mutations],
	);

	const setOtherwise = useCallback(
		(next: FormOtherwise | null) =>
			commitPlanned(planSetOtherwise(docApi.getState(), formUuid, next)),
		[commitPlanned, docApi, formUuid],
	);

	const makeOtherwise = useCallback(
		(uuid: Uuid) =>
			commitPlanned(planMakeOtherwise(docApi.getState(), formUuid, uuid)),
		[commitPlanned, docApi, formUuid],
	);

	const makeDestination = useCallback(
		() => commitPlanned(planMakeDestination(docApi.getState(), formUuid)),
		[commitPlanned, docApi, formUuid],
	);

	return useMemo(
		() => ({
			links,
			plan,
			otherwiseDestinationsOffered: offeredOtherwise,
			moveVerdicts,
			targetVerdict,
			requiredDatums,
			carryVerdict,
			manualCarryVerdict,
			addChoices,
			removalPlan,
			otherwisePlan,
			makeOtherwisePlan,
			makeDestinationPlan,
			newCaseRefusal,
			add,
			update,
			remove,
			move,
			setOtherwise,
			makeOtherwise,
			makeDestination,
		}),
		[
			links,
			plan,
			offeredOtherwise,
			moveVerdicts,
			targetVerdict,
			requiredDatums,
			carryVerdict,
			manualCarryVerdict,
			addChoices,
			removalPlan,
			otherwisePlan,
			makeOtherwisePlan,
			makeDestinationPlan,
			newCaseRefusal,
			add,
			update,
			remove,
			move,
			setOtherwise,
			makeOtherwise,
			makeDestination,
		],
	);
}
