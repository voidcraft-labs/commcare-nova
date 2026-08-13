"use client";

import { Icon } from "@iconify/react/offline";
import tablerBulb from "@iconify-icons/tabler/bulb";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import type { ComponentProps, ReactNode } from "react";
import {
	createContext,
	memo,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import { ChatMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

import { Shimmer } from "./shimmer";

interface ReasoningContextValue {
	isStreaming: boolean;
	isOpen: boolean;
	setIsOpen: (open: boolean) => void;
	duration: number | undefined;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
	const context = useContext(ReasoningContext);
	if (!context) {
		throw new Error("Reasoning components must be used within Reasoning");
	}
	return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
	isStreaming?: boolean;
	open?: boolean;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	duration?: number;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

/**
 * Ambient open/close policy for a reasoning block. The rule that overrides
 * everything: once the USER has toggled the block, the automation never moves
 * it again. A block someone opened to read must not close itself under them
 * when the stream moves on, and one they closed must not spring back open.
 * Untouched blocks keep the ambient lifecycle: open while their reasoning
 * streams, then close shortly after it ends (once).
 */
export function reasoningAutoBehavior(args: {
	isStreaming: boolean;
	isOpen: boolean;
	userToggled: boolean;
	explicitlyClosed: boolean;
	hasAutoClosed: boolean;
	everStreamed: boolean;
}): "open" | "scheduleClose" | "none" {
	if (args.userToggled) return "none";
	if (args.isStreaming) {
		return !args.isOpen && !args.explicitlyClosed ? "open" : "none";
	}
	return args.everStreamed && args.isOpen && !args.hasAutoClosed
		? "scheduleClose"
		: "none";
}

/** Compact elapsed time for the reasoning trigger. Long model turns are easier
 * to scan as clock-like units than as a large count of seconds. */
export function formatThinkingDuration(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) {
		return remainingSeconds === 0
			? `${minutes}m`
			: `${minutes}m ${remainingSeconds}s`;
	}

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes === 0
		? `${hours}h`
		: `${hours}h ${remainingMinutes}m`;
}

export const Reasoning = memo(
	({
		className,
		isStreaming = false,
		open,
		defaultOpen,
		onOpenChange,
		duration: durationProp,
		children,
		...props
	}: ReasoningProps) => {
		const resolvedDefaultOpen = defaultOpen ?? isStreaming;
		// Track if defaultOpen was explicitly set to false (to prevent auto-open)
		const isExplicitlyClosed = defaultOpen === false;

		const [isOpen, setIsOpen] = useControllableState<boolean>({
			defaultProp: resolvedDefaultOpen,
			onChange: onOpenChange,
			prop: open,
		});
		const [duration, setDuration] = useControllableState<number | undefined>({
			defaultProp: undefined,
			prop: durationProp,
		});

		const hasEverStreamedRef = useRef(isStreaming);
		const [hasAutoClosed, setHasAutoClosed] = useState(false);
		const startTimeRef = useRef<number | null>(null);
		/** True once the user has toggled the block themselves. A ref, not
		 *  state: it only ever flips inside `handleOpenChange`, whose `setIsOpen`
		 *  re-runs the ambient effect in the same commit, so the fresh value is
		 *  always read where it matters. */
		const userToggledRef = useRef(false);

		// Track when streaming starts and compute duration
		useEffect(() => {
			if (isStreaming) {
				hasEverStreamedRef.current = true;
				if (startTimeRef.current === null) {
					startTimeRef.current = Date.now();
				}
			} else if (startTimeRef.current !== null) {
				setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
				startTimeRef.current = null;
			}
		}, [isStreaming, setDuration]);

		// The ambient lifecycle (auto-open while streaming, one delayed
		// auto-close after) runs only while the user has never touched the
		// block; `reasoningAutoBehavior` is the single policy for both moves.
		useEffect(() => {
			const behavior = reasoningAutoBehavior({
				isStreaming,
				isOpen,
				userToggled: userToggledRef.current,
				explicitlyClosed: isExplicitlyClosed,
				hasAutoClosed,
				everStreamed: hasEverStreamedRef.current,
			});
			if (behavior === "open") {
				setIsOpen(true);
				return;
			}
			if (behavior === "scheduleClose") {
				const timer = setTimeout(() => {
					setIsOpen(false);
					setHasAutoClosed(true);
				}, AUTO_CLOSE_DELAY);

				return () => clearTimeout(timer);
			}
		}, [isStreaming, isOpen, setIsOpen, hasAutoClosed, isExplicitlyClosed]);

		const handleOpenChange = useCallback(
			(newOpen: boolean) => {
				// Only the trigger routes through here (the ambient effect calls
				// setIsOpen directly), so this is the user's own hand: it retires
				// the ambient automation for this block permanently.
				userToggledRef.current = true;
				setIsOpen(newOpen);
			},
			[setIsOpen],
		);

		const contextValue = useMemo(
			() => ({ duration, isOpen, isStreaming, setIsOpen }),
			[duration, isOpen, isStreaming, setIsOpen],
		);

		return (
			<ReasoningContext.Provider value={contextValue}>
				{/* No self-margin (the vendored default's `mb-4` was bottom-only, which
				 *  left the trigger cramped above and out of rhythm with its neighbors).
				 *  The SA reply's MessageContent owns one uniform gap for every
				 *  block: reasoning, tool runs, prose, cards alike. */}
				<Collapsible
					className={cn("not-prose", className)}
					onOpenChange={handleOpenChange}
					open={isOpen}
					{...props}
				>
					{children}
				</Collapsible>
			</ReasoningContext.Provider>
		);
	},
);

export type ReasoningTriggerProps = ComponentProps<
	typeof CollapsibleTrigger
> & {
	getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
	if (isStreaming || duration === 0) {
		return <Shimmer duration={1}>Thinking&hellip;</Shimmer>;
	}
	if (duration === undefined) {
		return <p>Thought for a few seconds</p>;
	}
	return <p>Thought for {formatThinkingDuration(duration)}</p>;
};

export const ReasoningTrigger = memo(
	({
		className,
		children,
		getThinkingMessage = defaultGetThinkingMessage,
		...props
	}: ReasoningTriggerProps) => {
		const { isStreaming, isOpen, duration } = useReasoning();

		return (
			<CollapsibleTrigger
				className={cn(
					"flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
					className,
				)}
				{...props}
			>
				{children ?? (
					<>
						{/* Tabler has no brain glyph; the lightbulb reads as "thinking"
						 * and keeps the reasoning header in Nova's icon idiom. */}
						<Icon icon={tablerBulb} className="size-4" />
						{getThinkingMessage(isStreaming, duration)}
						<Icon
							icon={tablerChevronDown}
							className={cn(
								"size-4 transition-transform",
								isOpen ? "rotate-180" : "rotate-0",
							)}
						/>
					</>
				)}
			</CollapsibleTrigger>
		);
	},
);

export type ReasoningContentProps = ComponentProps<
	typeof CollapsibleContent
> & {
	children: string;
};

export const ReasoningContent = memo(
	({ className, children, ...props }: ReasoningContentProps) => (
		<CollapsibleContent
			className={cn(
				"chat-markdown mt-4 text-sm text-muted-foreground outline-none",
				className,
			)}
			{...props}
		>
			{/* Nova's single markdown renderer enforces the chat security allowlist
			 * (no raw links / images / HTML); reasoning text is model output and
			 * must pass through the same gate as the SA's chat replies. */}
			<ChatMarkdown>{children}</ChatMarkdown>
		</CollapsibleContent>
	),
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
