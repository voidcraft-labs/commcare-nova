// components/builder/case-list-config/caseListRegistrationReview.tsx
//
// One decision, reachable from two places: which registration form, if
// any, Results offers after a search finds nothing (the menu's
// `caseListRegistrationForm`). The Search canvas's "When no cases match"
// setting and a registration form's own settings both plan through
// `lib/doc/caseListRegistrationForm.ts`, review the exact batch against the
// gate, and name the worker-visible consequences (the menu's forms reading
// the search, the form leaving the menu) before committing. Clearing is
// reviewed the same way, because it is not the menu alone that changes:
// Forms read the search turns off with it, and the starting values the form
// read from the search go.

"use client";

import { useCallback, useRef, useState } from "react";
import { IdentityMoveReviewNote } from "@/components/builder/shared/IdentityMoveList";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { afterEmptySearchOfferBlocked } from "@/lib/doc/alwaysOfferedRegistration";
import {
	caseListRegistrationFormMutations,
	caseListRegistrationMutations,
	searchAnswerDefaultsOf,
} from "@/lib/doc/caseListRegistrationForm";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { IdentityMove } from "@/lib/doc/identityMoves";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	afterEmptySearchRegistrationFormOf,
	caseSelectionCardinality,
	menuFormUuidsOf,
	moduleFormsReadSearch,
	type Uuid,
} from "@/lib/domain";

/** What the person asked Results to offer after an empty search. */
export type CaseListRegistrationChoice =
	/** Nova adds a registration form carrying the search answers. */
	| { readonly kind: "create" }
	/** An existing registration form of the module leaves the menu. */
	| { readonly kind: "existing"; readonly formUuid: Uuid }
	/** The current case list registration form becomes a menu form again. */
	| { readonly kind: "clear" };

export interface CaseListRegistrationReview {
	readonly choice: CaseListRegistrationChoice;
	/** The form Results will offer, or the one returning to the menu. */
	readonly formName: string;
	/** Whether the batch turns Forms read the search on for the menu. */
	readonly turnsFormsReadSearchOn: boolean;
	/** Whether the batch turns Forms read the search off (a clear on a menu
	 *  whose forms read the search). */
	readonly turnsFormsReadSearchOff: boolean;
	/** How many fields lose the starting value they read from the search
	 *  (a clear). */
	readonly defaultsCleared: number;
	/** Whether the module keeps a menu form once this one leaves the menu:
	 *  decides where the registration returns (Results with the new case,
	 *  or the module's Search). */
	readonly hostKeepsMenuForms: boolean;
	readonly firstMenuAfterSubmit: boolean;
	/** The gate's refusals for the exact batch; empty when it would commit. */
	readonly blockers: readonly string[];
	/** Where the batch moves answers a published app keeps; the review lists
	 *  them and commits through `commitStated`. */
	readonly identityMoves: readonly IdentityMove[];
}

interface PlannedChoice {
	readonly formUuid: Uuid;
	readonly mutations: Mutation[];
	readonly formName: string;
}

/** The plan for one choice against `doc`: its exact batch, the form it
 *  names and that form's name; `null` when the choice names nothing. */
export function planCaseListRegistrationChoice(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	choice: CaseListRegistrationChoice,
): PlannedChoice | null {
	switch (choice.kind) {
		case "create": {
			const module = doc.modules[moduleUuid];
			const planned = caseListRegistrationFormMutations(
				doc,
				moduleUuid,
				module && caseSelectionCardinality(module) === "multiple"
					? { postSubmit: "firstMenu" }
					: {},
			);
			return planned === null
				? null
				: {
						mutations: planned.mutations,
						formName: planned.formName,
						formUuid: planned.formUuid,
					};
		}
		case "existing": {
			const form = doc.forms[choice.formUuid];
			if (form === undefined) return null;
			return {
				formUuid: form.uuid,
				mutations: caseListRegistrationMutations(
					doc,
					moduleUuid,
					choice.formUuid,
					{},
				),
				formName: form.name,
			};
		}
		case "clear": {
			const formUuid = afterEmptySearchRegistrationFormOf(doc, moduleUuid);
			const form = formUuid === undefined ? undefined : doc.forms[formUuid];
			if (form === undefined) return null;
			return {
				formUuid: form.uuid,
				mutations: caseListRegistrationMutations(
					doc,
					moduleUuid,
					form.uuid,
					null,
				),
				formName: form.name,
			};
		}
	}
}

/** The builder's sentence where offering a form after an empty search would
 *  replace the list's offer of another menu's form; undefined for a clear
 *  and where the list offers none. */
export function offerArmBlocked(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	choice: CaseListRegistrationChoice,
): string | undefined {
	return choice.kind === "clear"
		? undefined
		: afterEmptySearchOfferBlocked(doc, moduleUuid)?.userMessage;
}

