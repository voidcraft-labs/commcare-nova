"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/shadcn/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type {
	RecordedContext,
	RecordedStep,
	WeighedItem,
} from "@/lib/agent/anatomy/types";
import { cn } from "@/lib/utils";
import {
	formatExactTokens,
	formatTokens,
	formatWhen,
	KIND_FILL,
} from "../_lib/format";
import { MessageView } from "./ReadingPane";

export interface TimelineContext {
	readonly contextId: string;
	readonly kind: RecordedContext["kind"];
	readonly generation: number;
	readonly supersedesContextId: string | null;
	readonly modelId: string;
	readonly modelLabel: string;
	readonly promptVersion: string;
	readonly toolsetDigest: string;
	readonly contextVersion: string;
	readonly slice: NonNullable<RecordedContext["slice"]> | null;
	/** Estimated system prompt plus tools for this context's role. */
	readonly staticTokens: number | null;
	readonly items: readonly WeighedItem[];
	readonly steps: readonly RecordedStep[];
}

/**
 * A session's contexts in order. Each context lists its items with the
 * family chip, then its completed steps: the estimate of what was sent
 * beside what the provider billed, matched to responses in order.
 */
export function RecordedTimeline({
	contexts,
	sessionId,
}: {
	contexts: readonly TimelineContext[];
	sessionId: string;
}) {
	if (contexts.length === 0) {
		return (
			<p className="max-w-[68ch] rounded-xl border border-nova-border border-dashed px-4 py-3 text-nova-text-secondary text-sm">
				Nothing recorded yet. The first design step opens a context and its seed
				appears here.
			</p>
		);
	}
	return (
		<ol className="space-y-8">
			{contexts.map((context) => (
				<li key={context.contextId}>
					<ContextSection context={context} sessionId={sessionId} />
				</li>
			))}
		</ol>
	);
}

function ContextSection({
	context,
	sessionId,
}: {
	context: TimelineContext;
	sessionId: string;
}) {
	const rolePath =
		context.kind === "design" ? "design-author" : "build-executor";
	const title =
		context.kind === "design"
			? `Design author, generation ${context.generation}`
			: context.slice?.sliceId
				? `Build executor, slice ${context.slice.sliceId}${context.slice.attempt !== null ? `, attempt ${context.slice.attempt}` : ""}`
				: `Build executor, generation ${context.generation}`;
	const variableTokens = context.items.reduce<number | null>(
		(sum, item) =>
			sum === null || item.weight.tokens === null
				? null
				: sum + item.weight.tokens,
		0,
	);
	return (
		<section
			aria-labelledby={`context-${context.contextId}`}
			className="space-y-4 rounded-xl border border-nova-border bg-nova-surface p-5"
		>
			<header className="space-y-2">
				<div className="flex flex-wrap items-baseline justify-between gap-2">
					<h2
						id={`context-${context.contextId}`}
						className="font-display text-[19px] font-semibold tracking-[-0.015em]"
					>
						{title}
					</h2>
					<Link
						href={`/agents/${rolePath}?session=${encodeURIComponent(sessionId)}&moment=latest-step`}
						className="nova-focusable rounded-md text-nova-violet-bright text-sm hover:underline"
					>
						Open on the role page
					</Link>
				</div>
				<div className="flex flex-wrap items-center gap-1.5">
					<Badge variant="violet">{context.modelLabel}</Badge>
					<Badge>{context.promptVersion}</Badge>
					<SimpleTooltip content={`Toolset digest ${context.toolsetDigest}`}>
						<Badge>digest {context.toolsetDigest.slice(0, 8)}</Badge>
					</SimpleTooltip>
					{context.slice?.status && <Badge>{context.slice.status}</Badge>}
					{context.supersedesContextId && (
						<Badge variant="amber">supersedes an earlier generation</Badge>
					)}
					<span className="ml-auto font-mono text-nova-text-secondary text-xs">
						{context.items.length} items · {formatTokens(variableTokens)}{" "}
						estimated
						{context.staticTokens !== null &&
							` · ${formatTokens(context.staticTokens)} static`}
					</span>
				</div>
			</header>
			<ItemList items={context.items} />
			<StepList context={context} />
		</section>
	);
}

function ItemList({ items }: { items: readonly WeighedItem[] }) {
	return (
		<ol className="divide-y divide-nova-border">
			{items.map((item, index) => (
				<li key={item.id}>
					{item.kind === "compaction" ? (
						<div className="flex items-center gap-3 py-3 text-nova-amber text-sm">
							<span
								className="h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--nova-amber)_0_6px,transparent_6px_10px)]"
								aria-hidden
							/>
							<span>
								Compaction checkpoint: the provider replaced everything above;
								Nova appended what follows
							</span>
							<span
								className="h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--nova-amber)_0_6px,transparent_6px_10px)]"
								aria-hidden
							/>
						</div>
					) : item.kind === "message" ? (
						<ItemRow item={item} index={index} />
					) : null}
				</li>
			))}
		</ol>
	);
}

