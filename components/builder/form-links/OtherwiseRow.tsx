// components/builder/form-links/OtherwiseRow.tsx
//
// The list's last row: where the form goes when no destination that may not
// run runs.
//
// Always last and never draggable, because it is not a destination in the
// list's order: CommCare HQ pushes its frame after every destination's, so it
// opens before any destination that runs every time. The canvas shows it
// while the form may hold an Otherwise (`plan.otherwiseOffered`) or holds one
// (so a stored Otherwise the gate now finds has a place to be repaired). It
// shows the otherwise link (with a way into its detail, where its carried
// values live), the built-in destination, or the app home an absent
// Otherwise means, and carries the one chooser (`OtherwiseChooser`) that
// changes it. A form without destinations shows its after-submit in the
// same place, through the same chooser.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import { Button } from "@/components/shadcn/button";
import type { AfterSubmitPlan } from "@/lib/doc/formLinkMutations";
import type { Uuid } from "@/lib/doc/types";
import { useNavigate } from "@/lib/routing/hooks";
import {
	hasEveryTimeDestination,
	otherwiseSentence,
	otherwiseSubtitle,
	postSubmitSentence,
} from "./afterSubmitCopy";
import { type LinkSentenceContext, linkSentence } from "./linkSentence";
import { type ChooserOutcome, OtherwiseChooser } from "./OtherwiseChooser";

export function OtherwiseRow({
	moduleUuid,
	formUuid,
	plan,
	sentenceContext,
	canEdit,
	onOutcome,
	chooserOpen,
	onChooserOpenChange,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly plan: AfterSubmitPlan;
	readonly sentenceContext: LinkSentenceContext;
	readonly canEdit: boolean;
	readonly onOutcome: (outcome: ChooserOutcome) => void;
	/** The chooser's open state, which the add control can set. */
	readonly chooserOpen?: boolean;
	readonly onChooserOpenChange?: (open: boolean) => void;
}) {
	const navigate = useNavigate();
	const otherwise = plan.otherwise;
	const link = otherwise?.kind === "link" ? otherwise : undefined;
	/* A form without destinations shows its after-submit here instead, so
	 * the one chooser stays where the list is. */
	const postSubmit = plan.postSubmit;
	const lead =
		postSubmit !== undefined
			? postSubmitSentence(postSubmit.destination)
			: otherwiseSentence(otherwise, sentenceContext.destinationOf);
	const subtitle =
		postSubmit !== undefined
			? postSubmit.explicit
				? undefined
				: "The usual destination for this kind of form"
			: otherwiseSubtitle(hasEveryTimeDestination(plan));
	const details =
		link === undefined
			? []
			: linkSentence(link, sentenceContext, "otherwise").details;

	return (
		<div
			data-form-link-otherwise
			className="rounded-xl border border-dashed border-white/[0.12] bg-nova-deep/20 px-4 py-3"
		>
			<div className="flex min-w-0 items-start gap-2.5">
				<Icon
					icon={tablerArrowRight}
					width="16"
					height="16"
					aria-hidden="true"
					className="mt-1 shrink-0 text-nova-text-muted"
				/>
				<div className="min-w-0 flex-1">
					<p className="break-words text-[14px] font-semibold text-nova-text">
						{lead}
					</p>
					{subtitle !== undefined && (
						<p className="mt-0.5 break-words text-[13px] leading-relaxed text-nova-text-muted">
							{subtitle}
						</p>
					)}
					{details.length > 0 && (
						<p className="mt-0.5 break-words text-[13px] leading-relaxed text-nova-text-muted">
							{details.join(" · ")}
						</p>
					)}
				</div>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-2 pl-[26px]">
				<div className="min-w-[14rem] flex-1">
					<OtherwiseChooser
						moduleUuid={moduleUuid}
						formUuid={formUuid}
						canEdit={canEdit}
						ariaLabel={
							postSubmit !== undefined
								? `Where the form goes after submit: ${lead}`
								: `Where the form goes otherwise: ${lead}`
						}
						otherTarget={{
							kind: "pick",
							onAdded: (uuid) =>
								navigate.openFormLinks(moduleUuid, formUuid, uuid),
						}}
						onOutcome={onOutcome}
						open={chooserOpen}
						onOpenChange={onChooserOpenChange}
					/>
				</div>
				{link !== undefined && (
					<Button
						type="button"
						variant="ghost"
						data-form-link-select={link.uuid}
						onClick={() =>
							navigate.openFormLinks(moduleUuid, formUuid, link.uuid)
						}
					>
						Open this link
						<Icon icon={tablerArrowRight} width="14" height="14" />
					</Button>
				)}
			</div>
		</div>
	);
}
