"use client";
import { Icon } from "@iconify/react/offline";
import { Tooltip } from "@/components/ui/Tooltip";
import { useXPathText } from "@/lib/doc/hooks/useXPathSlots";
import {
	fieldRegistry,
	type HiddenField as HiddenFieldEntity,
} from "@/lib/domain";
import { ExpressionContent } from "@/lib/references/ExpressionContent";

/**
 * Edit-mode-only representation of a hidden field. These have no label or
 * visible input — they're system-level values driven by calculate expressions
 * or static defaults. The card shows the field ID as the primary identifier
 * and surfaces any calculate/default expressions with dimmed inline chips for
 * hashtag references.
 */
export function HiddenField({ field }: { field: HiddenFieldEntity }) {
	// Stored expressions are ASTs; the card shows their live printed text.
	const expr = useXPathText(field.calculate ?? field.default_value);

	return (
		<div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-dashed border-nova-text-muted/25 bg-nova-text-muted/[0.03]">
			<div className="flex items-center gap-1.5 shrink-0">
				<Icon
					icon={fieldRegistry.hidden.icon}
					width="14"
					height="14"
					className="text-nova-text-muted"
				/>
				<span className="text-[10px] font-semibold uppercase tracking-wider text-nova-text-muted">
					Hidden
				</span>
			</div>

			<div className="w-px h-4 bg-nova-text-muted/15 shrink-0" />

			<span className="text-xs font-mono font-medium text-nova-text shrink-0">
				{field.id}
			</span>

			{expr && (
				<>
					<div className="w-px h-4 bg-nova-text-muted/15 shrink-0" />
					<Tooltip content={expr}>
						<span className="min-w-0 text-[11px] font-mono text-nova-text-muted truncate">
							{field.calculate ? (
								<>
									<span className="text-nova-violet-bright">f</span>{" "}
								</>
							) : (
								<>
									<span className="text-nova-amber">=</span>{" "}
								</>
							)}
							<ExpressionContent expr={expr} />
						</span>
					</Tooltip>
				</>
			)}
		</div>
	);
}
