"use client";

import { Icon } from "@iconify/react/offline";
import tablerBookmark from "@iconify-icons/tabler/bookmark";
import tablerCodeDots from "@iconify-icons/tabler/code-dots";
import tablerSearch from "@iconify-icons/tabler/search";
import { useDeferredValue, useId, useMemo, useState } from "react";
import { Badge } from "@/components/shadcn/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import { Input } from "@/components/shadcn/input";
import type {
	WeighedItem,
	WeighedSegment,
	WeighedTool,
} from "@/lib/agent/anatomy/types";
import { ChatMarkdown } from "@/lib/markdown";
import { selectableSegmentCls } from "@/lib/styles";
import { cn } from "@/lib/utils";
import {
	formatExactTokens,
	formatTokens,
	formatWeight,
	KIND_LABELS,
	KIND_TEXT,
	NEED_LABELS,
	ORIGIN_LABELS,
} from "../_lib/format";

/** Segment titles are sentences; let them wrap inside a narrow pane instead
 * of overflowing it. */
const SEGMENT_WRAP =
	"h-auto max-w-full whitespace-normal py-2 text-left justify-start";

/** The selected item in full. */
export function ReadingPane({ item }: { item: WeighedItem }) {
	return (
		<article className="min-w-0 space-y-5">
			<header className="space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<span className={cn("text-xs", KIND_TEXT[item.kind])}>
						{KIND_LABELS[item.kind]}
					</span>
					<span className="text-nova-text-muted text-xs">
						{item.kind === "missing"
							? NEED_LABELS[item.needs]
							: ORIGIN_LABELS[item.origin]}
					</span>
					{item.kind === "message" && item.verified === false && (
						<Badge variant="rose">stored bytes changed</Badge>
					)}
					{item.kind !== "missing" && (
						<span className="ml-auto font-mono text-nova-text-secondary text-xs">
							{formatWeight(item.weight)}
						</span>
					)}
				</div>
				<h2 className="font-display text-[22px] font-semibold leading-tight tracking-[-0.015em]">
					{item.label}
				</h2>
				{item.note && (
					<p className="max-w-[80ch] text-nova-text-secondary text-sm leading-relaxed">
						{item.note}
					</p>
				)}
				<p className="font-mono text-nova-text-muted text-xs">
					{item.source.file} · {item.source.symbol}
				</p>
			</header>
			<ItemBody item={item} />
		</article>
	);
}

function ItemBody({ item }: { item: WeighedItem }) {
	switch (item.kind) {
		case "system":
			return <SystemView item={item} />;
		case "tools":
			return <ToolCatalog item={item} />;
		case "output-schema":
			return <JsonBlock value={item.jsonSchema} />;
		case "message":
			return (
				<div className="space-y-4">
					{item.verified === false && (
						<p className="max-w-[80ch] rounded-xl border border-nova-rose/20 bg-nova-rose/10 p-4 text-sm leading-relaxed">
							This row no longer matches the digest written beside it when it
							was appended, so the text below may not be what the model
							received. The production reader refuses such a row.
						</p>
					)}
					<MessageView item={item} />
				</div>
			);
		case "compaction":
			return (
				<p className="max-w-[80ch] text-nova-text-secondary text-sm leading-relaxed">
					The provider's opaque encrypted checkpoint is not readable here or
					anywhere in Nova. It replays only inside the same model and context
					contract; a mismatch strips it and the ordinary history is projected
					instead.
				</p>
			);
		case "missing":
			return (
				<div className="max-w-[80ch] space-y-3 rounded-xl border border-nova-border border-dashed p-4">
					<p className="text-sm leading-relaxed">{item.explanation}</p>
					<p className="text-nova-text-muted text-xs">
						{item.needs === "app"
							? "Needs a local app, picked above."
							: item.needs === "design-session"
								? "Needs a local design session, picked above."
								: "Only a live call has it. Nothing stores this piece."}
					</p>
				</div>
			);
	}
}

// ── System prompt ────────────────────────────────────────────────────────

type TextMode = "rendered" | "raw";

