// components/builder/navigation/EndOfFormNavigationCanvas.tsx
//
// Where a submission lands, authored on the form's own URL in the centre
// canvas. The form-settings panel summarizes it and hands off here,
// matching where the display conditions already put a condition an
// author has to see whole.
//
// The screen leads with WHERE a condition is checked, because that is the
// part an author cannot infer and it decides what they may write: the
// guard runs in the session context at end of form, so this submission's
// own case writes are already visible and the form's answers are not
// readable at all.
//
// **The list reads as one decision, not as two features.** Conditional
// destinations first, then a single "Otherwise" row — and that row is
// either the form's post-submit destination or a terminal unconditional
// link, because on the wire those are the same thing. Presenting them as
// two settings would tell an author there are two fallbacks where the
// runtime has one.
//
// Commits go through the INLINE gate flavor: a refusal belongs beside the
// destination it is about, not in a toast over a silently reverted edit.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerArrowNarrowDown from "@iconify-icons/tabler/arrow-narrow-down";
import tablerArrowNarrowUp from "@iconify-icons/tabler/arrow-narrow-up";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerRoute from "@iconify-icons/tabler/route";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useEffect, useRef, useState } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { summarizeFilter } from "@/components/builder/case-list-config/predicateSummary";
import { firstComparisonDefault } from "@/components/builder/shared/cards/comparisonSeed";
import { PredicateWorkbench } from "@/components/builder/shared/PredicateWorkbench";
import { Button } from "@/components/shadcn/button";
import { DropdownMenuItem } from "@/components/shadcn/dropdown-menu";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { Uuid } from "@/lib/doc/types";
import type { CaseType, PostSubmitDestination } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { DestinationMenu } from "./DestinationMenu";
import {
	END_OF_FORM_REMOVAL_CONSEQUENCE,
	type LinkRow,
	type MoveAffordance,
} from "./endOfFormNavigationModel";
import {
	type DestinationChoice,
	targetsSamePlace,
	useDestinationChoices,
	useEndOfFormNavigation,
} from "./useEndOfFormNavigation";

/** The post-submit destinations an author picks from, in plain words. */
const POST_SUBMIT_CHOICES: ReadonlyArray<{
	readonly value: PostSubmitDestination;
	readonly label: string;
}> = [
	{ value: "previous", label: "Back to the previous screen" },
	{ value: "module", label: "Back to this menu" },
	{ value: "app_home", label: "Back to the app home screen" },
];

function postSubmitLabel(destination: PostSubmitDestination): string {
	/* `root` and `parent_module` are HQ's legacy spellings of the two
	 * choices below; an imported app can carry one, and the author should
	 * read the destination it actually reaches. */
	if (destination === "root") return "Back to the app home screen";
	if (destination === "parent_module") return "Back to this menu";
	return (
		POST_SUBMIT_CHOICES.find((choice) => choice.value === destination)?.label ??
		"Back to the previous screen"
	);
}

