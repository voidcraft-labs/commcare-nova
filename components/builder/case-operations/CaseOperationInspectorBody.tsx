// components/builder/case-operations/CaseOperationInspectorBody.tsx
//
// One case change's settings, in the rail.
//
// The division with the centre canvas is a rule: a discrete CHOICE is
// here (what kind of change, which case, which type, how often); a
// recursive EXPRESSION is on the canvas, where it has width. The canvas
// beside this panel is already showing the same change, so the two read
// as one screen rather than two places to look.
//
// Every choice offered here is one the commit gate accepts. Where it
// cannot be — a session case in a module that never selects one, an
// action whose facets would drop authored content — the choice is
// disabled with its reason or asks first, never dispatched into a
// rejection.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useMemo, useRef, useState } from "react";
import { CaseTypePicker } from "@/components/builder/shared/CaseTypePicker";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { FieldError } from "@/components/shadcn/field";
import { useModuleSelectsCaseFirst } from "@/lib/doc/hooks/useCaseOperationFacts";
import { useCaseOperations } from "@/lib/doc/hooks/useCaseOperations";
import { useFormFieldEntries } from "@/lib/doc/hooks/useFormFieldEntries";
import {
	type CaseOperationIdVerdict,
	caseOperationIdVerdict,
} from "@/lib/doc/identifierVerdicts";
import type { Uuid } from "@/lib/doc/types";
import type {
	CaseOperation,
	CaseOperationAction,
	CaseTarget,
} from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { CaseTargetPicker } from "./CaseTargetPicker";
import {
	identityKeyFieldDecls,
	operationReadsOutsideRepeat,
	repeatFieldDecls,
} from "./formFieldScope";
import { dependencyLine } from "./refusalCopy";
import {
	actionChangeLosses,
	reshapeForAction,
	takenOperationIds,
} from "./seeds";

const ACTION_LABEL: Record<CaseOperationAction, string> = {
	create: "Create a case",
	update: "Update a case",
	close: "Close a case",
};

const ACTION_DETAIL: Record<CaseOperationAction, string> = {
	create: "Brings a new case into existence",
	update: "Saves values onto a case that already exists",
	close: "Finishes a case; it can still save final values",
};

