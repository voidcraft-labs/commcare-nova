// components/builder/detail/formSettings/CaseChangesSection.tsx
//
// The form-settings row that leads to a form's case changes.
//
// Every change a submission makes to cases is one of the form's case
// changes, the form's own case first, so the count is all of them.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowRight from "@iconify-icons/tabler/arrow-right";
import { Button } from "@/components/shadcn/button";
import { useCaseOperationCount } from "@/lib/doc/hooks/useCaseOperationFacts";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import type { FormSettingsSectionProps } from "./types";

export function CaseChangesSection({
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
	const count = useCaseOperationCount(formUuid);

	return (
		<section className="space-y-3">
			<div>
				<h3 className="text-[13px] font-medium leading-5 text-nova-text-secondary">
					Case changes
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
					{count === 0
						? "Submitting this form doesn't change any cases."
						: count === 1
							? "Submitting this form makes 1 case change."
							: `Submitting this form makes ${count} case changes.`}
				</p>
			</div>
			<Button
				type="button"
				variant="outline"
				onClick={() => {
					onNavigateAway?.();
					navigate.openFormOperations(moduleUuid, formUuid);
				}}
				className="w-full justify-between border-white/[0.08] bg-transparent text-[14px] text-nova-text-secondary not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.05] not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.05]"
			>
				{canEdit ? "Edit case changes" : "View case changes"}
				<Icon icon={tablerArrowRight} width="15" height="15" />
			</Button>
		</section>
	);
}