/**
 * The controller both surfaces share: `request` plans the choice against
 * the live document and opens the review; `confirm` replans against the
 * freshest document and commits. Every commit and refusal lands in
 * `announcement` / `refusal` for the host's live regions.
 */
export function useCaseListRegistration(moduleUuid: Uuid | undefined) {
	const docApi = useBlueprintDocApi();
	const { inline } = useBlueprintMutations();
	const [review, setReview] = useState<CaseListRegistrationReview | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const originRef = useRef<HTMLElement | null>(null);

	const describe = useCallback(
		(
			doc: BlueprintDoc,
			choice: CaseListRegistrationChoice,
			planned: PlannedChoice,
			blockers: readonly string[],
			identityMoves: readonly IdentityMove[] = [],
		): CaseListRegistrationReview => {
			if (moduleUuid === undefined) throw new Error("module required");
			const mod = doc.modules[moduleUuid];
			const formsReadSearch = mod !== undefined && moduleFormsReadSearch(mod);
			const menuForms = menuFormUuidsOf(doc, moduleUuid).filter(
				(uuid) => choice.kind !== "existing" || uuid !== choice.formUuid,
			);
			const clearing = choice.kind === "clear";
			const current = clearing
				? afterEmptySearchRegistrationFormOf(doc, moduleUuid)
				: undefined;
			let firstMenuAfterSubmit =
				doc.forms[planned.formUuid]?.postSubmit === "firstMenu";
			for (const mutation of planned.mutations) {
				if (
					mutation.kind === "addForm" &&
					mutation.form.uuid === planned.formUuid
				)
					firstMenuAfterSubmit = mutation.form.postSubmit === "firstMenu";
				if (
					mutation.kind === "updateForm" &&
					mutation.uuid === planned.formUuid &&
					Object.hasOwn(mutation.patch, "postSubmit")
				)
					firstMenuAfterSubmit = mutation.patch.postSubmit === "firstMenu";
			}
			return {
				choice,
				formName: planned.formName,
				turnsFormsReadSearchOn: !clearing && !formsReadSearch,
				turnsFormsReadSearchOff: clearing && formsReadSearch,
				defaultsCleared:
					current === undefined
						? 0
						: searchAnswerDefaultsOf(doc, moduleUuid, current).length,
				hostKeepsMenuForms: menuForms.length > 0,
				firstMenuAfterSubmit,
				blockers,
				identityMoves,
			};
		},
		[moduleUuid],
	);

	const request = useCallback(
		(choice: CaseListRegistrationChoice, origin?: HTMLElement | null) => {
			if (moduleUuid === undefined) return;
			originRef.current = origin ?? null;
			setRefusal(undefined);
			const doc = docApi.getState();
			const planned = planCaseListRegistrationChoice(doc, moduleUuid, choice);
			if (planned === null) return;
			const armBlocked = offerArmBlocked(doc, moduleUuid, choice);
			if (armBlocked !== undefined) {
				setReview(describe(doc, choice, planned, [armBlocked]));
				return;
			}
			const reviewed = inline.reviewMany([...planned.mutations]);
			setReview(
				describe(
					doc,
					choice,
					planned,
					reviewed.ok ? [] : reviewed.messages,
					reviewed.ok ? (reviewed.identityMoves ?? []) : [],
				),
			);
		},
		[describe, docApi, inline, moduleUuid],
	);

	const confirm = useCallback(() => {
		if (
			review === null ||
			review.blockers.length > 0 ||
			moduleUuid === undefined
		)
			return;
		const doc = docApi.getState();
		const planned = planCaseListRegistrationChoice(
			doc,
			moduleUuid,
			review.choice,
		);
		if (planned === null) {
			setReview(null);
			setRefusal(
				"This form is no longer in the module. Choose again from the current forms.",
			);
			return;
		}
		const armBlocked = offerArmBlocked(doc, moduleUuid, review.choice);
		if (armBlocked !== undefined) {
			// The list began offering a form under the review.
			setReview(describe(doc, review.choice, planned, [armBlocked]));
			return;
		}
		/* Moves this review listed commit as stated. A move the review did not
		 * list (the document moved under it) waits in the builder's
		 * identity-move dialog instead, which a refusal with no message means. */
		const outcome =
			review.identityMoves.length > 0
				? inline.commitStated(planned.mutations)
				: inline.commitMany(planned.mutations);
		if (!outcome.ok && outcome.messages.length === 0) {
			setReview(null);
			return;
		}
		if (!outcome.ok) {
			// The document moved under the review: show the fresh refusals.
			setReview(describe(doc, review.choice, planned, outcome.messages));
			return;
		}
		setReview(null);
		setAnnouncement(
			review.choice.kind === "create"
				? `“${planned.formName}” was added. Results offers it after a search finds nothing, and this menu's forms read the search.`
				: review.choice.kind === "existing"
					? `Results offers “${planned.formName}” after a search finds nothing, and this menu's forms read the search.`
					: `“${planned.formName}” is a menu form again. Results shows only the notice when nothing matches${review.turnsFormsReadSearchOff ? ", and this menu's forms no longer read the search" : ""}.`,
		);
	}, [describe, docApi, inline, moduleUuid, review]);

	const cancel = useCallback(() => setReview(null), []);
	const finalFocus = useCallback(() => originRef.current, []);

	return {
		review,
		request,
		confirm,
		cancel,
		finalFocus,
		announcement,
		refusal,
	};
}

