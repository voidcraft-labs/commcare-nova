// components/builder/case-operations/CaseOperationsCanvas.tsx
//
// What submitting this form does to the case universe.
//
// The research memo's sharpest criticism of the platform's own surface is
// that it configures a system-level construct at question-level scope,
// with no screen anywhere showing what one submission does. This ordered
// list is Nova's answer: every change the submission makes, in the order
// the runtime applies them, each one a sentence.
//
// Two gestures reorder it, and they read ONE map to stay honest with each
// other. `caseOperationMoveVerdicts` answers the move planner's question
// for every destination at once (`lib/doc/caseOperationReview.ts`):
//
//   - dragging feeds it to `canDropAtIndex`, so a refused destination
//     never opens and a release over it commits nothing;
//   - a keyboard move asks the same map BEFORE committing, and a refusal
//     is SPOKEN: naming the changes it is about, rather than the key
//     silently doing nothing. That parity is the whole point: a keyboard
//     author gets the information a pointer author reads off the drop
//     zone.
//
// The refusal wording keeps `dependent-reference` and `execution-order`
// apart on purpose. The second one is not a mistake the author made: the
// submitted form cannot represent that sequence, because CommCare's two
// processors would order it differently.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerCirclePlus from "@iconify-icons/tabler/circle-plus";
import tablerCircleX from "@iconify-icons/tabler/circle-x";
import tablerPencil from "@iconify-icons/tabler/pencil";
import tablerPlus from "@iconify-icons/tabler/plus";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { CaseTypePickerContent } from "@/components/builder/shared/CaseTypePicker";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { caseOperationTargetTypeAfter } from "@/lib/doc/caseOperationIntents";
import type { CaseOperationMoveVerdict } from "@/lib/doc/caseOperationReview";
import {
	useFormHasSessionCase,
	useModuleCaseType,
} from "@/lib/doc/hooks/useCaseOperationFacts";
import { useCaseOperations } from "@/lib/doc/hooks/useCaseOperations";
import { asUuid, type Uuid } from "@/lib/doc/types";
import {
	type CaseOperation,
	RESERVED_CASE_OPERATION_TYPES,
} from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { POPOVER_ROW_CLS } from "@/lib/styles";
import { CaseOperationRow } from "./CaseOperationRow";
import { planKeyboardMove, type ReorderKey } from "./keyboardMove";
import { moveRefusalReason } from "./refusalCopy";
import { seedCaseOperation, takenOperationIds } from "./seeds";
import { useOperationSentenceContext } from "./useOperationSentenceContext";

const CONTAINER_KIND = "case-operations";

