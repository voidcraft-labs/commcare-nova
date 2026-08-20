// components/builder/form-links/FormLinksCanvas.tsx
//
// Where the person goes after this form is submitted.
//
// An ordered list: every link, in the order the runtime checks them, each
// one a sentence, and a terminal row that says what happens when none of
// them match. The terminal row is not a link in the list's sense: it is
// always last and never draggable, because its position is its meaning.
//
// Two gestures reorder the conditional links, and they read ONE map to
// stay honest with each other. `formLinkMoveVerdicts` answers the move
// planner's question for every destination at once
// (`lib/doc/formLinkReview.ts`): dragging feeds it to `canDropAtIndex`, so
// a refused destination never opens; a keyboard move asks the same map
// BEFORE committing, and a refusal is SPOKEN rather than the key silently
// doing nothing. The conditional links are always a prefix of the form's
// link list (the otherwise link, when one exists, is last), so the
// reorderable indices ARE the planner's indices.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerCircleX from "@iconify-icons/tabler/circle-x";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import {
	planKeyboardReorder,
	type ReorderKey,
} from "@/components/builder/shared/keyboardReorderPlan";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import { Button } from "@/components/shadcn/button";
import type { FormLinkMoveVerdict } from "@/lib/doc/formLinkReview";
import { useFormLinks } from "@/lib/doc/hooks/useFormLinks";
import { useParseXPathForForm } from "@/lib/doc/hooks/useXPathSlots";
import type { Uuid } from "@/lib/doc/types";
import type { FormLink, FormLinkTarget } from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { AddLinkControl, type LinkKind } from "./AddLinkControl";
import { pinsFallbackSentence } from "./afterSubmitCopy";
import { requestConditionEditorOpen } from "./conditionEditorHint";
import type { ChooserOutcome } from "./FallbackChooser";
import { FormLinkRow } from "./FormLinkRow";
import { linkSentence } from "./linkSentence";
import { OtherwiseRow } from "./OtherwiseRow";
import { moveRefusal, moveRefusalReason } from "./refusalCopy";
import { seedConditionalLink, seedOtherwiseLink } from "./seeds";
import { useLinkSentenceContext } from "./useLinkSentenceContext";

const CONTAINER_KIND = "form-links";

