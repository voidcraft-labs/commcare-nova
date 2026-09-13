"use client";

import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { bandOf } from "@/lib/agent/anatomy/bands";
import type { WeighedItem, WeighedMoment } from "@/lib/agent/anatomy/types";
import { cn } from "@/lib/utils";
import {
	formatExactTokens,
	formatTokens,
	formatWeight,
	KIND_FILL,
} from "../_lib/format";

/**
 * The weight of the moment as one bar whose segments are the items in wire
 * order: the static part the provider caches on the left, the per-turn
 * messages on the right. The bar is a picture of the list below it; the
 * list is where an item is picked, so no segment has to be a hit target.
 */
export function TokenBar({
	moment,
	selectedId,
}: {
	moment: WeighedMoment;
	selectedId: string | null;
}) {
	const staticItems = moment.items.filter(
		(item) => bandOf(item.kind) === "static",
	);
	const variableItems = moment.items.filter(
		(item) => bandOf(item.kind) === "variable",
	);
	const total = moment.items.reduce(
		(sum, item) => sum + (item.weight.tokens ?? 0),
		0,
	);
	const staticTokens = moment.bands.static.tokens;
	const variableTokens = moment.bands.variable.tokens;
	return (
		<section aria-label="Estimated weight" className="space-y-2">
			<div className="flex items-stretch gap-1.5">
				<Band items={staticItems} total={total} selectedId={selectedId} />
				{variableItems.length > 0 && (
					<Band items={variableItems} total={total} selectedId={selectedId} />
				)}
			</div>
			<div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs">
				<Legend
					swatch="bg-nova-violet"
					label="Static per call"
					value={staticTokens}
				/>
				<Legend
					swatch="bg-nova-orchid"
					label="Messages this moment"
					value={variableTokens}
					note={
						variableTokens === null
							? "includes a checkpoint or media the estimator cannot count"
							: undefined
					}
				/>
				<span className="text-nova-text-muted">
					Estimated with the o200k_base tokenizer; the provider bills its own
					rendering
				</span>
			</div>
		</section>
	);
}

function Band({
	items,
	total,
	selectedId,
}: {
	items: readonly WeighedItem[];
	total: number;
	selectedId: string | null;
}) {
	const tokens = items.reduce(
		(sum, item) => sum + (item.weight.tokens ?? 0),
		0,
	);
	const share = total === 0 ? 1 : tokens / total;
	return (
		<div
			className="flex min-w-[10%] gap-px overflow-hidden rounded-md"
			style={{ flexGrow: Math.max(share, 0.1), flexBasis: 0 }}
		>
			{items.map((item) => {
				const weight = item.weight.tokens ?? 0;
				const selected = item.id === selectedId;
				const opaque = item.kind === "compaction" || item.kind === "missing";
				return (
					<SimpleTooltip
						key={item.id}
						content={`${item.label}: ${formatWeight(item.weight)}`}
					>
						<span
							role="img"
							aria-label={`${item.label}, ${formatWeight(item.weight)}`}
							className={cn(
								"relative h-7 min-w-2 transition-opacity",
								KIND_FILL[item.kind],
								item.kind === "missing" &&
									"border border-nova-border-bright border-dashed",
								item.kind === "compaction" &&
									"bg-[repeating-linear-gradient(135deg,var(--nova-amber)_0_4px,transparent_4px_8px)]",
								!selected && selectedId !== null && "opacity-55",
							)}
							style={{
								flexGrow: opaque ? 0 : Math.max(weight, 1),
								flexBasis: opaque ? "14px" : 0,
							}}
						/>
					</SimpleTooltip>
				);
			})}
		</div>
	);
}

function Legend({
	swatch,
	label,
	value,
	note,
}: {
	swatch: string;
	label: string;
	value: number | null;
	note?: string;
}) {
	return (
		<span className="inline-flex items-baseline gap-1.5">
			<span
				className={cn(
					"inline-block size-2.5 translate-y-px rounded-sm",
					swatch,
				)}
				aria-hidden
			/>
			<span className="text-nova-text-secondary">{label}</span>
			<SimpleTooltip content={`${formatExactTokens(value)} estimated tokens`}>
				<span className="font-mono text-nova-text">{formatTokens(value)}</span>
			</SimpleTooltip>
			{note && <span className="text-nova-text-muted">({note})</span>}
		</span>
	);
}
