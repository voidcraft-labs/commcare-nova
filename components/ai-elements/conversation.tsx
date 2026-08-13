"use client";

import { Icon } from "@iconify/react/offline";
import tablerArrowDown from "@iconify-icons/tabler/arrow-down";
import type { ComponentProps, MutableRefObject } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/shadcn/button";
import { ChatScrollController } from "@/lib/ui/chatScroll";
import { cn } from "@/lib/utils";

/**
 * The conversation scroll region, driven by `ChatScrollController`
 * (`lib/ui/chatScroll.ts` holds the whole scroll model — pinned-to-bottom
 * tracking through content growth and container resizes, the question-card
 * anchor, escape on upward scroll, re-entry with leeway).
 *
 * Structure matters here: the `role="log"` ROOT never scrolls (it hosts the
 * floating scroll-to-latest button), `ConversationContent` renders the actual
 * scroller plus the content element inside it and registers both with the
 * controller through context.
 */

interface ConversationContextValue {
	readonly pinned: boolean;
	readonly controller: ChatScrollController;
}

const ConversationContext = createContext<ConversationContextValue | null>(
	null,
);

function useConversation(): ConversationContextValue {
	const ctx = useContext(ConversationContext);
	if (!ctx) {
		throw new Error("Conversation components must be used within Conversation");
	}
	return ctx;
}

export type ConversationProps = ComponentProps<"div"> & {
	/** Hands the scroll controller to the owner (the sidebar's send handlers
	 *  call `scrollToLatest` on it). */
	controllerRef?: MutableRefObject<ChatScrollController | null>;
};

export const Conversation = ({
	className,
	controllerRef,
	children,
	...props
}: ConversationProps) => {
	const [controller] = useState(() => new ChatScrollController());
	const [pinned, setPinned] = useState(true);

	useEffect(
		() => controller.subscribe(() => setPinned(controller.pinned)),
		[controller],
	);
	useEffect(() => {
		if (!controllerRef) return;
		controllerRef.current = controller;
		return () => {
			if (controllerRef.current === controller) controllerRef.current = null;
		};
	}, [controller, controllerRef]);
	// Unmount detaches observers; remounting (a thread switch) re-attaches
	// through ConversationContent's ref callbacks.
	useEffect(() => () => controller.detach(), [controller]);

	const contextValue = useMemo(
		() => ({ pinned, controller }),
		[pinned, controller],
	);

	return (
		<ConversationContext.Provider value={contextValue}>
			<div
				className={cn("relative flex-1 overflow-y-hidden", className)}
				role="log"
				{...props}
			>
				{children}
			</div>
		</ConversationContext.Provider>
	);
};

export type ConversationContentProps = ComponentProps<"div">;

export const ConversationContent = ({
	className,
	...props
}: ConversationContentProps) => {
	const { controller } = useConversation();
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);

	/* Ref callbacks run child-first, so the content element is registered by
	 * the time the scroller's callback attaches the controller — commit-time,
	 * before paint, which is what lands the initial bottom position with no
	 * top-positioned first frame. STABLE identities (useCallback) so React
	 * replays them only on mount/unmount: an inline callback would re-attach
	 * on every render, and attach resets the mode — the exact bug where an
	 * escaped view snapped back to the bottom the moment escaping re-rendered
	 * the scroll button. `attach` is idempotent for the same pair as the
	 * second line of defense. */
	const setContent = useCallback((el: HTMLDivElement | null) => {
		contentRef.current = el;
	}, []);
	const setScroller = useCallback(
		(el: HTMLDivElement | null) => {
			scrollerRef.current = el;
			if (el && contentRef.current) {
				controller.attach(el, contentRef.current);
			} else {
				controller.detach();
			}
		},
		[controller],
	);

	return (
		<div
			ref={setScroller}
			onScroll={() => controller.handleScroll()}
			className="h-full overflow-y-auto"
		>
			<div
				ref={setContent}
				className={cn("flex flex-col gap-8 p-4", className)}
				{...props}
			/>
		</div>
	);
};

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
	title?: string;
	description?: string;
	icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
	className,
	title = "No messages yet",
	description = "Start a conversation to see messages here",
	icon,
	children,
	...props
}: ConversationEmptyStateProps) => (
	<div
		className={cn(
			"flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
			className,
		)}
		{...props}
	>
		{children ?? (
			<>
				{icon && <div className="text-muted-foreground">{icon}</div>}
				<div className="space-y-1">
					<h3 className="font-medium text-sm">{title}</h3>
					{description && (
						<p className="text-muted-foreground text-sm">{description}</p>
					)}
				</div>
			</>
		)}
	</div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
	className,
	...props
}: ConversationScrollButtonProps) => {
	const { pinned, controller } = useConversation();

	return (
		!pinned && (
			<Button
				aria-label="Scroll to latest"
				className={cn(
					"absolute bottom-4 left-[50%] translate-x-[-50%]",
					className,
				)}
				onClick={() => controller.scrollToLatest()}
				size="icon"
				type="button"
				variant="outline"
				{...props}
			>
				<Icon icon={tablerArrowDown} className="size-4" />
			</Button>
		)
	);
};