/**
 * Review the choice before the document changes. The controller owns the
 * planning and the commit; this names what people will see.
 */
export function CaseListRegistrationReviewDialog({
	review,
	finalFocus,
	onCancel,
	onConfirm,
}: {
	readonly review: CaseListRegistrationReview;
	readonly finalFocus: () => HTMLElement | null;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	const blocked = review.blockers.length > 0;
	const creating = review.choice.kind === "create";
	const clearing = review.choice.kind === "clear";
	const title = blocked
		? clearing
			? "Review this form before it returns to the menu"
			: "Review this module before offering a form"
		: clearing
			? `Make “${review.formName}” a menu form again?`
			: creating
				? `Add “${review.formName}” for empty searches?`
				: `Offer “${review.formName}” after an empty search?`;
	const description = blocked
		? "Nothing has changed. Each item below explains what needs attention. Once these items are resolved, this setting will be available."
		: clearing
			? `“${review.formName}” returns to the module menu, and Results shows only the notice when a search finds nothing.`
			: `When a search finds nothing, Results offers “${review.formName}”. It opens with the search's answers, so people register what they looked for.`;
	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (!open) onCancel();
			}}
		>
			<AlertDialogContent
				className="text-left sm:max-w-lg"
				initialFocus={cancelRef}
				finalFocus={finalFocus}
				data-case-list-registration-review
			>
				<AlertDialogHeader>
					<AlertDialogTitle className="font-display tracking-tighter">
						{title}
					</AlertDialogTitle>
					<AlertDialogDescription className="text-left">
						{description}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogBody>
					{blocked ? (
						<ul className="space-y-2">
							{review.blockers.map((message) => (
								<li
									key={message}
									className="rounded-xl border border-nova-rose/25 bg-nova-rose/[0.05] p-3 text-[13px] leading-5 text-nova-text-secondary"
								>
									{message}
								</li>
							))}
						</ul>
					) : clearing ? (
						<div className="space-y-3 text-[13px] leading-5 text-nova-text-secondary">
							{review.turnsFormsReadSearchOff && (
								<p className="rounded-xl border border-nova-amber/25 bg-nova-amber/[0.05] p-3">
									Forms read the search turns off, because a form on the menu
									can't open from the search.
								</p>
							)}
							{review.defaultsCleared > 0 && (
								<p className="rounded-xl border border-white/[0.07] bg-nova-surface/20 p-3">
									{review.defaultsCleared === 1
										? "One field loses the starting value it read from the search. The field stays."
										: `${review.defaultsCleared} fields lose the starting values they read from the search. The fields stay.`}
								</p>
							)}
							{review.identityMoves.length > 0 && (
								<IdentityMoveReviewNote moves={review.identityMoves} />
							)}
							<p className="text-nova-text-muted">You can undo this.</p>
						</div>
					) : (
						<div className="space-y-3 text-[13px] leading-5 text-nova-text-secondary">
							{review.turnsFormsReadSearchOn && (
								<p className="rounded-xl border border-nova-amber/25 bg-nova-amber/[0.05] p-3">
									Forms read the search turns on. Each form in this menu runs
									the search as it opens.
								</p>
							)}
							<p className="rounded-xl border border-white/[0.07] bg-nova-surface/20 p-3">
								“{review.formName}” leaves the menu. It opens only from Results
								after a search finds nothing, and after submit it opens{" "}
								{review.firstMenuAfterSubmit
									? "First menu."
									: review.hostKeepsMenuForms
										? "Results showing the case it registered."
										: "Search, since the module has no other forms."}
							</p>
							{creating && (
								<p className="rounded-xl border border-white/[0.07] bg-nova-surface/20 p-3">
									The form starts with a field for each search field, filled in
									from the answer, and a name for the new case.
								</p>
							)}
							{review.identityMoves.length > 0 && (
								<IdentityMoveReviewNote moves={review.identityMoves} />
							)}
						</div>
					)}
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel ref={cancelRef}>
						{blocked
							? "Close"
							: clearing
								? "Keep offering it"
								: "Keep the notice only"}
					</AlertDialogCancel>
					{!blocked && (
						<AlertDialogAction onClick={onConfirm}>
							{clearing
								? "Make it a menu form"
								: creating
									? "Add the form"
									: "Offer the form"}
						</AlertDialogAction>
					)}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
