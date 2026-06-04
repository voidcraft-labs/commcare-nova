"use client";

import type { UIMessage } from "ai";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Message shells for the chat transcript.
 *
 * Only the structural shells survive Nova's re-skin. The vendored file also
 * shipped a markdown-rendering `MessageResponse` and a message-branching family
 * (branch selector / prev / next / toolbar / actions); Nova renders assistant
 * text through `ChatMarkdown` at the call site and has no branch-regeneration
 * UX, so those were removed rather than left as dead exports.
 */

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
	from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
	<div
		className={cn(
			"group flex w-full max-w-[95%] flex-col gap-2",
			from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
			className,
		)}
		{...props}
	/>
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
	children,
	className,
	...props
}: MessageContentProps) => (
	<div
		className={cn(
			"flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
			// User turns read as Nova chat bubbles: rounded-xl with the violet
			// hairline border and the surface fill, matching the rest of the chrome.
			// The packed bubble (attachments + text) keeps the tight base gap-2.
			"group-[.is-user]:ml-auto group-[.is-user]:rounded-xl group-[.is-user]:border group-[.is-user]:border-nova-border group-[.is-user]:bg-nova-surface group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-nova-text",
			// Assistant turns are unwrapped prose on the page background, interleaving
			// distinct blocks — prose, reasoning bursts, tool-run cards, question
			// cards. ONE uniform gap (here, not per-block margins, which compound when
			// e.g. a reasoning burst abuts a tool run) keeps them all in rhythm.
			"group-[.is-assistant]:gap-4 group-[.is-assistant]:text-nova-text",
			className,
		)}
		{...props}
	>
		{children}
	</div>
);