export function CaseOperationsCanvas({
	moduleUuid,
	formUuid,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
}) {
	const view = useCaseOperations(formUuid);
	const context = useOperationSentenceContext(formUuid);
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const containerKey = useId();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const [announcement, setAnnouncement] = useState("");
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const [addOpen, setAddOpen] = useState(false);

	/* Route-change focus entry: the heading names the screen the author just
	 * arrived on, and Back stays one Shift+Tab away in DOM order. */
	useEffect(() => {
		headingRef.current?.focus();
	}, []);

	const operations = view.operations;
	const order = useMemo(
		() => operations.map((operation) => operation.uuid),
		[operations],
	);

	/* The dragged row's verdict map, captured the moment its handle is
	 * grabbed: before any pointer move can ask about a destination. Reading
	 * it from drag state instead would leave the first pointer move
	 * ungated. */
	const dragVerdictsRef = useRef<ReadonlyMap<
		number,
		CaseOperationMoveVerdict
	> | null>(null);

	const commitMove = useCallback(
		(uuid: Uuid, toIndex: number) => {
			// Ask the planner FIRST, against the live document. The drag gate and
			// the keyboard both route here, so a refusal can never arrive as a
			// toast over an edit that already looked like it happened.
			const verdicts = view.moveVerdicts(uuid);
			const verdict = verdicts.get(toIndex);
			if (verdict !== undefined && !verdict.ok) {
				/* An alert, not a status: the screen is otherwise unchanged, so
				 * without it the gesture reads as a no-op. The polite region
				 * carries only outcomes that DID something. */
				setRefusal(
					`${view.nameOf(uuid) ?? "This change"} did not move. ${moveRefusalReason(
						verdict,
						view.nameOf,
						{ moved: uuid, dependsOn: view.dependenciesOf(uuid) },
					)}`,
				);
				return undefined;
			}
			const outcome = view.move(uuid, toIndex);
			if (outcome === undefined) {
				// The document moved under the gesture (a peer edit between the
				// verdict and the commit). Say so plainly rather than doing nothing.
				setRefusal(
					"This change could not move just now, because the list changed while you were moving it. Try again.",
				);
				return undefined;
			}
			if (!outcome.ok) {
				setRefusal(outcome.messages.join(" "));
				return undefined;
			}
			setRefusal(undefined);
			return outcome;
		},
		[view],
	);

	const { pendingDrop } = useReorderableList<CaseOperation>({
		containerKey,
		containerKind: CONTAINER_KIND,
		items: operations,
		itemKeys: order,
		canDropAtIndex: useCallback(
			(toIndex: number) => dragVerdictsRef.current?.get(toIndex)?.ok !== false,
			[],
		),
		onReorder: (_next, move) => {
			if (!canEdit) return;
			const moved = commitMove(move.item.uuid, move.toIndex);
			if (moved !== undefined) {
				setAnnouncement(
					`${move.item.id} moved, now ${moved.index + 1} of ${moved.total}.`,
				);
			}
		},
	});

	/* A refused destination cannot be signalled by the insertion rule's HUE
	 * alone: that is state conveyed by color, and on the twenty-change form
	 * this screen is designed for, the sentence below the list can be a
	 * screenful away from the pointer. The reason travels WITH the rule. */
	const dropRefusal =
		pendingDrop?.refused === true
			? dragRefusalText(
					dragVerdictsRef.current,
					pendingDrop.toIndex,
					asUuid(pendingDrop.itemKey),
					view,
				)
			: undefined;

	const moveByKeyboard = (index: number, key: ReorderKey) => {
		if (!canEdit) return;
		const uuid = order[index];
		if (uuid === undefined) return;
		const outcome = planKeyboardMove({
			order,
			index,
			key,
			verdicts: view.moveVerdicts(uuid),
			nameOf: view.nameOf,
			dependsOn: view.dependenciesOf(uuid),
		});
		if (outcome === undefined) return;
		if (outcome.kind === "move") {
			const moved = commitMove(uuid, outcome.toIndex);
			if (moved !== undefined) {
				setAnnouncement(
					`${view.nameOf(uuid) ?? "This change"} moved, now ${moved.index + 1} of ${moved.total}.`,
				);
				setRefusal(undefined);
			}
			return;
		}
		if (outcome.kind === "refused") {
			// The refusal is the alert; the polite region stays quiet so the
			// author hears one sentence, not two.
			setRefusal(outcome.announcement);
			setAnnouncement("");
			return;
		}
		setAnnouncement(outcome.announcement);
		setRefusal(undefined);
	};

	const add = (operation: CaseOperation) => {
		const outcome = view.add(operation);
		setAddOpen(false);
		if (!outcome.ok) {
			setRefusal(outcome.messages.join(" "));
			return;
		}
		setRefusal(undefined);
		setAnnouncement(`Added ${operation.id}.`);
		navigate.openFormOperations(moduleUuid, formUuid, operation.uuid);
	};

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
			<Button
				type="button"
				variant="ghost"
				onClick={() => navigate.push({ kind: "form", moduleUuid, formUuid })}
				className="-ml-2 mb-5"
			>
				<Icon icon={tablerArrowLeft} width="16" height="16" />
				Back to the form
			</Button>

			<header className="mb-7">
				<h1
					ref={headingRef}
					tabIndex={-1}
					className="font-display text-2xl font-semibold tracking-tighter text-nova-text outline-none"
				>
					Case changes
				</h1>
				<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
					Everything submitting this form does to your cases, in the order it
					happens. Each change can create a case, update one, or close one, and
					a later change can use a case an earlier one made.
				</p>
			</header>

			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				className="sr-only"
			>
				{announcement}
			</p>

			{refusal !== undefined && (
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
					<span>{refusal}</span>
				</div>
			)}

			{operations.length === 0 ? (
				<p className="mb-4 rounded-2xl border border-dashed border-white/[0.08] px-4 py-6 text-[14px] leading-relaxed text-nova-text-muted">
					This form doesn't change any cases yet. Submitting it records the
					answers and nothing else.
				</p>
			) : (
				<ol
					aria-label="Case changes in the order they happen"
					className="mb-4 list-none space-y-2 p-0"
				>
					{operations.map((operation, index) => (
						<li key={operation.uuid}>
							<ReorderableRow
								index={index}
								itemKey={operation.uuid}
								containerKey={containerKey}
								containerKind={CONTAINER_KIND}
								pendingDrop={pendingDrop}
								preview={<OperationDragPreview label={operation.id} />}
							>
								{({
									wrapperRef,
									setHandleEl,
									closestEdge,
									previewPortal,
									beingMoved,
								}) => (
									<div ref={wrapperRef} className="relative">
										{closestEdge !== null && (
											<div
												aria-hidden="true"
												className="absolute left-3 right-3 z-10"
												style={{
													top: closestEdge === "top" ? -5 : undefined,
													bottom: closestEdge === "bottom" ? -5 : undefined,
												}}
											>
												{dropRefusal === undefined ? (
													<span className="block h-0.5 rounded-full bg-nova-violet" />
												) : (
													/* Shape AND words, not just a hue: a dashed rule
													 *  reads as blocked without color vision, and the
													 *  reason is at the pointer rather than below a
													 *  list that may be a screen long. */
													<span className="flex items-center gap-2">
														<span className="h-0 flex-1 border-t-2 border-dashed border-nova-rose" />
														<span className="flex max-w-sm items-start gap-1.5 rounded-lg border border-nova-rose/30 bg-nova-void px-2 py-1 text-xs leading-relaxed text-nova-text-secondary shadow-lg">
															<Icon
																icon={tablerCircleX}
																width="14"
																height="14"
																className="mt-0.5 shrink-0 text-nova-rose"
															/>
															<span className="min-w-0 break-words">
																{dropRefusal}
															</span>
														</span>
													</span>
												)}
											</div>
										)}
										<CaseOperationRow
											operation={operation}
											context={context}
											position={index + 1}
											total={operations.length}
											canEdit={canEdit}
											inheritedGuards={guardNames(view, operation.uuid)}
											beingMoved={beingMoved}
											setHandleEl={setHandleEl}
											onGrab={() => {
												dragVerdictsRef.current = view.moveVerdicts(
													operation.uuid,
												);
											}}
											onMove={(key) => moveByKeyboard(index, key)}
											onSelect={() =>
												navigate.openFormOperations(
													moduleUuid,
													formUuid,
													operation.uuid,
												)
											}
										/>
										{previewPortal}
									</div>
								)}
							</ReorderableRow>
						</li>
					))}
				</ol>
			)}

			{dropRefusal !== undefined && (
				<p className="mb-4 text-[13px] leading-relaxed text-nova-rose">
					{dropRefusal}
				</p>
			)}

			{canEdit && (
				<AddChangeControl
					moduleUuid={moduleUuid}
					formUuid={formUuid}
					operations={operations}
					addVerdict={view.addVerdict}
					open={addOpen}
					onOpenChange={setAddOpen}
					onAdd={add}
				/>
			)}
		</ContentFrame>
	);
}

