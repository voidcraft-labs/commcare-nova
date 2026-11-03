// components/builder/form-links/FormLinkDetailCanvas.tsx
//
// One after-submit link, opened: a destination, or the otherwise link.
//
// The division with the rail is the case-operations rule: an EXPRESSION
// is here in the centre canvas where it has width (the condition, the
// values carried by hand); a discrete CHOICE is in the rail (where it
// goes, when it runs, whether it is the Otherwise, removal). Both expression
// slots are session-scoped: see `LinkConditionEditor`. A link to a module's
// form list carries nothing (CommCare HQ's form settings page offers a menu
// no values), so its carried-values section shows only to remove values a
// menu link still holds.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { useEffect, useRef, useState } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { Button } from "@/components/shadcn/button";
import { useFormLinks } from "@/lib/doc/hooks/useFormLinks";
import type { Uuid } from "@/lib/doc/types";
import type { FormLink } from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { showCommitReportToast } from "./afterSubmitCopy";
import { CarryValuesSection } from "./CarryValuesSection";
import {
	clearConditionEditorOpen,
	peekConditionEditorOpen,
} from "./conditionEditorHint";
import { LinkConditionEditor } from "./LinkConditionEditor";
import { linkSentence } from "./linkSentence";
import { useLinkSentenceContext } from "./useLinkSentenceContext";

