"use client";

import { Icon } from "@iconify/react/offline";
import tablerCode from "@iconify-icons/tabler/code";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { RoleFacts } from "@/lib/agent/anatomy/catalog";

/**
 * The facts a reader needs before the prompt text: model and effort, cache
 * key, ledger, prompt version, ceilings, strictness, and the call site. A
 * quiet definition list, not a row of cards; the provider options literal
 * unfolds beneath it on request.
 */
export function FactsBand({
	facts,
	lifecycles,
	providerOptions,
	modelLabel,
}: {
	facts: RoleFacts;
	lifecycles: readonly string[];
	providerOptions: unknown;
	modelLabel: string | null;
}) {
	const [showOptions, setShowOptions] = useState(false);
	const rows: { label: string; value: string; detail?: string }[] = [
		{
			label: "Model",
			value:
				modelLabel === null
					? "None: the client's own model"
					: `${modelLabel} at ${facts.effort} effort`,
			...(facts.modelId !== null && { detail: facts.modelId }),
		},
		{
			label: "Call shape",
			value: CALL_SHAPES[facts.callShape],
		},
		{
			label: "Ledger",
			value: LEDGERS[facts.ledger],
		},
		{
			label: "Cache key",
			value: facts.cacheKey ?? "None: one-shot, nothing to share",
		},
		...(facts.promptVersion !== null
			? [{ label: "Prompt version", value: facts.promptVersion }]
			: []),
		{ label: "Tools", value: facts.toolStrictness },
		{ label: "Output", value: facts.outputStrictness },
		...facts.ceilings.map((ceiling) => ({
			label: ceiling.label,
			value: ceiling.value,
			...(ceiling.detail && { detail: ceiling.detail }),
		})),
		{
			label: "Call site",
			value: `${facts.source.file} · ${facts.source.symbol}`,
		},
		...(lifecycles.length > 0
			? [{ label: "Appears in", value: lifecycles.join(", ") }]
			: []),
	];
	return (
		<section aria-label="Role facts" className="space-y-3">
			<dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
				{rows.map((row) => (
					<div
						key={row.label}
						className="flex min-w-0 items-baseline gap-3 border-nova-border border-b py-1.5"
					>
						<dt className="w-32 shrink-0 text-nova-text-muted">{row.label}</dt>
						<dd className="min-w-0 wrap-anywhere">
							{row.detail ? (
								<SimpleTooltip content={row.detail}>
									<span className="underline decoration-nova-border-bright decoration-dotted underline-offset-4">
										{row.value}
									</span>
								</SimpleTooltip>
							) : (
								row.value
							)}
						</dd>
					</div>
				))}
			</dl>
			{providerOptions !== null && (
				<div className="space-y-2">
					<Button
						variant="ghost"
						onClick={() => setShowOptions((current) => !current)}
						aria-expanded={showOptions}
					>
						<Icon icon={tablerCode} aria-hidden />
						{showOptions ? "Hide provider options" : "Show provider options"}
					</Button>
					{showOptions && (
						<pre className="overflow-x-auto rounded-xl border border-nova-border bg-nova-deep p-4 font-mono text-nova-text-secondary text-xs leading-relaxed">
							{JSON.stringify(providerOptions, null, 2)}
						</pre>
					)}
				</div>
			)}
		</section>
	);
}

const CALL_SHAPES: Record<RoleFacts["callShape"], string> = {
	"tool-loop": "Tool loop: the SDK steps until a stop condition",
	"single-step-loop": "One model step per call; Nova's loop decides the next",
	"one-shot-structured": "One structured-output call, no tools",
	"client-agent": "No Nova loop: a client agent runs the prompt",
};

const LEDGERS: Record<RoleFacts["ledger"], string> = {
	"durable-context": "Durable model context: every message persisted",
	thread: "Thread transcript: the wire is rebuilt each turn",
	none: "None: nothing persists between calls",
};