export function EndOfFormNavigationCanvas({
	moduleUuid,
	formUuid,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
}) {
	const resolved = useEndOfFormNavigation(moduleUuid, formUuid);
	const choices = useDestinationChoices(formUuid);
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const [refusals, setRefusals] = useState<readonly string[]>([]);
	/** Which row's condition is open. One at a time — the workbench wants
	 *  the whole width, and two open rules read as two rules in force. */
	const [editing, setEditing] = useState<Uuid | undefined>(undefined);

	/* Route-change focus entry: the heading names the screen just arrived
	 * on, and Back stays one Shift+Tab away in DOM order. */
	useEffect(() => {
		headingRef.current?.focus();
	}, []);

	if (resolved === null) {
		return (
			<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
				<p className="text-[14px] leading-relaxed text-nova-text-muted">
					This form is no longer in the app, so there is nowhere for a
					submission to go.
				</p>
			</ContentFrame>
		);
	}

	const {
		formName,
		model,
		guardCaseType,
		caseTypes,
		addLink,
		setCondition,
		setTarget,
		moveLink,
		removeLink,
		setPostSubmit,
	} = resolved;

	const report = (outcome: { ok: boolean; messages?: readonly string[] }) => {
		setRefusals(outcome.ok ? [] : (outcome.messages ?? []));
	};

	const seedCondition = (): Predicate =>
		firstComparisonDefault({
			caseTypes,
			currentCaseType: guardCaseType ?? "",
			knownInputs: [],
			caseDataScope: guardCaseType === undefined ? "global" : "per-case",
		});

	const addDestination = (choice: DestinationChoice) => {
		const outcome = addLink(choice.target, seedCondition());
		report(outcome);
	};

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
			<Button
				type="button"
				variant="ghost"
				size="xl"
				onClick={() => navigate.push({ kind: "form", moduleUuid, formUuid })}
				className="-ml-2 mb-5 text-nova-text-secondary"
			>
				<Icon icon={tablerArrowLeft} width="16" height="16" />
				Back to "{formName}"
			</Button>

			<header className="mb-7">
				<h1
					ref={headingRef}
					tabIndex={-1}
					className="font-display text-2xl font-semibold tracking-tight text-nova-text outline-none"
				>
					After submitting
				</h1>
				<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
					Where people go once they submit "{formName}". The first destination
					whose condition is true is the one they get; if none is, they go to
					the Otherwise destination.
				</p>
			</header>

			<section
				aria-labelledby="end-of-form-locus-heading"
				className="mb-6 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 @sm:p-5"
			>
				<h2
					id="end-of-form-locus-heading"
					className="flex items-center gap-2 font-display text-[15px] font-semibold text-nova-text"
				>
					<Icon
						icon={tablerRoute}
						width="16"
						height="16"
						className="shrink-0 text-nova-text-muted"
					/>
					What a condition can read
				</h2>
				<ul className="mt-2 max-w-2xl space-y-2 text-[13px] leading-relaxed text-nova-text-secondary">
					<li>
						Conditions are checked after the form is submitted, so anything this
						form saved to the case is already there — write "the case now says
						yes" rather than "they answered yes".
					</li>
					<li>
						The answers themselves are gone by then. A condition reads the case,
						never a question on this form.
					</li>
					<li>
						{guardCaseType === undefined
							? "This form works on no case, so a condition can only read a fixed value or something about the person using the app."
							: `The case available here is the "${guardCaseType}" this form works on, along with anything connected to it.`}
					</li>
				</ul>
			</section>

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

			<section
				aria-labelledby="end-of-form-destinations-heading"
				className="space-y-3"
			>
				<h2
					id="end-of-form-destinations-heading"
					className="font-display text-[17px] font-semibold text-nova-text"
				>
					Destinations
				</h2>

				{model.rows.map((row) => (
					<DestinationRow
						key={row.uuid}
						row={row}
						choices={choices}
						caseTypes={caseTypes}
						guardCaseType={guardCaseType}
						canEdit={canEdit}
						editing={editing === row.uuid}
						onToggleEditing={() =>
							setEditing((current) =>
								current === row.uuid ? undefined : row.uuid,
							)
						}
						onSetTarget={(target) => report(setTarget(row.uuid, target))}
						onSetCondition={(next) => report(setCondition(row.uuid, next))}
						onMove={(affordance) =>
							report(moveLink(row.uuid, affordance.beforeUuid))
						}
						onRemove={() => {
							setEditing((current) =>
								current === row.uuid ? undefined : current,
							);
							report(removeLink(row.uuid));
						}}
					/>
				))}

				<div className="rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3">
					<div className="flex flex-wrap items-center gap-3">
						<span className="text-[13px] font-medium text-nova-text-secondary">
							Otherwise
						</span>
						<DestinationMenu
							ariaLabel="Where people go when no condition matches"
							disabled={!canEdit}
							choices={choices}
							{...(model.otherwise.kind === "link" && {
								selectedKey:
									model.otherwise.link.target.type === "module"
										? `m:${model.otherwise.link.target.moduleUuid}`
										: `f:${model.otherwise.link.target.formUuid}`,
							})}
							label={
								model.otherwise.kind === "link"
									? model.otherwise.label
									: postSubmitLabel(model.otherwise.destination)
							}
							onSelect={(target) => {
								/* Choosing a form or menu here IS the terminal
								 * unconditional link: it fires when nothing above it did
								 * and suppresses the post-submit fallback, which is the
								 * same sentence the row already says. */
								if (model.otherwise.kind === "link") {
									report(setTarget(model.otherwise.link.uuid, target));
									return;
								}
								report(addLink(target));
							}}
							extraItems={POST_SUBMIT_CHOICES.map((choice) => (
								<DropdownMenuItem
									key={choice.value}
									onClick={() => {
										/* Leaving a specific destination means the terminal
										 * link stops existing — the post-submit slot is the
										 * other spelling of the same fallback, never a
										 * second one layered on top. */
										if (model.otherwise.kind === "link") {
											report(removeLink(model.otherwise.link.uuid));
										}
										report(setPostSubmit(choice.value));
									}}
								>
									{choice.label}
								</DropdownMenuItem>
							))}
						/>
					</div>
				</div>

				<DestinationMenu
					ariaLabel="Add a destination with a condition"
					disabled={!canEdit}
					choices={choices}
					label={
						<span className="flex items-center gap-2">
							<Icon icon={tablerPlus} width="14" height="14" />
							Add a destination
						</span>
					}
					onSelect={(target) => {
						const choice = choices.find((candidate) =>
							targetsSamePlace(
								{ uuid: "" as Uuid, order: "", target },
								candidate,
							),
						);
						if (choice !== undefined) addDestination(choice);
					}}
				/>
			</section>
		</ContentFrame>
	);
}

