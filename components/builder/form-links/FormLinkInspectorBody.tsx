// components/builder/form-links/FormLinkInspectorBody.tsx
//
// One after-submit link's settings, in the rail.
//
// A discrete CHOICE is here (where it goes, what kind of link it is,
// removal); the expressions are on the canvas beside this panel, which is
// already showing the same link. Every choice offered is one the commit
// gate accepts: a destination the target planner refuses is disabled with
// its reason, turning a link into the otherwise link is offered only where
// the planner would admit it, and a removal that pins the fallback says
// so before it commits.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { useFormLinks } from "@/lib/doc/hooks/useFormLinks";
import { useParseXPathForForm } from "@/lib/doc/hooks/useXPathSlots";
import type { Uuid } from "@/lib/doc/types";
import type { CommitOutcome, FormLink, FormLinkTarget } from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { pinsFallbackSentence } from "./afterSubmitCopy";
import { LinkTargetPickerContent } from "./LinkTargetPicker";
import { linkLead } from "./linkSentence";
import { makeOtherwiseUnavailableReason, removalQuestion } from "./refusalCopy";
import {
	retargetDropsCarriedValues,
	retargetLink,
	SEED_CONDITION_TEXT,
} from "./seeds";
import { useLinkSentenceContext } from "./useLinkSentenceContext";

export function FormLinkInspectorBody({
	moduleUuid,
	formUuid,
	linkUuid,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly linkUuid: Uuid;
}) {
	const view = useFormLinks(formUuid);
	const form = useForm(formUuid);
	const sentence = useLinkSentenceContext();
	const parse = useParseXPathForForm(formUuid);
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const [announcement, setAnnouncement] = useState("");

	const plan = view.plan;
	const links = plan?.links ?? [];
	const index = links.findIndex((candidate) => candidate.uuid === linkUuid);
	const link = index < 0 ? undefined : links[index];
	if (plan === undefined || link === undefined || form === undefined)
		return null;

	const isOtherwise = plan.elseLink?.uuid === linkUuid;
	const isLast = index === links.length - 1;
	const lead = linkLead(link.target, sentence);

	const commit = (next: FormLink, said: string): CommitOutcome => {
		const outcome = view.update(next, link);
		if (outcome.ok) {
			setRefusal(undefined);
			/* A write that left every link conditional pinned the built-in
			 * destination in the same batch; the announcement says so. */
			setAnnouncement(
				outcome.pinsFallback === undefined
					? said
					: `${said} ${pinsFallbackSentence(outcome.pinsFallback)}`,
			);
		} else {
			setRefusal(outcome.messages.join(" "));
		}
		return outcome;
	};

	const makeOtherwiseReason = makeOtherwiseUnavailableReason({
		isLast,
		hasElse: plan.elseLink !== undefined,
	});

	return (
		<div className="space-y-5" data-form-link-inspector={link.uuid}>
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

			<fieldset disabled={!canEdit} className="contents">
				<Row
					title="Where it goes"
					description="The form or form list the person lands on."
				>
					<TargetControl
						link={link}
						lead={lead}
						canEdit={canEdit}
						view={view}
						onChoose={(target) => {
							const next = retargetLink(
								link,
								{
									target,
									carry: view.carryVerdict(target),
									required: view.requiredDatums(target),
								},
								parse,
							);
							const dropped = retargetDropsCarriedValues(link, next);
							commit(
								next,
								`Now ${linkLead(target, sentence).toLocaleLowerCase()}.${
									dropped
										? " The values it carried were removed: the new destination needs none."
										: ""
								}`,
							);
						}}
					/>
				</Row>

				<Row
					title="What kind of link"
					description={
						isOtherwise
							? "The otherwise link: followed when nothing above it matched."
							: "A conditional link: followed when its condition is true."
					}
				>
					{isOtherwise ? (
						<Button
							type="button"
							variant="outline"
							className="w-full"
							onClick={() => {
								commit(
									{ ...link, condition: parse(SEED_CONDITION_TEXT) },
									"Added a condition. Write it on the screen beside this panel.",
								);
							}}
						>
							Give it a condition
						</Button>
					) : (
						<div className="space-y-1.5">
							<Button
								type="button"
								variant="outline"
								className="w-full"
								disabled={makeOtherwiseReason !== undefined}
								onClick={() => {
									const { condition: _dropped, ...rest } = link;
									commit(rest, "This is now the otherwise link.");
								}}
							>
								Make this the otherwise link
							</Button>
							{makeOtherwiseReason !== undefined && (
								<p className="text-[13px] leading-relaxed text-nova-text-muted">
									{makeOtherwiseReason}
								</p>
							)}
						</div>
					)}
				</Row>

				{canEdit && (
					<RemoveControl
						lead={lead}
						question={removalQuestion(lead, view.removalPlan(link.uuid))}
						onConfirm={() => {
							const outcome = view.remove(link.uuid);
							if (outcome !== undefined && !outcome.ok) {
								setRefusal(outcome.messages.join(" "));
								return;
							}
							navigate.openFormLinks(moduleUuid, formUuid);
						}}
					/>
				)}
			</fieldset>
		</div>
	);
}

function TargetControl({
	link,
	lead,
	canEdit,
	view,
	onChoose,
}: {
	readonly link: FormLink;
	readonly lead: string;
	readonly canEdit: boolean;
	readonly view: ReturnType<typeof useFormLinks>;
	readonly onChoose: (target: FormLinkTarget) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				disabled={!canEdit}
				aria-label={`Where it goes: ${lead}`}
				render={
					<Button type="button" variant="field" className="group w-full" />
				}
			>
				<span className="min-w-0 flex-1 break-words text-left text-nova-violet-bright">
					{lead}
				</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[22rem] p-2">
				<LinkTargetPickerContent
					verdict={(target) => view.targetVerdict(link.uuid, target)}
					current={link.target}
					onChoose={(target) => {
						setOpen(false);
						onChoose(target);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

function RemoveControl({
	lead,
	question,
	onConfirm,
}: {
	readonly lead: string;
	readonly question: string;
	readonly onConfirm: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);

	if (confirming) {
		return (
			<div
				ref={panelRef}
				tabIndex={-1}
				className="space-y-3 rounded-xl border border-nova-rose/30 bg-nova-rose/[0.05] p-3 outline-none"
			>
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					{question}
				</p>
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="ghost"
						onClick={() => setConfirming(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={() => {
							setConfirming(false);
							onConfirm();
						}}
					>
						Remove it
					</Button>
				</div>
			</div>
		);
	}

	return (
		<Button
			ref={triggerRef}
			type="button"
			variant="ghost-destructive"
			className="w-full justify-start"
			aria-label={`Remove this link: ${lead}`}
			onClick={() => setConfirming(true)}
		>
			<Icon icon={tablerTrash} width="14" height="14" />
			Remove this link
		</Button>
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
		<div className="space-y-2">
			<div>
				<h3 className="text-[13px] font-medium leading-5 text-nova-text-secondary">
					{title}
				</h3>
				<p className="mt-0.5 text-[13px] leading-relaxed text-nova-text-muted">
					{description}
				</p>
			</div>
			{children}
		</div>
	);
}
