/**
 * InspectorPanel — the right-rail properties chrome: a fixed identity header
 * (kicker + title + close) over a single scroll container that holds the active
 * inspector body.
 *
 * It is a PLAIN child of the always-mounted rail (`ChatSidebar` renders it in
 * place of the chat conversation while something is selected) — not a portal and
 * not a claim. Because the rail never unmounts and merely parks off-screen during
 * a preview flip, this scroll container is never torn down across the flip, so
 * its scroll position survives for free — the same guarantee chat and the app
 * tree already have. The rail supplies the body + header text through
 * `useActiveInspector` (see `activeInspector.tsx`); the body itself lives with
 * whatever surface owns the selection (a field, or the case-list controller).
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { type ReactNode, useId } from "react";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";

interface InspectorPanelProps {
	/** Friendly context above the title — e.g. "Search field", "Information". */
	readonly kicker: string;
	/** Entity title — the field label, column header, input label, etc. */
	readonly title: string;
	/** Clear the owning surface's selection. The close button, the dock's
	 *  expand-chat affordance, and Escape all land here. */
	readonly onClose: () => void;
	readonly children: ReactNode;
}

export function InspectorPanel({
	kicker,
	title,
	onClose,
	children,
}: InspectorPanelProps) {
	const titleId = useId();
	return (
		<aside aria-labelledby={titleId} className="flex-1 min-h-0 flex flex-col">
			<div
				className="flex h-16 shrink-0 items-center gap-3 border-b border-nova-border px-4"
				data-builder-secondary-header="inspector"
			>
				<SimpleTooltip
					content={
						<span className="grid gap-0.5">
							<span>{kicker}</span>
							<span className="font-semibold">{title}</span>
						</span>
					}
					side="bottom"
				>
					{/* The fixed-height rail header clamps imported names visually. The
					 * complete text remains in the accessibility tree, while the tooltip
					 * helps pointer users without inventing a dead button or tab stop. */}
					<div
						data-inspector-identity
						className="flex min-h-11 min-w-0 flex-1 flex-col justify-center text-left"
					>
						<div className="mb-1 truncate text-xs font-medium leading-4 text-nova-text-secondary">
							{kicker}
						</div>
						<h2
							id={titleId}
							className="truncate font-display text-[16px] font-semibold leading-5 text-nova-text"
						>
							{title}
						</h2>
					</div>
				</SimpleTooltip>
				<SimpleTooltip content="Close properties" side="left">
					<Button
						type="button"
						variant="outline"
						size="icon-lg"
						onClick={onClose}
						aria-label="Close properties"
						aria-keyshortcuts="Escape"
						className="size-11 shrink-0 border-nova-border bg-transparent text-nova-text-muted hover:border-nova-border-bright hover:text-nova-text dark:bg-transparent"
					>
						<Icon icon={tablerX} width="16" height="16" />
					</Button>
				</SimpleTooltip>
			</div>
			{/* `@container` so editor bodies can adapt to the rail's width — the
			 *  predicate/expression cards stack their operand grids in narrow
			 *  containers and go multi-column only with real room. */}
			<div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4 @container">
				{children}
			</div>
		</aside>
	);
}
