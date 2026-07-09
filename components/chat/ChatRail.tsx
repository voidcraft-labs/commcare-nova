/**
 * ChatRail — the chat sidebar's collapsed state: a slim icon rail on
 * the right edge, the mirror of the structure side's AppTreeRail. A
 * collapsed panel stays architectural (a rail in the layout flow),
 * never a floating button that something can cover or click-shield.
 *
 * The rail only ever represents "chat closed, nothing selected" —
 * selecting something to inspect bypasses it entirely, because the
 * inspector claims the full-width rail the moment a selection exists.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerLayoutSidebarRightExpand from "@iconify-icons/tabler/layout-sidebar-right-expand";
import tablerMessageChatbot from "@iconify-icons/tabler/message-chatbot";
import { SimpleTooltip } from "@/components/shadcn/tooltip";

export function ChatRail({ onExpand }: { onExpand: () => void }) {
	return (
		<aside className="w-14 shrink-0 h-full border-l border-nova-border-bright bg-nova-deep flex flex-col items-center gap-1 py-2">
			<SimpleTooltip content="Expand chat" side="left">
				<button
					type="button"
					onClick={onExpand}
					aria-label="Expand chat sidebar"
					className="size-11 grid place-items-center rounded-lg text-nova-text-muted hover:text-nova-text hover:bg-white/[0.05] transition-colors cursor-pointer"
				>
					<Icon icon={tablerLayoutSidebarRightExpand} width="18" height="18" />
				</button>
			</SimpleTooltip>
			<div className="w-7 h-px bg-nova-border my-1" aria-hidden="true" />
			<SimpleTooltip content="Chat with Nova" side="left">
				<button
					type="button"
					onClick={onExpand}
					aria-label="Open chat"
					className="size-11 grid place-items-center rounded-lg text-nova-text-muted hover:text-nova-text-secondary hover:bg-white/[0.05] transition-colors cursor-pointer"
				>
					<Icon icon={tablerMessageChatbot} width="17" height="17" />
				</button>
			</SimpleTooltip>
		</aside>
	);
}
