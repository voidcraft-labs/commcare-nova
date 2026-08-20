// components/builder/form-links/OtherwiseRow.tsx
//
// The list's terminal row: what happens when nothing above matched.
//
// Always last and never draggable, because its position IS its meaning.
// It shows the otherwise link when one exists (with a way into that
// link's detail, where its carried values live) or the built-in
// destination, and carries the one chooser (`FallbackChooser`) that
// changes either.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import { Button } from "@/components/shadcn/button";
import type { AfterSubmitPlan } from "@/lib/doc/formLinkMutations";
import type { Uuid } from "@/lib/doc/types";
import { useNavigate } from "@/lib/routing/hooks";
import { destinationPhrase } from "./afterSubmitCopy";
import { type ChooserOutcome, FallbackChooser } from "./FallbackChooser";
import { type LinkSentenceContext, linkSentence } from "./linkSentence";

export function OtherwiseRow({
	moduleUuid,
	formUuid,
	plan,
	sentenceContext,
	canEdit,
	onOutcome,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly plan: AfterSubmitPlan;
	readonly sentenceContext: LinkSentenceContext;
	readonly canEdit: boolean;
	readonly onOutcome: (outcome: ChooserOutcome) => void;
}) {
	const navigate = useNavigate();
	const fallback = plan.fallback;
	const sentence =
		fallback.kind === "else-link"
			? linkSentence(fallback.link, sentenceContext)
			: {
					lead: `Go ${destinationPhrase(fallback.destination)}`,
					details: fallback.explicit
						? []
						: ["The usual destination for this kind of form"],
				};
	const hasConditional = plan.conditional.length > 0;

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
					<p className="text-[11px] font-semibold uppercase tracking-wider text-nova-text-muted">
						{hasConditional ? "Otherwise" : "After submit"}
					</p>
					<p className="mt-0.5 break-words text-[14px] font-semibold text-nova-text">
						{sentence.lead}
					</p>
					{sentence.details.length > 0 && (
						<p className="mt-0.5 break-words text-[13px] leading-relaxed text-nova-text-muted">
							{sentence.details.join(" · ")}
						</p>
					)}
				</div>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-2 pl-[26px]">
				<div className="min-w-[14rem] flex-1">
					<FallbackChooser
						formUuid={formUuid}
						canEdit={canEdit}
						ariaLabel={`Where the form goes when nothing above matches: ${sentence.lead}`}
						elseLink={{
							kind: "pick",
							onAdded: (uuid) =>
								navigate.openFormLinks(moduleUuid, formUuid, uuid),
						}}
						onOutcome={onOutcome}
					/>
				</div>
				{fallback.kind === "else-link" && (
					<Button
						type="button"
						variant="ghost"
						data-form-link-select={fallback.link.uuid}
						onClick={() =>
							navigate.openFormLinks(moduleUuid, formUuid, fallback.link.uuid)
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
