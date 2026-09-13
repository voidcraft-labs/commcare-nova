import { Icon } from "@iconify/react/offline";
import tablerArrowDown from "@iconify-icons/tabler/arrow-down";
import tablerMessage from "@iconify-icons/tabler/message";
import tablerServer from "@iconify-icons/tabler/server";
import Link from "next/link";
import { Badge } from "@/components/shadcn/badge";
import type { AnatomyRoleId, Lifecycle } from "@/lib/agent/anatomy";
import { modelLabel } from "@/lib/agent/anatomy";
import { formatTokens } from "../_lib/format";
import type { RoleSummary } from "../_lib/roleSummary";

/**
 * The map: four lifecycles as vertical strips of the roles they pass
 * through, with the handoff between roles stated in words. No connectors, no
 * diagram library: the order down the strip is the order of the lifecycle.
 */
export function LifecycleStrips({
	lifecycles,
	summaries,
}: {
	lifecycles: readonly Lifecycle[];
	summaries: ReadonlyMap<AnatomyRoleId, RoleSummary>;
}) {
	return (
		<div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
			{lifecycles.map((lifecycle) => (
				<section
					key={lifecycle.id}
					aria-labelledby={`lifecycle-${lifecycle.id}`}
					className="min-w-0 space-y-4"
				>
					<div className="space-y-1">
						<h2
							id={`lifecycle-${lifecycle.id}`}
							className="font-display text-[19px] font-semibold tracking-[-0.015em]"
						>
							{lifecycle.title}
						</h2>
						<p className="text-nova-text-secondary text-sm leading-relaxed">
							{lifecycle.summary}
						</p>
					</div>
					<ol className="space-y-2">
						{lifecycle.steps.map((step, index) => {
							const key = `${lifecycle.id}-${index}`;
							switch (step.kind) {
								case "role": {
									const summary = summaries.get(step.role);
									if (summary === undefined) return null;
									return (
										<li key={key}>
											<RoleCard summary={summary} note={step.note} />
										</li>
									);
								}
								case "server":
									return (
										<li
											key={key}
											className="flex gap-3 rounded-xl border border-nova-border border-dashed px-4 py-3"
										>
											<Icon
												icon={tablerServer}
												className="mt-0.5 size-4 shrink-0 text-nova-text-muted"
												aria-hidden
											/>
											<div className="min-w-0 space-y-0.5">
												<p className="text-sm">{step.label}</p>
												{step.note && (
													<p className="text-nova-text-muted text-xs leading-relaxed">
														{step.note}
													</p>
												)}
											</div>
										</li>
									);
								case "input":
									return (
										<li
											key={key}
											className="flex items-start gap-3 px-4 py-2 text-nova-text-secondary text-sm"
										>
											<Icon
												icon={tablerMessage}
												className="mt-0.5 size-4 shrink-0 text-nova-text-muted"
												aria-hidden
											/>
											<span>{step.label}</span>
										</li>
									);
								case "handoff":
									return (
										<li
											key={key}
											className="flex items-center gap-2 px-4 text-nova-text-muted text-xs"
										>
											<Icon
												icon={tablerArrowDown}
												className="size-3.5 shrink-0"
												aria-hidden
											/>
											<span>{step.label}</span>
										</li>
									);
								default:
									return null;
							}
						})}
					</ol>
				</section>
			))}
		</div>
	);
}

function RoleCard({ summary, note }: { summary: RoleSummary; note?: string }) {
	const { facts } = summary;
	return (
		<Link
			href={`/agents/${facts.role}`}
			className="nova-focusable block rounded-xl border border-nova-border bg-nova-surface px-4 py-3 transition-colors hover:border-nova-border-bright hover:bg-nova-elevated"
		>
			<div className="flex items-baseline justify-between gap-3">
				<span className="font-medium text-[15px]">{facts.title}</span>
				{facts.modelId !== null && facts.effort !== null && (
					<span className="shrink-0 text-nova-text-secondary text-xs">
						{modelLabel(facts.modelId)} · {facts.effort}
					</span>
				)}
			</div>
			{note && (
				<p className="mt-1 text-nova-text-secondary text-xs leading-relaxed">
					{note}
				</p>
			)}
			<div className="mt-2.5 flex flex-wrap items-center gap-1.5">
				{summary.staticTokens !== null && summary.staticTokens > 0 && (
					<Badge variant="violet">
						{formatTokens(summary.staticTokens)} static tokens
					</Badge>
				)}
				{summary.toolCount > 0 && (
					<Badge>
						{summary.toolCount} {summary.toolCount === 1 ? "tool" : "tools"}
					</Badge>
				)}
				{facts.promptVersion !== null && <Badge>{facts.promptVersion}</Badge>}
				<Badge>
					{facts.ledger === "durable-context"
						? "durable context"
						: facts.ledger === "thread"
							? "thread"
							: "no ledger"}
				</Badge>
			</div>
		</Link>
	);
}
