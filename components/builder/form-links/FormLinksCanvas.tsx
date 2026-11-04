// components/builder/form-links/FormLinksCanvas.tsx
//
// Where the person goes after this form is submitted.
//
// An ordered list of destinations, each one a sentence, in the order they
// run: every destination whose condition holds runs, on Android each after
// the one before it finishes, in Web Apps only the first (the
// `after-submit-several-destinations` note row says so under the list). Any
// destination may sit at any position, so every row drags anywhere and the
// keyboard moves it the same way; nothing is disabled for leading back to
// this form. The last row is the Otherwise, shown while the form may hold
// one or holds one: it is fixed, because it is not a position in the order.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
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
import { PlatformNoteRow } from "@/components/builder/shared/PlatformNoteRow";
import {
	ReorderableRow,
	useReorderableList,
} from "@/components/builder/shared/useReorderableList";
import { Button } from "@/components/shadcn/button";
import { useFormLinks } from "@/lib/doc/hooks/useFormLinks";
import type { Uuid } from "@/lib/doc/types";
import type { FormLink, FormLinkTarget } from "@/lib/domain";
import type { PlatformFeatureId } from "@/lib/domain/platforms";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { AddLinkControl, type LinkKind } from "./AddLinkControl";
import { showCommitReportToast } from "./afterSubmitCopy";
import { requestConditionEditorOpen } from "./conditionEditorHint";
import { FormLinkRow } from "./FormLinkRow";
import { linkSentence } from "./linkSentence";
import type { ChooserOutcome } from "./OtherwiseChooser";
import { OtherwiseRow } from "./OtherwiseRow";
import { seedConditionalLink, seedEveryTimeLink, seedTarget } from "./seeds";
import { useLinkSentenceContext } from "./useLinkSentenceContext";

const CONTAINER_KIND = "form-links";

/** The list's platform note: Web Apps opens only the first destination. */
const SEVERAL_DESTINATIONS_NOTE: readonly PlatformFeatureId[] = [
	"after-submit-several-destinations",
];

/** Every position is open to every destination: no move is ever refused. */
const NO_MOVE_REFUSAL = () => undefined;