/** The names of the changes whose conditions this one inherits. */
function guardNames(
	view: ReturnType<typeof useCaseOperations>,
	uuid: Uuid,
): readonly string[] {
	return (view.inheritedGuards.get(uuid) ?? [])
		.map((guard) => view.nameOf(guard))
		.filter((name): name is string => name !== undefined);
}

/** The live refusal shown beneath a drag hovering an unavailable slot. */
function dragRefusalText(
	verdicts: ReadonlyMap<number, CaseOperationMoveVerdict> | null,
	toIndex: number,
	moved: Uuid | undefined,
	view: ReturnType<typeof useCaseOperations>,
): string {
	const verdict = verdicts?.get(toIndex);
	if (verdict === undefined || verdict.ok || moved === undefined) {
		return "That position is not available.";
	}
	return moveRefusalReason(verdict, view.nameOf, {
		moved,
		dependsOn: view.dependenciesOf(moved),
	});
}

function OperationDragPreview({ label }: { readonly label: string }) {
	return (
		<div className="inline-flex items-center gap-2 rounded-xl border border-nova-violet/35 bg-nova-surface/95 px-3 py-2 text-[13px] text-nova-text shadow-lg backdrop-blur-sm">
			{label}
		</div>
	);
}

type SessionChangeChoice =
	| { readonly available: true; readonly operation: CaseOperation }
	| { readonly available: false; readonly reason: string };

/**
 * Adding is chooser-first: the question is what the change DOES, because
 * that answer decides the action, the target, and which facets are legal.
 * Every choice lands a complete, valid change and opens it.
 */
