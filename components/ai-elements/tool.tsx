"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerCircle from "@iconify-icons/tabler/circle";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import tablerCircleX from "@iconify-icons/tabler/circle-x";
import tablerClock from "@iconify-icons/tabler/clock";
import tablerTool from "@iconify-icons/tabler/tool";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import { Badge } from "@/components/shadcn/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import { ChatMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
	<Collapsible
		className={cn("group not-prose mb-4 w-full rounded-md border", className)}
		{...props}
	/>
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
	title?: string;
	className?: string;
} & (
	| { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
	| {
			type: DynamicToolUIPart["type"];
			state: DynamicToolUIPart["state"];
			toolName: string;
	  }
);

const statusLabels: Record<ToolPart["state"], string> = {
	"approval-requested": "Awaiting Approval",
	"approval-responded": "Responded",
	"input-available": "Running",
	"input-streaming": "Pending",
	"output-available": "Completed",
	"output-denied": "Denied",
	"output-error": "Error",
};

// Tool-state glyphs map to Nova's semantic hues (emerald = success,
// amber = warning / awaiting-attention, rose = error) — legitimate semantic
// color use because each state IS a status, not decoration. The acknowledged
// "responded" state borrows the violet accent; neutral pending states fall back
// to muted text.
const statusIcons: Record<ToolPart["state"], ReactNode> = {
	"approval-requested": (
		<Icon icon={tablerClock} className="size-4 text-nova-amber" />
	),
	"approval-responded": (
		<Icon icon={tablerCircleCheck} className="size-4 text-nova-violet-bright" />
	),
	"input-available": (
		<Icon icon={tablerClock} className="size-4 animate-pulse" />
	),
	"input-streaming": (
		<Icon icon={tablerCircle} className="size-4 text-nova-text-muted" />
	),
	"output-available": (
		<Icon icon={tablerCircleCheck} className="size-4 text-nova-emerald" />
	),
	"output-denied": (
		<Icon icon={tablerCircleX} className="size-4 text-nova-amber" />
	),
	"output-error": (
		<Icon icon={tablerCircleX} className="size-4 text-nova-rose" />
	),
};

export const getStatusBadge = (status: ToolPart["state"]) => (
	<Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
		{statusIcons[status]}
		{statusLabels[status]}
	</Badge>
);

export const ToolHeader = ({
	className,
	title,
	type,
	state,
	toolName,
	...props
}: ToolHeaderProps) => {
	const derivedName =
		type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

	return (
		<CollapsibleTrigger
			className={cn(
				"flex w-full items-center justify-between gap-4 p-3",
				className,
			)}
			{...props}
		>
			<div className="flex items-center gap-2">
				<Icon icon={tablerTool} className="size-4 text-muted-foreground" />
				<span className="font-medium text-sm">{title ?? derivedName}</span>
				{getStatusBadge(state)}
			</div>
			<Icon
				icon={tablerChevronDown}
				className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
			/>
		</CollapsibleTrigger>
	);
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
	<CollapsibleContent
		className={cn(
			"data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
			className,
		)}
		{...props}
	/>
);

export type ToolInputProps = ComponentProps<"div"> & {
	input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
	<div className={cn("space-y-2 overflow-hidden", className)} {...props}>
		<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
			Parameters
		</h4>
		{/* Tool inputs are structured arguments, not prose, so a monospace
		 * pretty-print in Nova chrome is enough — no syntax-highlighting engine. */}
		<pre className="overflow-x-auto rounded-lg border border-nova-border bg-nova-void p-3 text-xs font-mono text-nova-text-secondary">
			{JSON.stringify(input, null, 2)}
		</pre>
	</div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
	output: ToolPart["output"];
	errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
	className,
	output,
	errorText,
	...props
}: ToolOutputProps) => {
	if (!(output || errorText)) {
		return null;
	}

	// Output can arrive as already-rendered React, a structured object, or a
	// markdown string. Strings flow through Nova's chat markdown renderer (same
	// security allowlist as assistant messages); objects are pretty-printed JSON
	// in Nova chrome; anything already a ReactNode renders as-is.
	let renderedOutput = <div>{output as ReactNode}</div>;

	if (typeof output === "object" && !isValidElement(output)) {
		renderedOutput = (
			<pre className="overflow-x-auto rounded-lg border border-nova-border bg-nova-void p-3 text-xs font-mono text-nova-text-secondary">
				{JSON.stringify(output, null, 2)}
			</pre>
		);
	} else if (typeof output === "string") {
		renderedOutput = <ChatMarkdown>{output}</ChatMarkdown>;
	}

	return (
		<div className={cn("space-y-2", className)} {...props}>
			<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{errorText ? "Error" : "Result"}
			</h4>
			<div
				className={cn(
					"overflow-x-auto rounded-md text-xs [&_table]:w-full",
					errorText
						? "bg-destructive/10 text-destructive"
						: "bg-muted/50 text-foreground",
				)}
			>
				{errorText && <div>{errorText}</div>}
				{renderedOutput}
			</div>
		</div>
	);
};