function DestinationRow({
	row,
	choices,
	caseTypes,
	guardCaseType,
	canEdit,
	editing,
	onToggleEditing,
	onSetTarget,
	onSetCondition,
	onMove,
	onRemove,
}: {
	readonly row: LinkRow;
	readonly choices: readonly DestinationChoice[];
	readonly caseTypes: readonly CaseType[];
	readonly guardCaseType: string | undefined;
	readonly canEdit: boolean;
	readonly editing: boolean;
	readonly onToggleEditing: () => void;
	readonly onSetTarget: (target: LinkRow["link"]["target"]) => void;
	readonly onSetCondition: (next: Predicate | undefined) => void;
	readonly onMove: (affordance: MoveAffordance) => void;
	readonly onRemove: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);
	const summary =
		row.link.condition === undefined
			? undefined
			: summarizeFilter(row.link.condition, {
					caseTypes,
					currentCaseType: guardCaseType ?? "",
					knownInputs: [],
				});

	return (
		<div className="rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3">
			<div className="flex flex-wrap items-center gap-3">
				<span className="text-[13px] font-medium text-nova-text-secondary">
					{row.position === 1 ? "If" : "Else if"}
				</span>
				<span className="min-w-0 flex-1 text-[13px] leading-relaxed text-nova-text-secondary [overflow-wrap:anywhere]">
					{summary ?? "this always applies"}
				</span>
				<span className="text-[13px] text-nova-text-muted">go to</span>
				<DestinationMenu
					ariaLabel={`Destination for condition ${row.position}`}
					disabled={!canEdit}
					choices={choices}
					selectedKey={
						row.link.target.type === "module"
							? `m:${row.link.target.moduleUuid}`
							: `f:${row.link.target.formUuid}`
					}
					label={row.destinationLabel}
					onSelect={onSetTarget}
				/>
			</div>

			{row.unreachableBecause !== undefined && (
				<p
					role="alert"
					className="mt-2 text-[13px] leading-relaxed text-nova-rose"
				>
					{row.unreachableBecause}
				</p>
			)}

			<div className="mt-3 flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="ghost"
					size="xl"
					onClick={onToggleEditing}
					aria-expanded={editing}
					className="text-[14px] text-nova-text-secondary"
				>
					{editing ? "Done editing condition" : "Edit condition"}
				</Button>
				<MoveButton
					affordance={row.moveUp}
					canEdit={canEdit}
					label={`Move destination ${row.position} up`}
					icon={tablerArrowNarrowUp}
					onMove={onMove}
				/>
				<MoveButton
					affordance={row.moveDown}
					canEdit={canEdit}
					label={`Move destination ${row.position} down`}
					icon={tablerArrowNarrowDown}
					onMove={onMove}
				/>
				<span className="flex-1" />
				{canEdit &&
					(confirming ? (
						<div
							ref={panelRef}
							tabIndex={-1}
							className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-nova-rose/25 bg-nova-rose/[0.06] p-2.5 outline-none"
						>
							<p className="min-w-0 flex-1 text-[13px] leading-relaxed text-nova-text-secondary">
								Remove the destination "{row.destinationLabel}"?{" "}
								{END_OF_FORM_REMOVAL_CONSEQUENCE}
							</p>
							<Button
								type="button"
								variant="ghost"
								size="xl"
								onClick={() => setConfirming(false)}
								className="text-[14px] text-nova-text-secondary"
							>
								Cancel
							</Button>
							<Button
								type="button"
								variant="destructive"
								size="xl"
								onClick={() => {
									setConfirming(false);
									onRemove();
								}}
								className="text-[14px]"
							>
								Remove
							</Button>
						</div>
					) : (
						<Button
							ref={triggerRef}
							type="button"
							variant="ghost"
							size="xl"
							onClick={() => setConfirming(true)}
							className="text-[14px] text-nova-text-secondary"
						>
							<Icon icon={tablerTrash} width="14" height="14" />
							Remove
						</Button>
					))}
			</div>

			{editing && (
				<div className="mt-3 border-t border-white/[0.06] pt-3">
					<PredicateWorkbench
						value={row.link.condition ?? emptyConditionFallback()}
						onChange={onSetCondition}
						rootLabel="this destination's condition"
						caseTypes={caseTypes}
						currentCaseType={guardCaseType ?? ""}
						evaluationTarget="on-device"
						caseDataScope={guardCaseType === undefined ? "global" : "per-case"}
						/* A destination nobody could ever reach is refused by the
						 * commit gate, so the editor does not offer "never match". */
						allowsNeverMatch={false}
					/>
				</div>
			)}
		</div>
	);
}