export function FormLinksCanvas({
	moduleUuid,
	formUuid,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
}) {
	const view = useFormLinks(formUuid);
	const sentenceContext = useLinkSentenceContext(formUuid);
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const containerKey = useId();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const [announcement, setAnnouncement] = useState("");
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const [addOpen, setAddOpen] = useState(false);
	const [otherwiseOpen, setOtherwiseOpen] = useState(false);

	/* Route-change focus entry: the heading names the screen the author just
	 * arrived on, and Back stays one Shift+Tab away in DOM order. */
	useEffect(() => {
		headingRef.current?.focus();
	}, []);

	const plan = view.plan;
	const destinations = useMemo<readonly FormLink[]>(
		() => plan?.destinations ?? [],
		[plan],
	);
	const order = useMemo(
		() => destinations.map((link) => link.uuid),
		[destinations],
	);
	const leadOf = useCallback(
		(link: FormLink) => linkSentence(link, sentenceContext).lead,
		[sentenceContext],
	);

	const commitMove = useCallback(
		(link: FormLink, toIndex: number) => {
			const outcome = view.move(link.uuid, toIndex);
			if (outcome === undefined) {
				setRefusal(
					"This destination could not move just now, because the list changed while you were moving it. Try again.",
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

	const { pendingDrop } = useReorderableList<FormLink>({
		containerKey,
		containerKind: CONTAINER_KIND,
		items: destinations,
		itemKeys: order,
		onReorder: (_next, move) => {
			if (!canEdit) return;
			const moved = commitMove(move.item, move.toIndex);
			if (moved !== undefined) {
				setAnnouncement(
					`${leadOf(move.item)} moved, now runs ${moved.index + 1} of ${moved.total}.`,
				);
			}
		},
	});

	const moveByKeyboard = (index: number, key: ReorderKey) => {
		if (!canEdit) return;
		const link = destinations[index];
		if (link === undefined) return;
		const outcome = planKeyboardReorder({
			order,
			index,
			key,
			verdicts: view.moveVerdicts(link.uuid),
			name: leadOf(link),
			refusalOf: NO_MOVE_REFUSAL,
		});
		if (outcome === undefined) return;
		if (outcome.kind === "move") {
			const moved = commitMove(link, outcome.toIndex);
			if (moved !== undefined) {
				setAnnouncement(
					`${leadOf(link)} moved, now runs ${moved.index + 1} of ${moved.total}.`,
				);
			}
			return;
		}
		setAnnouncement(outcome.announcement);
		setRefusal(undefined);
	};

	const add = (kind: LinkKind, target: FormLinkTarget) => {
		setAddOpen(false);
		const seed = seedTarget(view, target);
		const link =
			kind === "conditional"
				? seedConditionalLink(seed)
				: seedEveryTimeLink(seed);
		const outcome = view.add(link);
		if (!outcome.ok) {
			setRefusal(outcome.messages.join(" "));
			return;
		}
		setRefusal(undefined);
		setAnnouncement(
			kind === "conditional"
				? "Added a destination with a condition."
				: "Added a destination that runs every time.",
		);
		showCommitReportToast(outcome);
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

	/* The Otherwise shows while the form may hold one or holds one; a form
	 * without destinations shows its after-submit in the same row. */
	const showsOtherwise =
		plan !== undefined &&
		(plan.postSubmit !== undefined ||
			plan.otherwiseOffered ||
			plan.otherwise !== undefined);

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
					Where the person goes once this form is submitted. Every destination
					whose condition is true runs, in the order below. Drag a destination
					to change when it runs.
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
					{destinations.length === 0 ? (
						<p className="mb-4 rounded-2xl border border-dashed border-white/[0.08] px-4 py-6 text-[14px] leading-relaxed text-nova-text-muted">
							This form has no destinations yet. Add one to send the person
							somewhere after submit, every time or when a condition is true.
						</p>
					) : (
						<h2
							id={`${containerKey}-heading`}
							className="mb-3 font-display text-[17px] font-semibold tracking-tighter text-nova-text"
						>
							After this form, these run in order
						</h2>
					)}
					<ol
						aria-labelledby={
							destinations.length === 0 ? undefined : `${containerKey}-heading`
						}
						aria-label={
							destinations.length === 0 ? "After this form" : undefined
						}
						className="mb-4 list-none space-y-2 p-0"
					>
						{destinations.map((link, index) => (
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
													<span className="block h-0.5 rounded-full bg-nova-violet" />
												</div>
											)}
											<FormLinkRow
												link={link}
												sentence={linkSentence(link, sentenceContext)}
												position={index + 1}
												total={destinations.length}
												canEdit={canEdit}
												beingMoved={beingMoved}
												setHandleEl={setHandleEl}
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
						{showsOtherwise && (
							<li>
								<OtherwiseRow
									moduleUuid={moduleUuid}
									formUuid={formUuid}
									plan={plan}
									sentenceContext={sentenceContext}
									canEdit={canEdit}
									onOutcome={onChooserOutcome}
									chooserOpen={otherwiseOpen}
									onChooserOpenChange={setOtherwiseOpen}
								/>
							</li>
						)}
					</ol>

					{/* In Web Apps only the first destination that applies opens; the
					 *  note says so, for the platforms the app runs on, once there
					 *  is more than one. */}
					{destinations.length >= 2 && (
						<PlatformNoteRow
							features={SEVERAL_DESTINATIONS_NOTE}
							className="mb-4"
						/>
					)}

					{canEdit && (
						<AddLinkControl
							formUuid={formUuid}
							view={view}
							open={addOpen}
							onOpenChange={setAddOpen}
							onAdd={add}
							onChooseOtherwise={() => setOtherwiseOpen(true)}
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