export function CaseOperationInspectorBody({
	moduleUuid,
	formUuid,
	operationUuid,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
}) {
	const view = useCaseOperations(formUuid);
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const [refusal, setRefusal] = useState<string | undefined>(undefined);

	const fieldEntries = useFormFieldEntries(formUuid);
	const caseFirst = useModuleSelectsCaseFirst(moduleUuid);

	const operations = view.operations;
	const index = operations.findIndex(
		(candidate) => candidate.uuid === operationUuid,
	);
	const operation = index < 0 ? undefined : operations[index];

	const sessionUnavailableReason = caseFirst
		? undefined
		: "This module does not choose a case before opening its forms, so there is no case in hand";

	const priorCreates = useMemo(
		() =>
			operations
				.slice(0, index < 0 ? 0 : index)
				.filter((candidate) => candidate.action === "create")
				.map((candidate) => ({
					uuid: candidate.uuid,
					label: candidate.id,
				})),
		[operations, index],
	);

	const repeats = useMemo(() => repeatFieldDecls(fieldEntries), [fieldEntries]);

	const identityKeys = useMemo(
		() => identityKeyFieldDecls(fieldEntries, operation?.forEach?.repeat),
		[fieldEntries, operation?.forEach?.repeat],
	);

	if (operation === undefined) return null;

	const commit = (next: CaseOperation) => {
		const outcome = view.update(next);
		setRefusal(outcome.ok ? undefined : outcome.messages.join(" "));
	};

	const fallbackTarget: CaseTarget =
		sessionUnavailableReason === undefined
			? { kind: "session" }
			: priorCreates.length > 0 && priorCreates[0] !== undefined
				? { kind: "op", opUuid: priorCreates[0].uuid }
				: {
						kind: "expression",
						expr: { kind: "term", term: { kind: "literal", value: "" } },
					};

	return (
		<div className="space-y-5" data-case-operation-inspector={operation.uuid}>
			{refusal !== undefined && (
				<div
					role="alert"
					className="flex gap-2 rounded-xl border border-nova-rose/25 bg-nova-rose/[0.06] px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary"
				>
					<Icon
						icon={tablerAlertCircle}
						width="16"
						height="16"
						className="mt-0.5 shrink-0 text-nova-rose"
					/>
					<span>{refusal}</span>
				</div>
			)}

			<Row
				title="Name"
				description="What this change is called here and in messages about it."
			>
				<OperationIdInput
					operation={operation}
					operations={operations}
					canEdit={canEdit}
					onCommit={(id) => commit({ ...operation, id })}
				/>
			</Row>

			<Row title="What it does" description={ACTION_DETAIL[operation.action]}>
				<ActionMenu
					operation={operation}
					canEdit={canEdit}
					sessionUnavailableReason={sessionUnavailableReason}
					onChange={(action) =>
						commit(reshapeForAction(operation, action, fallbackTarget))
					}
				/>
			</Row>

			<Row
				title="Kind of case"
				description="The type of case this change acts on."
			>
				<CaseTypePicker
					value={operation.caseType}
					ariaLabel="Kind of case"
					onChange={(caseType) => commit({ ...operation, caseType })}
				/>
			</Row>

			<Row
				title="Which case"
				description="The case this change acts on when the form is submitted."
			>
				<CaseTargetPicker
					value={operation.target}
					ariaLabel="Which case"
					context={{
						priorCreates,
						sessionUnavailableReason,
						allowsNew: operation.action === "create",
						allowsNone: false,
					}}
					onChange={(target) => {
						if (target === null) return;
						commit({ ...operation, target });
					}}
				/>
			</Row>

			{operation.target.kind === "new" &&
				(identityKeys.length > 0 || operation.target.idFrom !== undefined) && (
					<Row
						title="Identity"
						description="Normally each submission makes a distinct case. Key it on an answer instead when re-submitting the same answer should reach the same case."
					>
						<IdentityKeyMenu
							value={operation.target.idFrom}
							options={identityKeys}
							canEdit={canEdit}
							onChange={(idFrom) =>
								commit({
									...operation,
									target:
										idFrom === undefined
											? { kind: "new" }
											: { kind: "new", idFrom },
								})
							}
						/>
					</Row>
				)}

			{repeats.length > 0 && (
				<Row
					title="How often"
					description="A change can happen once per submission, or once for every entry someone adds to a repeating section."
				>
					<MultiplicityMenu
						operation={operation}
						repeats={repeats}
						canEdit={canEdit}
						wouldStrandReads={(repeat) =>
							operationReadsOutsideRepeat(fieldEntries, operation, repeat)
						}
						onChange={(repeat) =>
							commit({
								...operation,
								forEach: repeat === undefined ? undefined : { repeat },
							})
						}
					/>
				</Row>
			)}

			{operation.action === "update" && (
				<Row
					title="Change the case's type"
					description="Rare. Turns the case into another type, keeping its values."
				>
					<CaseTypePicker
						value={operation.retype}
						placeholder="Leave the type alone"
						ariaLabel="Change the case's type"
						onChange={(retype) => commit({ ...operation, retype })}
						onClear={() => commit({ ...operation, retype: undefined })}
					/>
				</Row>
			)}

			{canEdit && (
				<RemoveOperationRow
					operation={operation}
					view={view}
					onRemoved={() => navigate.openFormOperations(moduleUuid, formUuid)}
					onRefusal={setRefusal}
				/>
			)}
		</div>
	);
}

function Row({
	title,
	description,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly children: React.ReactNode;
}) {
	return (
		<section className="space-y-2">
			<div>
				<h3 className="text-[13px] font-medium leading-5 text-nova-text-secondary">
					{title}
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
					{description}
				</p>
			</div>
			{children}
		</section>
	);
}

/** The id, adjudicated inline so an illegal or duplicate name never
 *  reaches the commit gate. */
