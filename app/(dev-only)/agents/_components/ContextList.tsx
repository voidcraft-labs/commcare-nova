"use client";

import { Icon } from "@iconify/react/offline";
import tablerBookmark from "@iconify-icons/tabler/bookmark";
import type { WeighedItem } from "@/lib/agent/anatomy/types";
import { selectableRowCls } from "@/lib/styles";
import { cn } from "@/lib/utils";
import {
	formatTokens,
	KIND_FILL,
	KIND_LABELS,
	NEED_LABELS,
} from "../_lib/format";

/** The origin in a row's few words; the reading pane spells it out. */
const ROW_ORIGIN = {
	composed: "from code",
	derived: "from the app",
	recorded: "from the run",
} as const;

/**
 * The ordered items the model receives at this moment, top to bottom in wire
 * order. Selecting one opens it in the reading pane; at compact widths the
 * pane is a drawer.
 */
export function ContextList({
	items,
	selectedId,
	onSelect,
}: {
	items: readonly WeighedItem[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	return (
		<ol aria-label="What the model receives, in order" className="space-y-1">
			{items.map((item, index) => {
				const selected = item.id === selectedId;
				const missing = item.kind === "missing";
				return (
					<li key={item.id}>
						<button
							type="button"
							onClick={() => onSelect(item.id)}
							aria-pressed={selected}
							className={cn(
								selectableRowCls(selected),
								"items-start border",
								missing
									? "border-nova-border border-dashed"
									: "border-transparent",
							)}
						>
							<span
								className={cn(
									"mt-1.5 inline-block size-2.5 shrink-0 rounded-sm",
									KIND_FILL[item.kind],
									missing && "border border-nova-border-bright border-dashed",
									item.kind === "compaction" &&
										"bg-[repeating-linear-gradient(135deg,var(--nova-amber)_0_2px,transparent_2px_4px)]",
								)}
								aria-hidden
							/>
							<span className="min-w-0 flex-1 space-y-0.5">
								<span className="flex items-baseline gap-2">
									<span className="min-w-0 truncate text-sm">{item.label}</span>
									{item.kind === "message" && item.cacheBoundary && (
										<Icon
											icon={tablerBookmark}
											className="size-3.5 shrink-0 translate-y-0.5 text-nova-violet-bright"
											aria-label="Cache boundary"
										/>
									)}
								</span>
								<span className="block text-nova-text-muted text-xs">
									{index + 1} ·{" "}
									{item.kind === "missing"
										? NEED_LABELS[item.needs]
										: `${item.kind === "message" ? item.wireRole : KIND_LABELS[item.kind].toLowerCase()} · ${ROW_ORIGIN[item.origin]}`}
								</span>
							</span>
							<span className="shrink-0 pt-0.5 font-mono text-nova-text-secondary text-xs">
								{item.kind === "missing"
									? ""
									: item.weight.tokens === null
										? "?"
										: formatTokens(item.weight.tokens)}
							</span>
						</button>
					</li>
				);
			})}
		</ol>
	);
}