function ItemRow({
	item,
	index,
}: {
	item: WeighedItem & { kind: "message" };
	index: number;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger className="nova-focusable flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.06]">
				<span
					className={cn(
						"inline-block size-2.5 shrink-0 rounded-sm",
						KIND_FILL.message,
					)}
					aria-hidden
				/>
				<span className="w-6 shrink-0 font-mono text-nova-text-muted text-xs">
					{index + 1}
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm">{item.label}</span>
					{item.note && !open && (
						<span className="block truncate text-nova-text-muted text-xs">
							{item.note}
						</span>
					)}
				</span>
				<Badge>{item.wireRole}</Badge>
				<span className="w-12 shrink-0 text-right font-mono text-nova-text-secondary text-xs">
					{item.weight.tokens === null ? "?" : formatTokens(item.weight.tokens)}
				</span>
				<Icon
					icon={tablerChevronDown}
					className={cn(
						"size-4 shrink-0 text-nova-text-muted transition-transform",
						open && "rotate-180",
					)}
					aria-hidden
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="space-y-3 px-2 pt-2 pb-5">
				{item.note && (
					<p className="max-w-[80ch] text-nova-text-secondary text-sm leading-relaxed">
						{item.note}
					</p>
				)}
				<MessageView item={item} />
			</CollapsibleContent>
		</Collapsible>
	);
}

function StepList({ context }: { context: TimelineContext }) {
	const completed = context.steps
		.filter((step) => step.completedAt !== null)
		.sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
	if (completed.length === 0) {
		return (
			<p className="text-nova-text-muted text-xs">
				No completed step recorded in this context.
			</p>
		);
	}
	/* Estimate what each step sent: everything before its response. Steps and
	 * assistant responses are matched in order, so a recovered or interrupted
	 * step can shift the match by one; the billed column is exact either way. */
	const responseIndexes = context.items
		.map((item, index) => ({ item, index }))
		.filter(
			({ item }) => item.kind === "message" && item.wireRole === "assistant",
		)
		.map(({ index }) => index);
	const sentBefore = (responseIndex: number | undefined): number | null => {
		if (responseIndex === undefined || context.staticTokens === null)
			return null;
		let sum = context.staticTokens;
		for (const item of context.items.slice(0, responseIndex)) {
			if (item.weight.tokens === null) return null;
			sum += item.weight.tokens;
		}
		return sum;
	};
	return (
		<section aria-label="Completed steps" className="space-y-2">
			<p className="text-nova-text-muted text-xs">
				Completed steps: the estimate of what was sent beside what the provider
				billed
			</p>
			<div className="overflow-x-auto">
				<table className="w-full min-w-[640px] text-sm">
					<thead>
						<tr className="text-left text-nova-text-muted text-xs">
							<th className="py-1.5 pr-4 font-normal">Step</th>
							<th className="py-1.5 pr-4 font-normal">Completed</th>
							<th className="py-1.5 pr-4 text-right font-normal">
								Estimated sent
							</th>
							<th className="py-1.5 pr-4 text-right font-normal">
								Billed input
							</th>
							<th className="py-1.5 pr-4 text-right font-normal">Cached</th>
							<th className="py-1.5 pr-4 text-right font-normal">Output</th>
							<th className="py-1.5 text-right font-normal">Reasoning</th>
						</tr>
					</thead>
					<tbody className="font-mono text-xs">
						{completed.map((step, index) => {
							const estimate = sentBefore(responseIndexes[index]);
							const billed = step.usage?.inputTokens ?? null;
							return (
								<tr key={step.stepKey} className="border-nova-border border-t">
									<td className="py-2 pr-4 font-sans">{step.stepKey}</td>
									<td className="py-2 pr-4 text-nova-text-secondary">
										{step.completedAt ? formatWhen(step.completedAt) : ""}
									</td>
									<td className="py-2 pr-4 text-right">
										{formatExactTokens(estimate)}
									</td>
									<td className="py-2 pr-4 text-right">
										{formatExactTokens(billed)}
										{estimate !== null && billed !== null && (
											<span className="ml-1 text-nova-text-muted">
												({billed >= estimate ? "+" : ""}
												{Math.round(
													((billed - estimate) / Math.max(estimate, 1)) * 100,
												)}
												%)
											</span>
										)}
									</td>
									<td className="py-2 pr-4 text-right text-nova-text-secondary">
										{formatExactTokens(step.usage?.cachedInputTokens ?? null)}
									</td>
									<td className="py-2 pr-4 text-right">
										{formatExactTokens(step.usage?.outputTokens ?? null)}
									</td>
									<td className="py-2 text-right text-nova-text-secondary">
										{formatExactTokens(step.usage?.reasoningTokens ?? null)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</section>
	);
}
