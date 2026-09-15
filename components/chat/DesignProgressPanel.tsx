"use client";
import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import tablerPointFilled from "@iconify-icons/tabler/point-filled";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import { Spinner } from "@/components/shadcn/spinner";
import { ChatMarkdown } from "@/lib/markdown";
import type { DesignProgressView } from "@/lib/session/designProgressStore";
import { DISCLOSURE_ROW_CLS } from "@/lib/styles";
export interface DesignProgressPanelProps {
	readonly view: DesignProgressView;
}
export function DesignProgressStatus({ view }: DesignProgressPanelProps) {
	return view.active && view.stageLabel ? <StageLine view={view} /> : null;
}
export function DesignProgressDetails({ view }: DesignProgressPanelProps) {
	if (!view.active || !view.plan) return null;
	return (
		<Collapsible className="rounded-lg border border-nova-border p-3">
			<CollapsibleTrigger
				render={<button type="button" className={DISCLOSURE_ROW_CLS} />}
			>
				<Icon
					icon={tablerChevronRight}
					aria-hidden="true"
					className="size-4 shrink-0 transition-transform group-data-[panel-open]:rotate-90"
				/>
				<span>App plan</span>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="chat-markdown pt-3">
					<ChatMarkdown>{view.plan.markdown}</ChatMarkdown>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
function StageLine({ view }: { readonly view: DesignProgressView }) {
	const halted = view.stage === "failed" || view.stage === "incomplete";
	return (
		<div
			role="status"
			aria-live="polite"
			aria-atomic="true"
			className="flex min-h-10 shrink-0 items-start gap-2 px-4 py-2"
		>
			{view.working ? (
				<Spinner
					aria-hidden="true"
					className="mt-0.5 size-4 shrink-0 text-nova-violet-bright"
				/>
			) : (
				<Icon
					icon={
						view.stage === "ready"
							? tablerCircleCheck
							: halted
								? tablerAlertTriangle
								: tablerPointFilled
					}
					aria-hidden="true"
					className={`mt-0.5 size-4 shrink-0 ${
						view.stage === "ready"
							? "text-nova-emerald"
							: halted
								? "text-nova-rose"
								: "text-nova-amber"
					}`}
				/>
			)}
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium leading-5 text-nova-text">
					{view.stageLabel}
				</p>
				{view.failure && (
					<p className="mt-0.5 text-xs leading-5 text-nova-text-secondary">
						{view.failure}
					</p>
				)}
			</div>
		</div>
	);
}
