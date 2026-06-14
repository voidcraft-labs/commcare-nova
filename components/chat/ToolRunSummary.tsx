"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowNarrowRight from "@iconify-icons/tabler/arrow-narrow-right";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import tablerCircleX from "@iconify-icons/tabler/circle-x";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import type { ToolUIPart } from "ai";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import {
	completionErrors,
	runStatus,
	type ToolStatus,
	toolAction,
	toolDetail,
	toolLocation,
	toolStatus,
} from "@/lib/chat/toolSummary";
import { cn } from "@/lib/utils";

/** Status glyph + tint, shared by the run header and each per-call row.
 *  Emerald = done, rose (Nova's destructive) = failed (incl. a failed
 *  completion outcome), spinner = in-flight. */
const STATUS: Record<
	ToolStatus,
	{ icon: typeof tablerCircleCheck; tint: string }
> = {
	pending: { icon: tablerLoader2, tint: "animate-spin text-nova-text-muted" },
	done: { icon: tablerCircleCheck, tint: "text-nova-emerald" },
	failed: { icon: tablerCircleX, tint: "text-nova-rose" },
};

/**
 * One tool call rendered as: a status glyph, the friendly action
 * (`Added column "Age"`), a `→ Clients` container breadcrumb, and any
 * secondary detail (a completion outcome, an error, or — for a call with no
 * structured summary — its raw prose). The breadcrumb leads the location rather
 * than letting it trail the sentence, which was the whole point of the
 * structured summary. `headline` sizes the row up for the single-call case
 * where it stands alone; the default is the compact size used inside the
 * expanded "N changes" list.
 */
function ToolCallRow({
	part,
	headline = false,
}: {
	part: ToolUIPart;
	headline?: boolean;
}) {
	const status = toolStatus(part);
	const location = toolLocation(part);
	const errors = completionErrors(part);
	const detail = toolDetail(part);

	return (
		<div
			className={cn("flex items-start gap-2", headline ? "text-sm" : "text-xs")}
		>
			<Icon
				className={cn(
					"mt-0.5 shrink-0",
					headline ? "size-4" : "size-3.5",
					STATUS[status].tint,
				)}
				icon={STATUS[status].icon}
			/>
			<div className="min-w-0 flex-1">
				<div className="truncate text-nova-text">{toolAction(part)}</div>
				{location && (
					<div className="mt-0.5 flex items-center gap-1 text-nova-text-muted">
						<Icon className="size-3 shrink-0" icon={tablerArrowNarrowRight} />
						<span className="truncate">{location}</span>
					</div>
				)}
				{/* A refused completion can carry many findings — tuck them behind a
				 *  collapsed "N issues" disclosure (bulleted) instead of dumping the
				 *  whole wall inline. Any other call's detail renders plainly. */}
				{errors ? (
					<ValidateErrors errors={errors} />
				) : (
					detail && (
						<div
							className={cn(
								"mt-0.5 whitespace-pre-wrap break-words text-nova-text-muted",
								status === "failed" && "text-nova-rose/90",
							)}
						>
							{detail}
						</div>
					)
				)}
			</div>
		</div>
	);
}

/** The completion finding list as a collapsed-by-default disclosure with bulleted
 *  items, so a failing first pass doesn't flood the transcript with a wall of
 *  rose text. No keyframe-animation classes on the panel (Base UI's Collapsible
 *  warns + breaks when CSS animation and transition are both present). */
function ValidateErrors({ errors }: { errors: string[] }) {
	return (
		<Collapsible className="mt-1">
			<CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-left text-nova-rose/90 text-xs">
				<Icon
					className="size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-180"
					icon={tablerChevronDown}
				/>
				{errors.length} {errors.length === 1 ? "issue" : "issues"} found
			</CollapsibleTrigger>
			<CollapsibleContent>
				<ul className="mt-1 list-disc space-y-1 pl-4 text-nova-rose/90 text-xs marker:text-nova-rose/50">
					{errors.map((error, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static error list for one render; messages can legitimately repeat across forms
						<li className="break-words" key={i}>
							{error}
						</li>
					))}
				</ul>
			</CollapsibleContent>
		</Collapsible>
	);
}

/**
 * One consecutive run of the SA's edit-tool calls.
 *
 * A run of MANY calls (a large build's dozens of addFields) collapses to a
 * single "N changes" card so it doesn't flood the transcript; the header
 * carries the rolled-up status and expanding reveals each call's friendly row.
 * A run of ONE renders that row plainly — no "N changes" header to read as a
 * redundant echo of the single line beneath it, and nothing to disclose since
 * the row already shows everything. Defaults closed for the many-call case: the
 * live canvas already reflects the changes and the signal grid shows activity,
 * so this is an on-demand audit trail, not the primary feedback.
 */
export function ToolRunSummary({ parts }: { parts: ToolUIPart[] }) {
	if (parts.length === 1) {
		return (
			<div className="w-full rounded-lg border border-nova-border bg-nova-surface/40 p-2.5">
				<ToolCallRow headline part={parts[0]} />
			</div>
		);
	}

	const status = runStatus(parts);
	return (
		<Collapsible className="w-full rounded-lg border border-nova-border bg-nova-surface/40">
			<CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 p-2.5 text-left">
				<Icon
					className={cn("size-4 shrink-0", STATUS[status].tint)}
					icon={STATUS[status].icon}
				/>
				<span className="min-w-0 flex-1 truncate text-nova-text text-sm">
					{parts.length} changes
				</span>
				<Icon
					className="size-4 shrink-0 text-nova-text-muted transition-transform group-data-[panel-open]:rotate-180"
					icon={tablerChevronDown}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="space-y-2 px-2.5 pb-2.5">
				{parts.map((part) => (
					<ToolCallRow key={part.toolCallId} part={part} />
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}