function AddChangeControl({
	moduleUuid,
	formUuid,
	operations,
	addVerdict,
	open,
	onOpenChange,
	onAdd,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly operations: readonly CaseOperation[];
	readonly addVerdict: ReturnType<typeof useCaseOperations>["addVerdict"];
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onAdd: (operation: CaseOperation) => void;
}) {
	const [mode, setMode] = useState<"intent" | "create-type">("intent");
	const moduleCaseType = useModuleCaseType(moduleUuid);
	const sessionAvailable = useFormHasSessionCase(moduleUuid, formUuid);
	const sessionCaseType =
		sessionAvailable && moduleCaseType !== undefined
			? caseOperationTargetTypeAfter(
					operations,
					{ kind: "session" },
					moduleCaseType,
				)
			: undefined;
	const sessionReason = !sessionAvailable
		? "This form doesn't open with a case in hand to change"
		: sessionCaseType === undefined
			? "Nova cannot determine which kind of case this form has in hand at this point"
			: RESERVED_CASE_OPERATION_TYPES.has(sessionCaseType)
				? "This case type is managed by the platform and cannot be changed here"
				: undefined;
	const sessionChoices = useMemo<{
		readonly update: SessionChangeChoice;
		readonly close: SessionChangeChoice;
	}>(() => {
		if (sessionReason !== undefined || sessionCaseType === undefined) {
			const reason =
				sessionReason ??
				"Nova cannot determine which kind of case this form has in hand at this point";
			return {
				update: { available: false, reason },
				close: { available: false, reason },
			};
		}
		const takenIds = takenOperationIds(operations);
		const choice = (
			kind: "update-session" | "close-session",
		): SessionChangeChoice => {
			const operation = seedCaseOperation(
				{ kind, caseType: sessionCaseType },
				takenIds,
			);
			const verdict = addVerdict(operation);
			return verdict.ok
				? { available: true, operation }
				: { available: false, reason: verdict.reason };
		};
		return {
			update: choice("update-session"),
			close: choice("close-session"),
		};
	}, [addVerdict, operations, sessionCaseType, sessionReason]);
	/* Stable so `CaseTypePickerContent` can memoize the whole verdict map: it
	 * asks once per offered case type, each ask is a whole-document validation,
	 * and the picker re-renders on every keystroke in its create-new box. The
	 * verdict itself cannot be value-cached here the way an edit verdict is:
	 * `seedCaseOperation` mints a fresh uuid per call, so each candidate is a
	 * new identity, which is exactly why the stability has to live here. */
	const createTypeVerdict = useCallback(
		(caseType: string) =>
			addVerdict(
				seedCaseOperation(
					{ kind: "create", caseType },
					takenOperationIds(operations),
				),
			),
		[addVerdict, operations],
	);
	const updateSessionReason = sessionChoices.update.available
		? undefined
		: sessionChoices.update.reason;
	const closeSessionReason = sessionChoices.close.available
		? undefined
		: sessionChoices.close.reason;

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) setMode("intent");
			}}
		>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						data-case-operations-add
						className="nova-add-slot w-full gap-2"
					/>
				}
			>
				<Icon icon={tablerPlus} width="14" height="14" />
				<span className="flex-1 text-left">Add a change</span>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[22rem] p-2">
				{mode === "create-type" ? (
					<div className="space-y-2">
						<p className="px-1 pt-1 text-[13px] leading-relaxed text-nova-text-secondary">
							What kind of case does this form create?
						</p>
						<CaseTypePickerContent
							exclude={RESERVED_CASE_OPERATION_TYPES}
							choiceVerdict={createTypeVerdict}
							onChange={(caseType) =>
								onAdd(
									seedCaseOperation(
										{ kind: "create", caseType },
										takenOperationIds(operations),
									),
								)
							}
						/>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setMode("intent")}
							className="w-full justify-start text-[13px]"
						>
							<Icon icon={tablerArrowLeft} width="14" height="14" />
							Back
						</Button>
					</div>
				) : (
					<div className="space-y-1">
						<IntentRow
							icon={tablerCirclePlus}
							title="Create a case"
							detail="Make a new case when this form is submitted"
							onClick={() => setMode("create-type")}
						/>
						<IntentRow
							icon={tablerPencil}
							title="Update the case this form opened"
							detail={
								updateSessionReason ??
								"Save answers onto the case already in hand"
							}
							disabledReason={updateSessionReason}
							onClick={() => {
								if (sessionChoices.update.available) {
									onAdd(sessionChoices.update.operation);
								}
							}}
						/>
						<IntentRow
							icon={tablerCircleX}
							title="Close the case this form opened"
							detail={
								closeSessionReason ??
								"Finish the case in hand; it can still save final answers"
							}
							disabledReason={closeSessionReason}
							onClick={() => {
								if (sessionChoices.close.available) {
									onAdd(sessionChoices.close.operation);
								}
							}}
						/>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

function IntentRow({
	icon,
	title,
	detail,
	disabledReason,
	onClick,
}: {
	readonly icon: Parameters<typeof Icon>[0]["icon"];
	readonly title: string;
	readonly detail: string;
	readonly disabledReason?: string;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabledReason !== undefined}
			onClick={onClick}
			className={POPOVER_ROW_CLS}
		>
			<Icon
				icon={icon}
				width="16"
				height="16"
				className="mt-0.5 shrink-0 text-nova-violet-bright"
			/>
			<span className="min-w-0 flex-1">
				<span className="block text-sm font-medium text-nova-text">
					{title}
				</span>
				<span className="block text-[13px] leading-snug text-nova-text-muted">
					{detail}
				</span>
			</span>
		</button>
	);
}
