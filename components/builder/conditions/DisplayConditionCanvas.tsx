// components/builder/conditions/DisplayConditionCanvas.tsx
//
// The one editing surface for a module's or a form's display condition,
// mounted on its own URL in the centre canvas. The settings panel that
// owns the setting summarizes it and hands off here, matching where the
// case workspace already puts the Search action's condition.
//
// The screen leads with WHERE the condition takes effect before it shows
// the condition, because that is the part an author cannot infer: the
// same form condition is checked on the case list in one module and on
// the form list in another (`displayConditionCopy.ts` derives which).
//
// Commits go through the INLINE gate flavor. Every single choice the
// editor offers is already admissible, but "this condition can never
// match" is a property of the whole tree rather than of any one choice:
// an author can still compose one deliberately (excluding an
// always-true rule), and the gate refuses it. Refusing in place, beside
// the rule, is honest; a toast plus a silent revert is not.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerEye from "@iconify-icons/tabler/eye";
import { useEffect, useRef, useState } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { ClearConditionButton } from "@/components/builder/shared/ClearConditionButton";
import { firstComparisonDefault } from "@/components/builder/shared/cards/comparisonSeed";
import { PredicateWorkbench } from "@/components/builder/shared/PredicateWorkbench";
import { Button } from "@/components/shadcn/button";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import type { Predicate } from "@/lib/domain/predicate";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { DISPLAY_CONDITION_NOT_A_PERMISSION } from "./displayConditionCopy";
import {
	type DisplayConditionTarget,
	useDisplayConditionCarrier,
} from "./useDisplayConditionCarrier";

export function DisplayConditionCanvas({
	target,
}: {
	readonly target: DisplayConditionTarget;
}) {
	const resolved = useDisplayConditionCarrier(target);
	const userProperties = useUserProperties();
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const addButtonRef = useRef<HTMLButtonElement>(null);
	const [refusals, setRefusals] = useState<readonly string[]>([]);

	/* Route-change focus entry: the heading names the screen the author
	 * just arrived on, and Back stays one Shift+Tab away in DOM order. */
	useEffect(() => {
		headingRef.current?.focus();
	}, []);

	const back = () => {
		if (target.kind === "module") {
			navigate.push({ kind: "module", moduleUuid: target.moduleUuid });
			return;
		}
		navigate.push({
			kind: "form",
			moduleUuid: target.moduleUuid,
			formUuid: target.formUuid,
		});
	};

	if (resolved === null) {
		/* The location recovery effect scrubs a stale uuid on the next tick;
		 * until it does, say what happened rather than rendering a blank. */
		return (
			<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
				<p className="text-[14px] leading-relaxed text-nova-text-muted">
					This item is no longer in the app, so there is nothing to set a
					condition on.
				</p>
			</ContentFrame>
		);
	}

	const { copy, condition, commit, caseTypes, currentCaseType } = resolved;

	const change = (next: Predicate | undefined) => {
		const outcome = commit(next);
		setRefusals(outcome.ok ? [] : outcome.messages);
	};

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
			<Button
				type="button"
				variant="ghost"
				onClick={back}
				className="-ml-2 mb-5"
			>
				<Icon icon={tablerArrowLeft} width="16" height="16" />
				{copy.backLabel}
			</Button>

			<header className="mb-7">
				<h1
					ref={headingRef}
					tabIndex={-1}
					className="font-display text-2xl font-semibold tracking-tighter text-nova-text outline-none"
				>
					{copy.title}
				</h1>
				<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
					{copy.lede}
				</p>
			</header>

			<section
				aria-labelledby="display-condition-locus-heading"
				className="mb-6 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 @sm:p-5"
			>
				<h2
					id="display-condition-locus-heading"
					className="flex items-center gap-2 font-display text-[15px] font-semibold text-nova-text"
				>
					<Icon
						icon={tablerEye}
						width="16"
						height="16"
						className="shrink-0 text-nova-text-muted"
					/>
					Where this is checked
				</h2>
				<ul className="mt-2 max-w-2xl space-y-2 text-[13px] leading-relaxed text-nova-text-secondary">
					{copy.locus.map((sentence) => (
						<li key={sentence}>{sentence}</li>
					))}
					<li>{copy.scopeNote}</li>
				</ul>
				{/* Not a locus statement, so not a locus bullet: it is the one
				 *  thing an author must not misread about the whole feature. */}
				<p className="mt-3 max-w-2xl border-t border-white/[0.06] pt-3 text-[13px] leading-relaxed text-nova-text-muted">
					{DISPLAY_CONDITION_NOT_A_PERMISSION}
				</p>
			</section>

			<section
				aria-labelledby="display-condition-heading"
				className="rounded-2xl border border-white/[0.08] bg-nova-surface/25 p-4 @sm:p-5"
			>
				<div className="mb-4 flex flex-wrap items-start justify-between gap-3">
					<h2
						id="display-condition-heading"
						className="font-display text-[17px] font-semibold text-nova-text"
					>
						{copy.sectionTitle}
					</h2>
					{condition !== undefined && canEdit && (
						<ClearConditionButton
							label={copy.clearLabel}
							title={copy.clearTitle}
							consequence={copy.clearConsequence}
							finalFocus={() => addButtonRef.current}
							onConfirm={() => change(undefined)}
						/>
					)}
				</div>

				{refusals.length > 0 && (
					<div
						role="alert"
						className="mb-4 flex gap-2 rounded-xl border border-nova-rose/25 bg-nova-rose/[0.06] px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary"
					>
						<Icon
							icon={tablerAlertCircle}
							width="16"
							height="16"
							className="mt-0.5 shrink-0 text-nova-rose"
						/>
						<span>
							{refusals.map((message) => (
								<span key={message} className="block">
									{message}
								</span>
							))}
						</span>
					</div>
				)}

				{condition === undefined ? (
					<div className="space-y-3">
						<p className="text-[13px] leading-relaxed text-nova-text-secondary">
							{copy.alwaysSummary}.
						</p>
						<Button
							ref={addButtonRef}
							type="button"
							variant="outline"
							disabled={!canEdit}
							onClick={() =>
								change(
									firstComparisonDefault({
										caseTypes,
										currentCaseType,
										knownInputs: [],
										caseDataScope: copy.caseDataScope,
									}),
								)
							}
							className="w-full border-dashed border-white/[0.10] bg-transparent text-[14px] text-nova-text-muted not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.05] not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.05]"
						>
							Add condition
						</Button>
					</div>
				) : (
					<PredicateWorkbench
						value={condition}
						onChange={change}
						rootLabel={copy.ruleRootLabel}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						userProperties={userProperties}
						evaluationTarget="on-device"
						caseDataScope={copy.caseDataScope}
						/* An item nobody could ever open is refused by the commit
						 * gate, so the editor does not offer "never match" here.
						 * Its own axis: the Search action's condition is `global`
						 * too and legitimately admits one. */
						allowsNeverMatch={false}
					/>
				)}
			</section>
		</ContentFrame>
	);
}