function SystemView({ item }: { item: WeighedItem & { kind: "system" } }) {
	const [mode, setMode] = useState<TextMode>("rendered");
	const [segmentId, setSegmentId] = useState<string | null>(null);
	const outline = item.outline;
	const segments = item.segments;
	const baseId = useId();
	const shown: {
		title: string;
		text: string;
		weight: WeighedSegment["weight"];
	} | null =
		segmentId === null
			? null
			: (segments.find((segment) => segment.id === segmentId) ?? null);
	return (
		<div className="space-y-5">
			{segments.length > 1 && (
				<section aria-label="Segments" className="space-y-2">
					<p className="text-nova-text-muted text-xs">
						Segments, in the order they are joined
					</p>
					<div className="flex flex-wrap gap-1">
						<button
							type="button"
							onClick={() => setSegmentId(null)}
							aria-pressed={segmentId === null}
							className={cn(
								selectableSegmentCls(segmentId === null),
								SEGMENT_WRAP,
							)}
						>
							Whole prompt
							<span className="font-mono text-nova-text-muted text-xs">
								{formatTokens(item.weight.tokens)}
							</span>
						</button>
						{segments.map((segment) => (
							<button
								key={segment.id}
								type="button"
								onClick={() => setSegmentId(segment.id)}
								aria-pressed={segmentId === segment.id}
								className={cn(
									selectableSegmentCls(segmentId === segment.id),
									SEGMENT_WRAP,
								)}
							>
								{segment.title}
								<span className="font-mono text-nova-text-muted text-xs">
									{formatTokens(segment.weight.tokens)}
								</span>
							</button>
						))}
					</div>
					{shown === null && (
						<ul className="text-nova-text-muted text-xs">
							{segments
								.filter(
									(segment) =>
										segment.generated && segment.generated.length > 0,
								)
								.map((segment) => (
									<li key={segment.id}>
										{segment.title} interpolates{" "}
										{segment.generated?.join(" and ")}, generated from the
										domain schemas.
									</li>
								))}
						</ul>
					)}
				</section>
			)}
			{shown === null && outline.length > 1 && (
				<nav aria-label="Outline" className="space-y-1">
					<p className="text-nova-text-muted text-xs">
						Outline, {outline.length} sections with their estimated tokens
					</p>
					<ol className="space-y-px xl:columns-2 xl:gap-8">
						{outline.map((section) => (
							<li key={section.id} className="break-inside-avoid">
								<a
									href={`#${baseId}-${section.id}`}
									className="nova-focusable flex min-h-8 items-baseline gap-3 rounded-lg px-2 py-1 text-sm hover:bg-white/[0.06]"
									style={{
										paddingLeft: `${8 + Math.max(section.level - 1, 0) * 14}px`,
									}}
								>
									<span className="min-w-0 flex-1 truncate">
										{section.title}
									</span>
									<span className="shrink-0 font-mono text-nova-text-muted text-xs">
										{formatTokens(section.weight.tokens)}
									</span>
								</a>
							</li>
						))}
					</ol>
				</nav>
			)}
			<div className="flex items-center gap-1">
				<button
					type="button"
					onClick={() => setMode("rendered")}
					aria-pressed={mode === "rendered"}
					className={selectableSegmentCls(mode === "rendered")}
				>
					Rendered
				</button>
				<button
					type="button"
					onClick={() => setMode("raw")}
					aria-pressed={mode === "raw"}
					className={selectableSegmentCls(mode === "raw")}
				>
					<Icon icon={tablerCodeDots} aria-hidden />
					Raw text
				</button>
				{shown !== null && (
					<span className="ml-auto font-mono text-nova-text-secondary text-xs">
						{formatWeight(shown.weight)}
					</span>
				)}
			</div>
			<PromptText
				text={shown === null ? item.text : shown.text}
				mode={mode}
				anchorPrefix={shown === null ? baseId : undefined}
				sections={shown === null ? outline : []}
			/>
		</div>
	);
}

/**
 * The prompt text, rendered as markdown or raw. Rendered mode paints one
 * block per outline section so the outline's links land on their headings.
 */
function PromptText({
	text,
	mode,
	anchorPrefix,
	sections,
}: {
	text: string;
	mode: TextMode;
	anchorPrefix?: string;
	sections: readonly { id: string; text: string }[];
}) {
	if (mode === "raw") {
		return (
			<pre className="max-w-full overflow-x-auto whitespace-pre-wrap wrap-anywhere rounded-xl border border-nova-border bg-nova-deep p-4 font-mono text-[13px] text-nova-text-secondary leading-relaxed">
				{text}
			</pre>
		);
	}
	const blocks = sections.length > 0 ? sections : [{ id: "all", text }];
	return (
		<div className="chat-markdown max-w-[80ch] text-[15px] leading-relaxed">
			{blocks.map((section) => (
				<div
					key={section.id}
					id={anchorPrefix ? `${anchorPrefix}-${section.id}` : undefined}
					className="scroll-mt-4"
				>
					<ChatMarkdown>{section.text}</ChatMarkdown>
				</div>
			))}
		</div>
	);
}

// ── Tool definitions ─────────────────────────────────────────────────────

