/**
 * Shared chrome for the three collections in Users & personas: one heading
 * with its explanation, a list, and an add action. Keeping the frame in one
 * place is what lets the three read as one system rather than three
 * unrelated panels.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerPlus from "@iconify-icons/tabler/plus";
import type { ReactNode, Ref } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";

export function Subsection({
	id,
	title,
	description,
	addLabel,
	onAdd,
	canEdit,
	addButtonRef,
	children,
}: {
	id: string;
	title: string;
	description: string;
	addLabel: string;
	onAdd: () => void;
	canEdit: boolean;
	addButtonRef?: Ref<HTMLButtonElement>;
	children: ReactNode;
}) {
	return (
		<section aria-labelledby={`${id}-heading`}>
			<h3 id={`${id}-heading`} className="text-sm font-semibold text-nova-text">
				{title}
			</h3>
			<p className="mt-1.5 max-w-prose text-[13px] leading-relaxed text-nova-text-secondary">
				{description}
			</p>
			<div className="mt-4 flex flex-col gap-2">{children}</div>
			{canEdit && (
				<Button
					ref={addButtonRef}
					type="button"
					variant="ghost"
					size="lg"
					onClick={onAdd}
					className="mt-3 h-11 gap-2 px-2.5 text-[13px] font-medium text-nova-violet-bright hover:bg-nova-violet/[0.12] hover:text-nova-violet-bright"
				>
					<Icon icon={tablerPlus} width="16" height="16" aria-hidden="true" />
					{addLabel}
				</Button>
			)}
		</section>
	);
}

/** The list's empty state — an invitation, in the section's own words. */
export function SubsectionEmpty({ children }: { children: ReactNode }) {
	return (
		<p className="rounded-lg border border-dashed border-nova-border px-3 py-4 text-[13px] leading-relaxed text-nova-text-muted">
			{children}
		</p>
	);
}

/**
 * One collection entry: a full-width disclosure whose header names it and
 * whose panel holds its editor. A row that cannot be edited (view-only
 * access) still opens — reading the setup is not an edit.
 */
export function EntryRow({
	summary,
	detail,
	children,
	open,
	onOpenChange,
}: {
	/** The entry's name — the disclosure's accessible label. */
	summary: ReactNode;
	/** A short right-aligned fact about the entry. */
	detail?: ReactNode;
	children: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Collapsible
			open={open}
			onOpenChange={onOpenChange}
			className="rounded-lg border border-nova-border bg-nova-deep"
		>
			<CollapsibleTrigger
				className="group flex min-h-12 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-nova-violet-bright"
				render={<button type="button" />}
			>
				<Icon
					icon={tablerChevronRight}
					width="15"
					height="15"
					aria-hidden="true"
					className="shrink-0 text-nova-text-muted transition-transform duration-150 group-data-[panel-open]:rotate-90 motion-reduce:transition-none"
				/>
				<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
					{summary}
				</span>
				{detail !== undefined && (
					<span className="shrink-0 text-[12px] text-nova-text-muted">
						{detail}
					</span>
				)}
			</CollapsibleTrigger>
			<CollapsibleContent
				keepMounted
				className="border-t border-nova-border px-3 py-3"
			>
				{children}
			</CollapsibleContent>
		</Collapsible>
	);
}