export function FormLinksCanvas({
	moduleUuid,
	formUuid,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
}) {
	const view = useFormLinks(formUuid);
	const sentenceContext = useLinkSentenceContext();
	const parse = useParseXPathForForm(formUuid);
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

	const plan = view.plan;
	/* The conditional links are the reorderable prefix; the otherwise link
	 * (when one exists) is last and rendered by `OtherwiseRow`. */
	const reorderable = useMemo<readonly FormLink[]>(() => {
		if (plan === undefined) return [];
		return plan.elseLink === undefined ? plan.links : plan.links.slice(0, -1);
	}, [plan]);
	const order = useMemo(
		() => reorderable.map((link) => link.uuid),
		[reorderable],
	);
	const leadOf = useCallback(
		(link: FormLink) => linkSentence(link, sentenceContext).lead,
		[sentenceContext],
	);

	/* The dragged row's verdict map, captured the moment its handle is
	 * grabbed: before any pointer move can ask about a destination. */
	const dragVerdictsRef = useRef<ReadonlyMap<
		number,
		FormLinkMoveVerdict
	> | null>(null);

	const commitMove = useCallback(
		(link: FormLink, toIndex: number) => {
			// Ask the planner FIRST, against the live document. The drag gate and
			// the keyboard both route here, so a refusal can never arrive over an
			// edit that already looked like it happened.
			const verdict = view.moveVerdicts(link.uuid).get(toIndex);
			if (verdict !== undefined && !verdict.ok) {
				setRefusal(
					`${leadOf(link)} did not move. ${moveRefusalReason(verdict)}`,
				);
				return undefined;
			}
			const outcome = view.move(link.uuid, toIndex);
			if (outcome === undefined) {
				setRefusal(
					"This link could not move just now, because the list changed while you were moving it. Try again.",
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
		[view, leadOf],
	);

	const { pendingDrop } = useReorderableList<FormLink>({
		containerKey,
		containerKind: CONTAINER_KIND,
		items: reorderable,
		itemKeys: order,
		canDropAtIndex: useCallback(
			(toIndex: number) => dragVerdictsRef.current?.get(toIndex)?.ok !== false,
			[],
		),
		onReorder: (_next, move) => {
			if (!canEdit) return;
			const moved = commitMove(move.item, move.toIndex);
			if (moved !== undefined) {
				setAnnouncement(
					`${leadOf(move.item)} moved, now checked ${moved.index + 1} of ${reorderable.length}.`,
				);
			}
		},
	});

	/* The reason travels WITH the insertion rule, not only below the list. */
	const dropRefusal =
		pendingDrop?.refused === true
			? (moveRefusal(dragVerdictsRef.current?.get(pendingDrop.toIndex)) ??
				"That position is not available.")
			: undefined;

	const moveByKeyboard = (index: number, key: ReorderKey) => {
		if (!canEdit) return;
		const link = reorderable[index];
		if (link === undefined) return;
		const outcome = planKeyboardReorder({
			order,
			index,
			key,
			verdicts: view.moveVerdicts(link.uuid),
			name: leadOf(link),
			refusalOf: moveRefusal,
		});
		if (outcome === undefined) return;
		if (outcome.kind === "move") {
			const moved = commitMove(link, outcome.toIndex);
			if (moved !== undefined) {
				setAnnouncement(
					`${leadOf(link)} moved, now checked ${moved.index + 1} of ${reorderable.length}.`,
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

	const add = (kind: LinkKind, target: FormLinkTarget) => {
		setAddOpen(false);
		const seed = {
			target,
			carry: view.carryVerdict(target),
			required: view.requiredDatums(target),
		};
		const link =
			kind === "conditional"
				? seedConditionalLink(seed, parse)
				: seedOtherwiseLink(seed, parse);
		const outcome = view.add(link);
		if (!outcome.ok) {
			setRefusal(outcome.messages.join(" "));
			return;
		}
		setRefusal(undefined);
		const pinned = outcome.pinsFallback;
		setAnnouncement(
			[
				kind === "conditional" ? "Added a link." : "Added the otherwise link.",
				...(pinned !== undefined ? [pinsFallbackSentence(pinned)] : []),
			].join(" "),
		);
		if (kind === "conditional") requestConditionEditorOpen(link.uuid);
		navigate.openFormLinks(moduleUuid, formUuid, link.uuid);
	};

	const onChooserOutcome = (outcome: ChooserOutcome) => {
		if (outcome.kind === "committed") {
			setAnnouncement(outcome.announcement);
			setRefusal(undefined);
		} else {
			setRefusal(outcome.message);
		}
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
					After submit
				</h1>
				<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
					Where the person goes once this form is submitted. Links are checked
					from the top, and the first one whose condition is true is followed.
					The last row says what happens when none of them match.
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

			{plan === undefined ? (
				<p className="text-[14px] leading-relaxed text-nova-text-muted">
					This form is no longer part of the app.
				</p>
			) : (
				<>
					{reorderable.length === 0 && (
						<p className="mb-4 rounded-2xl border border-dashed border-white/[0.08] px-4 py-6 text-[14px] leading-relaxed text-nova-text-muted">
							This form has no links yet. Add one to send the person somewhere
							when a condition is true.
						</p>
					)}
					<ol
						aria-label="Links in the order they are checked"
						className="mb-4 list-none space-y-2 p-0"
					>
						{reorderable.map((link, index) => (
							<li key={link.uuid}>
								<ReorderableRow
									index={index}
									itemKey={link.uuid}
									containerKey={containerKey}
									containerKind={CONTAINER_KIND}
									pendingDrop={pendingDrop}
									preview={<LinkDragPreview label={leadOf(link)} />}
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
											<FormLinkRow
												link={link}
												sentence={linkSentence(link, sentenceContext)}
												position={index + 1}
												total={reorderable.length}
												canEdit={canEdit}
												beingMoved={beingMoved}
												setHandleEl={setHandleEl}
												onGrab={() => {
													dragVerdictsRef.current = view.moveVerdicts(
														link.uuid,
													);
												}}
												onMove={(key) => moveByKeyboard(index, key)}
												onSelect={() =>
													navigate.openFormLinks(
														moduleUuid,
														formUuid,
														link.uuid,
													)
												}
											/>
											{previewPortal}
										</div>
									)}
								</ReorderableRow>
							</li>
						))}
						<li>
							<OtherwiseRow
								moduleUuid={moduleUuid}
								formUuid={formUuid}
								plan={plan}
								sentenceContext={sentenceContext}
								canEdit={canEdit}
								onOutcome={onChooserOutcome}
							/>
						</li>
					</ol>

					{dropRefusal !== undefined && (
						<p className="mb-4 text-[13px] leading-relaxed text-nova-rose">
							{dropRefusal}
						</p>
					)}

					{canEdit && (
						<AddLinkControl
							view={view}
							open={addOpen}
							onOpenChange={setAddOpen}
							onAdd={add}
						/>
					)}
				</>
			)}
		</ContentFrame>
	);
}

function LinkDragPreview({ label }: { readonly label: string }) {
	return (
		<div className="inline-flex items-center gap-2 rounded-xl border border-nova-violet/35 bg-nova-surface/95 px-3 py-2 text-[13px] text-nova-text shadow-lg backdrop-blur-sm">
			{label}
		</div>
	);
}
