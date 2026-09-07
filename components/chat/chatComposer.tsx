"use client";
import { Icon } from "@iconify/react/offline";
import tablerLayoutSidebarRightCollapse from "@iconify-icons/tabler/layout-sidebar-right-collapse";
import type { ReactNode } from "react";
import { Button } from "@/components/shadcn/button";

interface ShortChatFallbackOptions {
	readonly centered: boolean;
	readonly docked: boolean;
	readonly veryShortViewport: boolean;
}

/** Keep the composer subtree alive while another short-height surface needs its
 * room. ChatInput and PromptInput own unsent text and staged attachments; hiding
 * this region must never reset either one. */
export function PersistentChatComposer({
	hidden,
	children,
}: {
	readonly hidden: boolean;
	readonly children: ReactNode;
}) {
	return (
		<div
			className={hidden ? "hidden" : "shrink-0"}
			aria-hidden={hidden || undefined}
			inert={hidden}
		>
			{children}
		</div>
	);
}

/** The centered welcome and inspector dock already have their own short-height
 * contracts. Only an expanded, standalone chat needs the deliberate fallback. */
export function shouldShowShortChatFallback({
	centered,
	docked,
	veryShortViewport,
}: ShortChatFallbackOptions): boolean {
	return !centered && !docked && veryShortViewport;
}

export function chatComposerIsDisabled({
	isLoading,
	isGenerating,
	initialBuildLocked,
	awaitingTypedInput,
	activeQuestionCount,
	composerBusy,
	readOnly,
	authorized,
}: {
	readonly isLoading: boolean;
	readonly isGenerating: boolean;
	readonly initialBuildLocked: boolean;
	readonly awaitingTypedInput: boolean;
	readonly activeQuestionCount: number;
	readonly composerBusy: boolean;
	readonly readOnly: boolean;
	readonly authorized: boolean;
}): boolean {
	return (
		isLoading ||
		((isGenerating || initialBuildLocked) &&
			activeQuestionCount === 0 &&
			!awaitingTypedInput) ||
		composerBusy ||
		readOnly ||
		!authorized
	);
}

/** A complete replacement for an unusable composer fragment. ChatContainer
 * stays mounted behind it, so an active stream continues uninterrupted. */
export function ShortChatFallback({
	onCollapse,
}: {
	readonly onCollapse: () => void;
}) {
	return (
		<section
			aria-labelledby="short-chat-fallback-title"
			data-short-chat-fallback
			className="flex min-h-0 flex-1 flex-col justify-center gap-2 p-2"
		>
			<div className="px-1">
				<h2
					id="short-chat-fallback-title"
					className="text-sm font-semibold text-nova-text"
				>
					Chat needs more room
				</h2>
				<p className="text-xs leading-5 text-nova-text-muted">
					Make the window taller to continue
				</p>
			</div>
			<Button
				type="button"
				variant="outline"
				onClick={onCollapse}
				className="w-full"
			>
				<Icon icon={tablerLayoutSidebarRightCollapse} />
				Collapse chat
			</Button>
		</section>
	);
}