type ToolOrder = "weight" | "wire";

function ToolCatalog({ item }: { item: WeighedItem & { kind: "tools" } }) {
	const [query, setQuery] = useState("");
	const [order, setOrder] = useState<ToolOrder>("weight");
	const deferred = useDeferredValue(query.trim().toLowerCase());
	const tools = item.tools;
	const digestCovers = item.digestCovers ? new Set(item.digestCovers) : null;
	const visible = useMemo(() => {
		const matches =
			deferred.length === 0
				? tools
				: tools.filter(
						(tool) =>
							tool.name.toLowerCase().includes(deferred) ||
							tool.description.toLowerCase().includes(deferred),
					);
		return order === "weight"
			? [...matches].sort(
					(a, b) => (b.weight.tokens ?? 0) - (a.weight.tokens ?? 0),
				)
			: matches;
	}, [tools, deferred, order]);
	const strictCounts = tools.reduce(
		(counts, tool) => {
			if (tool.strict === true) counts.strict += 1;
			else if (tool.strict === false) counts.loose += 1;
			else counts.unset += 1;
			return counts;
		},
		{ strict: 0, loose: 0, unset: 0 },
	);
	return (
		<div className="space-y-4">
			{tools.some((tool) => tool.deferred) && (
				<p className="text-nova-text-secondary text-sm">
					{formatExactTokens(item.weight.tokens)} estimated tokens available
					initially; {formatExactTokens(item.catalogWeight.tokens)} in the full
					catalog. Deferred definitions enter context when loaded. Earlier tool
					searches in a resumed thread may have loaded more.
				</p>
			)}
			<div className="flex flex-wrap items-center gap-2 text-nova-text-secondary text-xs">
				<span>
					{tools.length} {tools.length === 1 ? "tool" : "tools"}
				</span>
				{strictCounts.strict > 0 && (
					<Badge variant="violet">{strictCounts.strict} strict</Badge>
				)}
				{strictCounts.loose > 0 && (
					<Badge>{strictCounts.loose} strict: false</Badge>
				)}
				{strictCounts.unset > 0 && (
					<Badge>{strictCounts.unset} strictness unset</Badge>
				)}
				{digestCovers && (
					<Badge>{digestCovers.size} in the persisted digest</Badge>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-0 flex-1 basis-56">
					<Icon
						icon={tablerSearch}
						className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-nova-text-muted"
						aria-hidden
					/>
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Find a tool by name or description"
						aria-label="Find a tool"
						autoComplete="off"
						data-1p-ignore
						className="pl-10"
					/>
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => setOrder("weight")}
						aria-pressed={order === "weight"}
						className={selectableSegmentCls(order === "weight")}
					>
						Heaviest first
					</button>
					<button
						type="button"
						onClick={() => setOrder("wire")}
						aria-pressed={order === "wire"}
						className={selectableSegmentCls(order === "wire")}
					>
						Wire order
					</button>
				</div>
			</div>
			{visible.length === 0 ? (
				<p className="text-nova-text-secondary text-sm">
					No tool matches that. Try part of a name, like "case" or "media".
				</p>
			) : (
				<ol className="divide-y divide-nova-border">
					{visible.map((tool) => (
						<ToolRow
							key={tool.name}
							tool={tool}
							inDigest={digestCovers?.has(tool.name)}
						/>
					))}
				</ol>
			)}
		</div>
	);
}

function ToolRow({
	tool,
	inDigest,
}: {
	tool: WeighedTool;
	inDigest?: boolean;
}) {
	const [open, setOpen] = useState(false);
	return (
		<li>
			<Collapsible open={open} onOpenChange={setOpen}>
				<CollapsibleTrigger className="nova-focusable flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.06]">
					<span className="min-w-0 flex-1">
						<span className="flex flex-wrap items-center gap-2">
							<span className="font-mono text-sm">{tool.name}</span>
							{tool.deferred && <Badge>loaded on demand</Badge>}
							{tool.providerTool && <Badge>provider tool</Badge>}
							{tool.strict === true && <Badge variant="violet">strict</Badge>}
							{tool.allowed === true && (
								<Badge variant="emerald">allowed this slice</Badge>
							)}
							{tool.allowed === false && <Badge>not allowed this slice</Badge>}
							{inDigest === false && <Badge>outside the digest</Badge>}
						</span>
						{!open && (
							<span className="mt-0.5 line-clamp-1 block text-nova-text-secondary text-xs">
								{tool.description}
							</span>
						)}
					</span>
					<span className="shrink-0 font-mono text-nova-text-secondary text-xs">
						{formatTokens(tool.weight.tokens)}
					</span>
				</CollapsibleTrigger>
				<CollapsibleContent className="space-y-3 px-2 pt-1 pb-4">
					<p className="max-w-[80ch] text-sm leading-relaxed">
						{tool.description}
					</p>
					<p className="font-mono text-nova-text-muted text-xs">
						{formatExactTokens(tool.weight.tokens)} estimated tokens for the
						JSON the SDK serializes. The provider renders it in its own grammar.
					</p>
					<JsonBlock value={tool.providerTool ?? tool.inputSchema} />
					{tool.providerOptions !== undefined && (
						<JsonBlock value={tool.providerOptions} />
					)}
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}

// ── Messages ─────────────────────────────────────────────────────────────

export function MessageView({
	item,
}: {
	item: WeighedItem & { kind: "message" };
}) {
	const [mode, setMode] = useState<TextMode>("rendered");
	const { message } = item;
	const parts =
		typeof message.content === "string"
			? [{ type: "text" as const, text: message.content }]
			: message.content;
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant="violet">{message.role}</Badge>
				{item.cacheBoundary && (
					<Badge variant="violet">
						<Icon icon={tablerBookmark} aria-hidden />
						cache boundary
					</Badge>
				)}
				<span className="text-nova-text-muted text-xs">
					{parts.length} {parts.length === 1 ? "part" : "parts"}
				</span>
				<div className="ml-auto flex items-center gap-1">
					<button
						type="button"
						onClick={() => setMode("rendered")}
						aria-pressed={mode === "rendered"}
						className={selectableSegmentCls(mode === "rendered")}
					>
						Rendered
					</button>
					<button
						type="button"
						onClick={() => setMode("raw")}
						aria-pressed={mode === "raw"}
						className={selectableSegmentCls(mode === "raw")}
					>
						Raw
					</button>
				</div>
			</div>
			<ol className="space-y-3">
				{parts.map((part, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: parts carry no identity and the list never reorders
					<li key={`${index}-${part.type}`}>
						<MessagePart part={part as unknown as AnyPart} mode={mode} />
					</li>
				))}
			</ol>
		</div>
	);
}

type AnyPart = { type: string } & Record<string, unknown>;

function MessagePart({ part, mode }: { part: AnyPart; mode: TextMode }) {
	switch (part.type) {
		case "text":
		case "reasoning": {
			const text = String(part.text ?? "");
			return (
				<div className="space-y-1">
					{part.type === "reasoning" && (
						<p className="text-nova-text-muted text-xs">Reasoning</p>
					)}
					{mode === "raw" ? (
						<pre className="max-w-full overflow-x-auto whitespace-pre-wrap wrap-anywhere rounded-xl border border-nova-border bg-nova-deep p-4 font-mono text-[13px] text-nova-text-secondary leading-relaxed">
							{text}
						</pre>
					) : (
						<div className="chat-markdown max-w-[80ch] text-[15px] leading-relaxed">
							<ChatMarkdown>{text}</ChatMarkdown>
						</div>
					)}
				</div>
			);
		}
		case "tool-call":
			return (
				<div className="space-y-1">
					<p className="text-xs">
						<span className="text-nova-text-muted">Tool call </span>
						<span className="font-mono">{String(part.toolName)}</span>
					</p>
					<JsonBlock value={part.input} />
				</div>
			);
		case "tool-result":
			return (
				<div className="space-y-1">
					<p className="text-xs">
						<span className="text-nova-text-muted">Tool result </span>
						<span className="font-mono">{String(part.toolName)}</span>
					</p>
					<JsonBlock value={part.output} />
				</div>
			);
		case "image":
		case "file":
			return (
				<p className="rounded-xl border border-nova-border border-dashed px-4 py-3 text-nova-text-secondary text-sm">
					{part.type === "image" ? "An image part" : "A file part"}
					{typeof part.mediaType === "string" && ` (${part.mediaType})`}. The
					provider bills it by its own rules; the estimate leaves it out.
				</p>
			);
		default:
			return <JsonBlock value={part} />;
	}
}

// ── JSON ─────────────────────────────────────────────────────────────────

function JsonBlock({ value }: { value: unknown }) {
	const text = useMemo(
		() => JSON.stringify(value, null, 2) ?? "undefined",
		[value],
	);
	return (
		<pre className="max-h-[32rem] max-w-full overflow-auto whitespace-pre-wrap wrap-anywhere rounded-xl border border-nova-border bg-nova-deep p-4 font-mono text-[13px] text-nova-text-secondary leading-relaxed">
			{text}
		</pre>
	);
}