export function FormLinkDetailCanvas({
	moduleUuid,
	formUuid,
	linkUuid,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly linkUuid: Uuid;
}) {
	const view = useFormLinks(formUuid);
	const sentenceContext = useLinkSentenceContext(formUuid);
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	/* Read once, on arrival: the list asked for the editor to open because
	 * the link was just added with a placeholder condition. The read is pure
	 * (a render may run twice) and the ask retires once this detail has
	 * mounted with it. */
	const [openEditorOnArrival] = useState(() =>
		peekConditionEditorOpen(linkUuid),
	);
	useEffect(() => {
		clearConditionEditorOpen(linkUuid);
	}, [linkUuid]);

	const plan = view.plan;
	/* The list as the canvas walks it: every destination in order, then the
	 * otherwise link when the Otherwise is one. */
	const otherwiseLink =
		plan?.otherwise?.kind === "link" ? plan.otherwise : undefined;
	const destinations = plan?.destinations ?? [];
	const walk = [
		...destinations.map((candidate) => candidate.uuid),
		...(otherwiseLink === undefined ? [] : [otherwiseLink.uuid]),
	];
	const index = walk.indexOf(linkUuid);
	const destination = destinations.find(
		(candidate) => candidate.uuid === linkUuid,
	);
	const isOtherwise = otherwiseLink?.uuid === linkUuid;
	/* The otherwise link seen as a link for the shared editors: the same
	 * uuid, target and carried values, with no condition. */
	const link: FormLink | undefined =
		destination ??
		(isOtherwise && otherwiseLink !== undefined
			? {
					uuid: otherwiseLink.uuid,
					target: otherwiseLink.target,
					...(otherwiseLink.datums !== undefined && {
						datums: otherwiseLink.datums,
					}),
				}
			: undefined);

	useEffect(() => {
		headingRef.current?.focus();
	}, []);

	const backToList = () => navigate.openFormLinks(moduleUuid, formUuid);

	if (plan === undefined || link === undefined) {
		/* The recovery effect scrubs a stale uuid on the next tick; until it
		 * does, say what happened rather than rendering a blank. */
		return (
			<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
				<p className="text-[14px] leading-relaxed text-nova-text-muted">
					That link is no longer part of this form.
				</p>
			</ContentFrame>
		);
	}

	const sentence = linkSentence(
		link,
		sentenceContext,
		isOtherwise ? "otherwise" : "destination",
	);
	const commit = (next: FormLink) => {
		if (!canEdit) return { ok: false as const, messages: [] };
		const outcome =
			destination !== undefined
				? view.update(next, destination)
				: view.setOtherwise({
						kind: "link",
						uuid: next.uuid,
						target: next.target,
						...(next.datums !== undefined && { datums: next.datums }),
					});
		setRefusal(outcome.ok ? undefined : outcome.messages.join(" "));
		if (outcome.ok) showCommitReportToast(outcome);
		return outcome;
	};
	const open = (uuid: Uuid | undefined) => {
		if (uuid !== undefined) navigate.openFormLinks(moduleUuid, formUuid, uuid);
	};

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
			<div className="mb-5 flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="ghost"
					onClick={backToList}
					className="-ml-2"
				>
					<Icon icon={tablerArrowLeft} width="16" height="16" />
					After submit
				</Button>
				<span className="text-[13px] text-nova-text-muted">
					{isOtherwise
						? "Otherwise"
						: `Runs ${index + 1} of ${destinations.length}`}
				</span>
				<span className="ml-auto flex gap-1">
					<Button
						type="button"
						variant="ghost"
						disabled={index === 0}
						aria-label="Previous link"
						onClick={() => open(walk[index - 1])}
					>
						<Icon icon={tablerChevronLeft} width="16" height="16" />
						Previous
					</Button>
					<Button
						type="button"
						variant="ghost"
						disabled={index === walk.length - 1}
						aria-label="Next link"
						onClick={() => open(walk[index + 1])}
					>
						Next
						<Icon icon={tablerChevronRight} width="16" height="16" />
					</Button>
				</span>
			</div>

			<header className="mb-7">
				<p className="text-[13px] font-medium text-nova-text-muted">
					{isOtherwise ? "Otherwise" : "After submit destination"}
				</p>
				<h1
					ref={headingRef}
					tabIndex={-1}
					className="mt-1 font-display text-2xl font-semibold tracking-tighter text-nova-text outline-none"
				>
					{sentence.lead}
				</h1>
				<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
					When this runs and what travels with the person. Where it goes, and
					whether it is the Otherwise, are in the panel beside this screen.
				</p>
			</header>

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

			<fieldset disabled={!canEdit} className="contents">
				<Section
					title="When it runs"
					description={
						isOtherwise
							? "When no destination with a condition or a carried case runs. The Otherwise has no condition of its own."
							: link.condition !== undefined
								? "Only when this is true once the form has been submitted. Every destination whose condition is true runs, in the list's order."
								: "Every time the form is submitted, in its place in the list. You can give it a condition in the panel beside this screen."
					}
				>
					{isOtherwise ? (
						<p className="text-[14px] leading-relaxed text-nova-text-secondary">
							To send the person somewhere when a condition is true, add a
							destination with a condition.
						</p>
					) : link.condition !== undefined ? (
						<LinkConditionEditor
							formUuid={formUuid}
							link={link}
							canEdit={canEdit}
							autoEdit={openEditorOnArrival}
							onCommit={commit}
						/>
					) : (
						<p className="text-[14px] leading-relaxed text-nova-text-secondary">
							{sentence.details.join(" · ")}
						</p>
					)}
				</Section>

				{(link.target.type !== "module" || link.datums !== undefined) && (
					<Section
						title="Carry values"
						description="What the destination needs to know about the case when the person arrives."
					>
						<CarryValuesSection
							formUuid={formUuid}
							link={link}
							view={view}
							canEdit={canEdit}
							onCommit={commit}
						/>
					</Section>
				)}
			</fieldset>
		</ContentFrame>
	);
}

function Section({
	title,
	description,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly children: React.ReactNode;
}) {
	return (
		<section className="mb-6 rounded-2xl border border-white/[0.08] bg-nova-surface/25 p-4 @sm:p-5">
			<div className="mb-4">
				<h2 className="font-display text-[17px] font-semibold tracking-tighter text-nova-text">
					{title}
				</h2>
				<p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-nova-text-muted">
					{description}
				</p>
			</div>
			{children}
		</section>
	);
}