function OperationIdInput({
	operation,
	operations,
	canEdit,
	onCommit,
}: {
	readonly operation: CaseOperation;
	readonly operations: readonly CaseOperation[];
	readonly canEdit: boolean;
	readonly onCommit: (id: string) => void;
}) {
	const [rejection, setRejection] = useState<string | undefined>(undefined);
	const taken = useMemo(() => {
		const ids = new Set(takenOperationIds(operations));
		ids.delete(operation.id);
		return ids;
	}, [operations, operation.id]);

	if (!canEdit) {
		return <p className="text-[14px] text-nova-text">{operation.id}</p>;
	}

	return (
		<div className="space-y-1.5">
			<BlurCommitTextInput
				value={operation.id}
				ariaLabel="Name of this change"
				onCommit={(next) => {
					const verdict: CaseOperationIdVerdict = caseOperationIdVerdict(
						next,
						taken,
					);
					if (!verdict.ok) {
						setRejection(verdict.userMessage);
						return;
					}
					setRejection(undefined);
					onCommit(next.trim());
				}}
			/>
			{rejection !== undefined && (
				<FieldError className="text-[13px] text-nova-rose">
					{rejection}
				</FieldError>
			)}
		</div>
	);
}

function ActionMenu({
	operation,
	canEdit,
	sessionUnavailableReason,
	onChange,
}: {
	readonly operation: CaseOperation;
	readonly canEdit: boolean;
	readonly sessionUnavailableReason: string | undefined;
	readonly onChange: (action: CaseOperationAction) => void;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [pending, setPending] = useState<CaseOperationAction | null>(null);
	const { triggerRef: confirmTriggerRef, panelRef } = useInlineConfirmFocus(
		pending !== null,
	);

	if (pending !== null) {
		const losses = actionChangeLosses(operation, pending);
		return (
			<div
				ref={panelRef}
				tabIndex={-1}
				className="space-y-3 rounded-xl border border-nova-amber/30 bg-nova-amber/[0.05] p-3 outline-none"
			>
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					Make this {ACTION_LABEL[pending].toLocaleLowerCase()}? A {pending}{" "}
					change cannot carry {listPhrase(losses)}, so it will be removed. You
					can undo this.
				</p>
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="ghost"
						size="xl"
						onClick={() => setPending(null)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="warning"
						size="xl"
						onClick={() => {
							onChange(pending);
							setPending(null);
						}}
					>
						Change it
					</Button>
				</div>
			</div>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={(element: HTMLButtonElement | null) => {
					triggerRef.current = element;
					confirmTriggerRef.current = element;
				}}
				disabled={!canEdit}
				aria-label={`What it does: ${ACTION_LABEL[operation.action]}`}
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className="group h-auto min-h-11 w-full justify-between rounded-lg border border-white/[0.06] bg-nova-deep/50 px-3 py-2 text-sm whitespace-normal not-disabled:hover:border-nova-violet/30 dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50"
					/>
				}
			>
				<span className="min-w-0 flex-1 break-words text-left text-nova-violet-bright">
					{ACTION_LABEL[operation.action]}
				</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuPortal>
				<DropdownMenuPositioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<DropdownMenuPopup className="min-w-0">
						{(["create", "update", "close"] as const).map((action) => {
							const active = action === operation.action;
							/* An update or a close needs a case that already exists. In a
							 * module that never selects one, that has to come from an
							 * earlier create or a calculation — so the choice stays open
							 * only when this change already has such a target. */
							const needsExisting = action !== "create";
							const reason =
								needsExisting &&
								sessionUnavailableReason !== undefined &&
								operation.target.kind === "new"
									? `${sessionUnavailableReason}. Point this change at an earlier change's case first.`
									: undefined;
							return (
								<DropdownMenuItem
									key={action}
									disabled={reason !== undefined && !active}
									onClick={() => {
										if (active) return;
										if (actionChangeLosses(operation, action).length > 0) {
											setPending(action);
											return;
										}
										onChange(action);
									}}
									className={
										active ? "bg-nova-violet/10 text-nova-violet-bright" : ""
									}
								>
									<span className="min-w-0 flex-1 text-left">
										<span className="block break-words">
											{ACTION_LABEL[action]}
										</span>
										<span className="block break-words text-xs text-nova-text-muted">
											{reason ?? ACTION_DETAIL[action]}
										</span>
									</span>
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}

function IdentityKeyMenu({
	value,
	options,
	canEdit,
	onChange,
}: {
	readonly value: Uuid | undefined;
	readonly options: ReturnType<typeof identityKeyFieldDecls>;
	readonly canEdit: boolean;
	readonly onChange: (idFrom: Uuid | undefined) => void;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const current = options.find((option) => option.uuid === value);
	/* A saved key whose answer is gone must keep saying so: rendering "a
	 * distinct case each time" would claim the opposite of what the document
	 * holds, and the author would have no way to find the stale reference. */
	const missing = value !== undefined && current === undefined;
	const label = missing
		? "Keyed by an answer that is no longer here"
		: current === undefined
			? "A distinct case each time"
			: `Keyed by \u201c${current.label}\u201d`;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				disabled={!canEdit}
				aria-label={`Identity: ${label}`}
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className="group h-auto min-h-11 w-full justify-between rounded-lg border border-white/[0.06] bg-nova-deep/50 px-3 py-2 text-sm whitespace-normal not-disabled:hover:border-nova-violet/30 dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50"
					/>
				}
			>
				<span className="min-w-0 flex-1 text-left">
					<span className="block break-words text-nova-violet-bright">
						{label}
					</span>
					{missing && (
						<span className="block text-xs font-normal text-nova-rose">
							Choose another answer, or go back to a distinct case each time
						</span>
					)}
				</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuPortal>
				<DropdownMenuPositioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<DropdownMenuPopup className="min-w-0">
						<DropdownMenuItem
							onClick={() => onChange(undefined)}
							className={
								value === undefined
									? "bg-nova-violet/10 text-nova-violet-bright"
									: ""
							}
						>
							<span className="min-w-0 flex-1 text-left">
								<span className="block">A distinct case each time</span>
								<span className="block text-xs text-nova-text-muted">
									Every submission makes its own case
								</span>
							</span>
						</DropdownMenuItem>
						{options.map((option) => (
							<DropdownMenuItem
								key={option.uuid}
								onClick={() => onChange(option.uuid)}
								className={
									option.uuid === value
										? "bg-nova-violet/10 text-nova-violet-bright"
										: ""
								}
							>
								<span className="min-w-0 flex-1 break-words text-left">
									Keyed by “{option.label}”
								</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}

function MultiplicityMenu({
	operation,
	repeats,
	canEdit,
	wouldStrandReads,
	onChange,
}: {
	readonly operation: CaseOperation;
	readonly repeats: ReturnType<typeof repeatFieldDecls>;
	readonly canEdit: boolean;
	readonly wouldStrandReads: (repeat: Uuid | undefined) => boolean;
	readonly onChange: (repeat: Uuid | undefined) => void;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const current = repeats.find(
		(repeat) => repeat.uuid === operation.forEach?.repeat,
	);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				disabled={!canEdit}
				aria-label={`How often: ${current === undefined ? "Once per submission" : `Once for each ${current.label} entry`}`}
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className="group h-auto min-h-11 w-full justify-between rounded-lg border border-white/[0.06] bg-nova-deep/50 px-3 py-2 text-sm whitespace-normal not-disabled:hover:border-nova-violet/30 dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50"
					/>
				}
			>
				<span className="min-w-0 flex-1 break-words text-left text-nova-violet-bright">
					{current === undefined
						? "Once per submission"
						: `Once for each “${current.label}” entry`}
				</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuPortal>
				<DropdownMenuPositioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<DropdownMenuPopup className="min-w-0">
						{[undefined, ...repeats.map((repeat) => repeat.uuid)].map(
							(candidate) => {
								const repeat = repeats.find(
									(entry) => entry.uuid === candidate,
								);
								const active = candidate === operation.forEach?.repeat;
								/* Changing multiplicity changes which answers are readable:
								 * a singular change cannot read an answer that has one value
								 * per iteration. Refusing here is what keeps the saved
								 * expressions from becoming references the gate rejects. */
								const strands = !active && wouldStrandReads(candidate);
								return (
									<DropdownMenuItem
										key={candidate ?? "once"}
										disabled={strands}
										onClick={() => onChange(candidate)}
										className={
											active ? "bg-nova-violet/10 text-nova-violet-bright" : ""
										}
									>
										<span className="min-w-0 flex-1 text-left">
											<span className="block break-words">
												{repeat === undefined
													? "Once per submission"
													: `Once for each “${repeat.label}” entry`}
											</span>
											{strands && (
												<span className="block break-words text-xs text-nova-text-muted">
													This change reads answers it could no longer reach
													here. Change those values first.
												</span>
											)}
										</span>
									</DropdownMenuItem>
								);
							},
						)}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}

/**
 * Removal, with the dependency review the planner already computes.
 *
 * `removalPlan` is asked BEFORE the button does anything, so a change
 * something else depends on never offers a delete that would bounce.
 * The review names each consumer and the exact slot holding the
 * reference — on a twenty-change form, "Update client uses it" is not
 * actionable while "in the value it saves to status" is.
 */
function RemoveOperationRow({
	operation,
	view,
	onRemoved,
	onRefusal,
}: {
	readonly operation: CaseOperation;
	readonly view: ReturnType<typeof useCaseOperations>;
	readonly onRemoved: () => void;
	readonly onRefusal: (message: string) => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);
	/* Both walk the whole operation graph, so they run when the document or
	 * the selection changes — not on every keystroke in a sibling input. */
	const plan = useMemo(
		() => view.removalPlan(operation.uuid),
		[view, operation.uuid],
	);
	const dependents = useMemo(
		() => view.dependentsOf(operation.uuid),
		[view, operation.uuid],
	);

	if (!plan.ok && plan.reason !== "operation-not-found") {
		return (
			<section className="space-y-2 border-t border-white/[0.06] pt-4">
				<h3 className="text-[13px] font-medium leading-5 text-nova-text-secondary">
					Remove this change
				</h3>
				<div className="space-y-2 rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3">
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						This change cannot be removed while other changes use it:
					</p>
					<ul className="list-none space-y-1 p-0 text-[13px] leading-relaxed text-nova-text-muted">
						{dependents.map((dependent) => (
							<li key={dependent.operationUuid}>
								{dependencyLine(
									view.nameOf(dependent.operationUuid),
									dependent.slots,
								)}
							</li>
						))}
					</ul>
				</div>
			</section>
		);
	}

	if (confirming) {
		return (
			<section
				ref={panelRef}
				tabIndex={-1}
				className="space-y-3 rounded-xl border border-nova-rose/30 bg-nova-rose/[0.05] p-3 outline-none"
			>
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					Remove “{operation.id}”? Submitting this form will stop making that
					case change. You can undo this.
				</p>
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="ghost"
						size="xl"
						onClick={() => setConfirming(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						size="xl"
						onClick={() => {
							const outcome = view.remove(operation.uuid);
							setConfirming(false);
							if (outcome === undefined) {
								onRefusal(
									"That change could not be removed just now. Reopen it and try again.",
								);
								return;
							}
							if (!outcome.ok) {
								onRefusal(outcome.messages.join(" "));
								return;
							}
							onRemoved();
						}}
					>
						Remove change
					</Button>
				</div>
			</section>
		);
	}

	return (
		<section className="border-t border-white/[0.06] pt-4">
			<Button
				ref={triggerRef}
				type="button"
				variant="ghost"
				size="xl"
				onClick={() => setConfirming(true)}
				className="w-full justify-start px-3 text-sm text-nova-rose not-disabled:hover:bg-nova-rose/[0.08] not-disabled:hover:text-nova-rose"
			>
				<Icon icon={tablerTrash} width="15" height="15" />
				Remove this change
			</Button>
		</section>
	);
}

/** "A", "A and B", "A, B and C". */
function listPhrase(items: readonly string[]): string {
	if (items.length === 0) return "what it carries";
	if (items.length === 1) return items[0];
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