/**
 * What a listed row's editor opens on when the link carries no condition.
 *
 * The well-formed shape lifts the one unconditional link into "Otherwise",
 * so a listed row normally has a condition. A document that arrived with
 * an unconditional link mid-list is refused by the gate but must still
 * render, and "always applies" is exactly what that link does — so the
 * editor opens on it rather than on nothing.
 */
function emptyConditionFallback(): Predicate {
	return { kind: "match-all" };
}

function MoveButton({
	affordance,
	canEdit,
	label,
	icon,
	onMove,
}: {
	readonly affordance: MoveAffordance | undefined;
	readonly canEdit: boolean;
	readonly label: string;
	readonly icon: typeof tablerArrowNarrowUp;
	readonly onMove: (affordance: MoveAffordance) => void;
}) {
	if (affordance === undefined) return null;
	const refused = affordance.refusal !== undefined;
	const button = (
		<Button
			type="button"
			variant="ghost"
			size="xl"
			aria-label={label}
			disabled={!canEdit || refused}
			onClick={() => onMove(affordance)}
			className="px-3 text-nova-text-secondary"
		>
			<Icon icon={icon} width="16" height="16" />
		</Button>
	);
	return refused ? (
		<SimpleTooltip content={affordance.refusal}>{button}</SimpleTooltip>
	) : (
		button
	);
}
