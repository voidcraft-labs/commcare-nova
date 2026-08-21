// components/builder/detail/formSettings/AfterSubmitSection.tsx
//
// The form-settings row for what happens after submit.
//
// It states the whole answer, not a label alone: how many links the form
// checks and where it goes when none of them match, read from the one
// after-submit model (`useAfterSubmitPlan`). The fallback is changeable
// right here through the shared `FallbackChooser`; the links themselves
// are a screen, for the same reason the case changes are: an ordered list
// with reorder and per-link editors does not fit a popover.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import { useState } from "react";
import { afterSubmitSummary } from "@/components/builder/form-links/afterSubmitCopy";
import {
	type ChooserOutcome,
	FallbackChooser,
} from "@/components/builder/form-links/FallbackChooser";
import { useLinkSentenceContext } from "@/components/builder/form-links/useLinkSentenceContext";
import { Button } from "@/components/shadcn/button";
import {
	useAfterSubmitPlan,
	useFormLinkCount,
} from "@/lib/doc/hooks/useFormLinkFacts";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import type { FormSettingsSectionProps } from "./types";

export function AfterSubmitSection({
	moduleUuid,
	formUuid,
	onNavigateAway,
}: FormSettingsSectionProps & {
	/** Dismiss the settings popover that hosts this row: opening the
	 *  screen is a navigation, and the popover's open state would
	 *  otherwise survive it. */
	readonly onNavigateAway?: () => void;
}) {
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const plan = useAfterSubmitPlan(formUuid);
	const count = useFormLinkCount(formUuid);
	const sentence = useLinkSentenceContext();
	const [announcement, setAnnouncement] = useState("");
	const [refusal, setRefusal] = useState<string | undefined>(undefined);

	if (plan === undefined) return null;

	const openLinks = () => {
		onNavigateAway?.();
		navigate.openFormLinks(moduleUuid, formUuid);
	};
	const onOutcome = (outcome: ChooserOutcome) => {
		if (outcome.kind === "committed") {
			setAnnouncement(outcome.announcement);
			setRefusal(undefined);
		} else {
			setRefusal(outcome.message);
		}
	};

	return (
		<section className="space-y-3">
			<div>
				<h3 className="text-[13px] font-medium leading-5 text-nova-text-secondary">
					After submit
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
					{afterSubmitSummary(plan, sentence.destinationOf)}
				</p>
			</div>

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

			<FallbackChooser
				formUuid={formUuid}
				canEdit={canEdit}
				ariaLabel={
					plan.conditional.length === 0
						? "After submit, go"
						: "When no link matches, go"
				}
				elseLink={{ kind: "hand-off", onHandOff: openLinks }}
				onOutcome={onOutcome}
			/>

			<Button
				type="button"
				variant="outline"
				onClick={openLinks}
				className="w-full justify-between border-white/[0.08] bg-transparent text-[14px] text-nova-text-secondary not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.05] not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.05]"
			>
				{!canEdit ? "View links" : count === 0 ? "Add links" : "Edit links"}
				<Icon icon={tablerArrowRight} width="15" height="15" />
			</Button>
		</section>
	);
}
