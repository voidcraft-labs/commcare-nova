"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import { Spinner } from "@/components/shadcn/spinner";
import { BuilderPhase } from "@/lib/session/builderTypes";
import { type GenerationError, GenerationStage } from "@/lib/session/types";
import { cn } from "@/lib/utils";

export type ChatActivityState =
	| "idle"
	| "progress"
	| "recovering"
	| "error"
	| "complete";

interface ChatActivityStatusProps {
	state: ChatActivityState;
	label: string;
}

export interface ChatActivity {
	state: ChatActivityState;
	label: string;
}

interface DeriveChatActivityOptions {
	agentError: GenerationError;
	agentStage: GenerationStage | null;
	attachmentReading: boolean;
	isGenerating: boolean;
	phase: BuilderPhase;
	postBuildEdit: boolean;
	streamOpen: boolean;
	submittedLocally: boolean;
}

/** Translate transport and build lifecycle facts into one calm status line. */
export function deriveChatActivity({
	agentError,
	agentStage,
	attachmentReading,
	isGenerating,
	phase,
	postBuildEdit,
	streamOpen,
	submittedLocally,
}: DeriveChatActivityOptions): ChatActivity {
	if (agentError) {
		return agentError.severity === "recovering"
			? { state: "recovering", label: "Trying again" }
			: {
					state: "error",
					label: postBuildEdit
						? "Couldn't update your app"
						: "Couldn't build your app",
				};
	}

	if (isGenerating) {
		switch (agentStage) {
			case GenerationStage.Foundation:
				return { state: "progress", label: "Setting up your app" };
			case GenerationStage.Fix:
				return { state: "progress", label: "Finishing your app" };
			case GenerationStage.Build:
			case null:
				return { state: "progress", label: "Building your app" };
		}
	}

	// Completion is stamped while the final assistant summary can still be
	// streaming, so it takes priority over the generic working state below.
	if (phase === BuilderPhase.Completed) {
		return {
			state: "complete",
			label: postBuildEdit ? "Your app is updated" : "Your app is ready",
		};
	}

	if (attachmentReading) {
		return { state: "progress", label: "Reading your documents" };
	}

	if (streamOpen) {
		if (submittedLocally) {
			return { state: "progress", label: "Sending message" };
		}
		return {
			state: "progress",
			label: postBuildEdit ? "Updating your app" : "Planning your app",
		};
	}

	return { state: "idle", label: "" };
}

/**
 * Compact builder activity status. Resting chat needs no status chrome; while
 * Nova is working, one plain-language row communicates progress without taking
 * space away from the conversation or composer.
 */
export function ChatActivityStatus({ state, label }: ChatActivityStatusProps) {
	if (state === "idle" || !label) return null;

	const icon = (() => {
		switch (state) {
			case "complete":
				return (
					<Icon
						icon={tablerCircleCheck}
						aria-hidden="true"
						className="size-4 shrink-0 text-nova-emerald"
					/>
				);
			case "error":
				return (
					<Icon
						icon={tablerAlertCircle}
						aria-hidden="true"
						className="size-4 shrink-0 text-nova-rose"
					/>
				);
			case "recovering":
				return (
					<Spinner
						aria-hidden="true"
						className="size-4 shrink-0 text-nova-amber"
					/>
				);
			case "progress":
				return (
					<Spinner
						aria-hidden="true"
						className="size-4 shrink-0 text-nova-violet-bright"
					/>
				);
		}
	})();

	return (
		<div
			role={state === "error" ? "alert" : "status"}
			aria-live={state === "error" ? "assertive" : "polite"}
			aria-atomic="true"
			data-chat-activity-status={state}
			className="flex min-h-10 shrink-0 items-center gap-2 px-4 py-2"
		>
			{icon}
			<span
				className={cn(
					"min-w-0 text-sm font-medium leading-5",
					state === "error"
						? "text-nova-rose"
						: state === "recovering"
							? "text-nova-amber"
							: state === "complete"
								? "text-nova-emerald"
								: "text-nova-text-secondary",
				)}
			>
				{label}
			</span>
		</div>
	);
}
