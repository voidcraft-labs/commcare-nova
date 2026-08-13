/**
 * The pre-materialization progress region (§15.1, §15.3, §15.13).
 *
 * `/build/new` has no app tree and no Preview while a design build runs, so
 * this is the whole of what the screen can honestly show: one textual stage
 * line in a polite live region, and the reviewed-design outline as a card of
 * semantic headings behind disclosure controls. It renders inside the
 * conversation column and stays subordinate to it.
 *
 * Purely presentational — every value arrives already derived
 * (`lib/session/designProgressStore`), so nothing here decides what the build
 * is doing. Once the app materializes the outline retires (the app tree shows
 * the real structure) but the workflow progress card stays, compacting past
 * five workflows to the one being built plus the next waiting with a counted
 * byline; the live stage remains the one status directly above the composer
 * until the full build finishes.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import tablerPointFilled from "@iconify-icons/tabler/point-filled";
import { type ReactNode, useId, useState } from "react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import { Spinner } from "@/components/shadcn/spinner";
import type { DesignOutlineProjection } from "@/lib/generation/designProgressWire";
import type { DesignProgressView } from "@/lib/session/designProgressStore";
import { DISCLOSURE_ROW_CLS } from "@/lib/styles";

export interface DesignProgressPanelProps {
	readonly view: DesignProgressView;
}

export function DesignProgressStatus({ view }: DesignProgressPanelProps) {
	if (!view.active || view.stageLabel === null) return null;
	return <StageLine view={view} />;
}

export function DesignProgressDetails({ view }: DesignProgressPanelProps) {
	if (!view.active || view.stageLabel === null) return null;

	/* Once the app exists the builder is mounted and the outline's job is
	 * done (the app tree now shows the real structure) — but the workflow
	 * progress card STAYS: the first workflow's card must not be the only one
	 * a user ever sees. Past five workflows it compacts to the one being
	 * built plus the next few waiting, with the rest counted in a byline. A
	 * legacy session with no published plan names keeps the brief per-slice
	 * sentence. */
	if (view.materialized) {
		if (view.plannedSliceNames.length > 0) {
			return (
				<section
					aria-label="Build progress"
					data-design-progress-stage={view.stage ?? undefined}
					className="flex flex-col gap-3"
				>
					<PlannedWorkflows view={view} />
				</section>
			);
		}
		const latest = view.committedSliceNames.at(-1);
		if (!latest) return null;
		return (
			<p
				data-design-progress-stage={view.stage ?? undefined}
				className="text-xs leading-5 text-nova-text-muted"
			>
				Added {latest}
				{view.currentSliceName ? `, building ${view.currentSliceName}` : ""}
			</p>
		);
	}

	return (
		<section
			aria-label="Design details"
			data-design-progress-stage={view.stage ?? undefined}
			className="flex flex-col gap-3"
		>
			{view.outline && <OutlineCard outline={view.outline} />}
			<PlannedWorkflows view={view} />
		</section>
	);
}

// ── Stage ──────────────────────────────────────────────────────────

/**
 * The one live region. Polite, because a stage change is information rather
 * than a demand: the question card owns the assertive announcement when the
 * build actually needs an answer.
 */
function StageLine({ view }: { readonly view: DesignProgressView }) {
	const halted = view.stage === "failed" || view.stage === "incomplete";
	return (
		<div
			role="status"
			aria-live="polite"
			aria-atomic="true"
			className="flex min-h-10 shrink-0 items-start gap-2 px-4 py-2"
		>
			{view.working ? (
				<Spinner
					aria-hidden="true"
					className="mt-0.5 size-4 shrink-0 text-nova-violet-bright"
				/>
			) : (
				<Icon
					icon={
						view.stage === "ready"
							? tablerCircleCheck
							: halted
								? tablerAlertTriangle
								: tablerPointFilled
					}
					aria-hidden="true"
					className={`mt-0.5 size-4 shrink-0 ${
						view.stage === "ready"
							? "text-nova-emerald"
							: halted
								? "text-nova-rose"
								: "text-nova-amber"
					}`}
				/>
			)}
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium leading-5 text-nova-text">
					{view.stageLabel}
				</p>
				{view.pulseStep && (
					<p className="mt-0.5 text-xs leading-5 text-nova-text-secondary">
						{view.pulseStep}
					</p>
				)}
				{view.currentSliceName && (
					<p className="mt-0.5 text-xs leading-5 text-nova-text-secondary">
						Building {view.currentSliceName}
					</p>
				)}
				{view.sliceProgress && (
					<p className="mt-0.5 text-xs leading-5 text-nova-text-muted">
						{view.sliceProgress.committed} of {view.sliceProgress.planned}{" "}
						planned{" "}
						{view.sliceProgress.planned === 1 ? "workflow" : "workflows"}{" "}
						committed
					</p>
				)}
				{view.failure && (
					<p className="mt-0.5 text-xs leading-5 text-nova-text-secondary">
						{view.failure}
					</p>
				)}
			</div>
		</div>
	);
}

// ── Planned workflows ──────────────────────────────────────────────

/** How many workflow rows the card shows before it compacts. */
const WORKFLOW_ROWS_SHOWN = 5;

/**
 * The rows and byline the workflow card renders — a pure derivation so the
 * compact rule is testable without mounting anything. Five or fewer planned
 * workflows show in full, statuses and all. Past five, the card keeps the one
 * being built at the top plus the next waiting ones up to five rows, and the
 * byline counts what the list no longer shows ("3 pending · 4 completed").
 */
export function planWorkflowRows(view: {
	readonly plannedSliceNames: readonly string[];
	readonly currentSliceName: string | null;
	readonly committedSliceNames: readonly string[];
}): {
	rows: readonly { name: string; status: "built" | "building" | "waiting" }[];
	byline: string | null;
} {
	const committed = new Set(view.committedSliceNames);
	const status = (name: string): "built" | "building" | "waiting" =>
		committed.has(name)
			? "built"
			: view.currentSliceName === name
				? "building"
				: "waiting";
	const all = view.plannedSliceNames.map((name) => ({
		name,
		status: status(name),
	}));
	if (all.length <= WORKFLOW_ROWS_SHOWN) {
		return { rows: all, byline: null };
	}
	const building = all.filter((row) => row.status === "building");
	const waiting = all.filter((row) => row.status === "waiting");
	const rows = [
		...building,
		...waiting.slice(0, WORKFLOW_ROWS_SHOWN - building.length),
	];
	const hiddenPending = waiting.length - (rows.length - building.length);
	const completedCount = all.length - building.length - waiting.length;
	const parts: string[] = [];
	if (hiddenPending > 0) {
		parts.push(`${hiddenPending} pending`);
	}
	if (completedCount > 0) {
		parts.push(`${completedCount} completed`);
	}
	return { rows, byline: parts.length > 0 ? parts.join(" · ") : null };
}

function PlannedWorkflows({ view }: { readonly view: DesignProgressView }) {
	if (view.plannedSliceNames.length === 0) return null;
	/* The plan summary publishes slice NAMES only (no ids — §15.3 keeps
	 * implementation identifiers off this surface), so the join with what has
	 * committed is by name. The count beside the stage line is the
	 * authoritative figure; these marks are the readable version of it. */
	const { rows, byline } = planWorkflowRows(view);
	return (
		<div className="rounded-lg border border-nova-border bg-white/[0.02] p-3">
			<h2 className="text-xs font-medium uppercase tracking-wide text-nova-text-muted">
				Planned workflows
			</h2>
			<ol className="mt-2 flex flex-col gap-1.5">
				{rows.map(({ name, status }) => (
					<li
						key={name}
						className="flex items-start gap-2 text-xs leading-5 text-nova-text-secondary"
					>
						<Icon
							icon={status === "built" ? tablerCircleCheck : tablerPointFilled}
							aria-hidden="true"
							className={`mt-0.5 size-3.5 shrink-0 ${
								status === "built"
									? "text-nova-emerald"
									: status === "building"
										? "text-nova-violet-bright"
										: "text-nova-text-muted"
							}`}
						/>
						<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
							{name}
						</span>
						{/* Text, never color alone. */}
						<span className="shrink-0 text-nova-text-muted">
							{status === "built"
								? "Built"
								: status === "building"
									? "Building"
									: "Waiting"}
						</span>
					</li>
				))}
			</ol>
			{byline && (
				<p className="mt-2 text-xs leading-5 text-nova-text-muted">{byline}</p>
			)}
		</div>
	);
}

// ── Outline ────────────────────────────────────────────────────────

function reviewStatusLine(outline: DesignOutlineProjection): string {
	if (!outline.reviewed) return "Not reviewed yet";
	return "Independently reviewed";
}

/**
 * The safe outline card. Everything on it is a name or a sentence the design
 * pipeline already published; nothing here can reach a source excerpt, an
 * attachment body, or an implementation identifier, because the projection it
 * renders carries none.
 */
function OutlineCard({
	outline,
}: {
	readonly outline: DesignOutlineProjection;
}) {
	const headingId = useId();
	return (
		<article
			aria-labelledby={headingId}
			className="rounded-lg border border-nova-border bg-white/[0.02] p-3"
		>
			<h2
				id={headingId}
				className="text-xs font-medium uppercase tracking-wide text-nova-text-muted"
			>
				Reviewed design
			</h2>
			<p className="mt-1.5 text-sm leading-5 text-nova-text">
				{outline.objective}
			</p>
			<p className="mt-1 text-xs leading-5 text-nova-text-muted">
				{reviewStatusLine(outline)}
			</p>

			<div className="mt-2 flex flex-col">
				<OutlineSection
					title="Questions Nova still needs answered"
					items={outline.blockingQuestions}
					defaultOpen
					tone="attention"
				/>
				<OutlineSection title="Who uses it" items={outline.actors} />
				<OutlineSection title="What they do" items={outline.tasks} />
				<OutlineSection
					title="What it keeps track of"
					items={outline.records}
				/>
				<OutlineSection title="Work queues" items={outline.lists} />
				<OutlineSection title="Assumptions" items={outline.assumptions} />
				<OutlineSection title="Not included" items={outline.outOfScope} />
			</div>
		</article>
	);
}

function OutlineSection({
	title,
	items,
	defaultOpen = false,
	tone = "plain",
}: {
	readonly title: string;
	readonly items: readonly string[];
	readonly defaultOpen?: boolean;
	readonly tone?: "plain" | "attention";
}) {
	const [open, setOpen] = useState(defaultOpen);
	if (items.length === 0) return null;
	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			{/* The disclosure pattern: the heading holds the button, so the
			    outline is navigable by heading AND operable by keyboard. */}
			<h3 className="m-0">
				<CollapsibleTrigger
					render={<button type="button" className={DISCLOSURE_ROW_CLS} />}
				>
					<Icon
						icon={tablerChevronRight}
						aria-hidden="true"
						width="13"
						height="13"
						className="shrink-0 text-nova-text-muted transition-transform group-data-[panel-open]:rotate-90"
					/>
					<span
						className={`text-xs font-medium transition-colors group-hover:text-nova-text ${
							tone === "attention"
								? "text-nova-amber"
								: "text-nova-text-secondary"
						}`}
					>
						{title}
					</span>{" "}
					<span className="text-xs text-nova-text-muted">{items.length}</span>
				</CollapsibleTrigger>
			</h3>
			<CollapsibleContent>
				<ul className="flex flex-col gap-1 pb-2 pl-[21px]">
					{items.map((item) => (
						<ListItem key={item}>{item}</ListItem>
					))}
				</ul>
			</CollapsibleContent>
		</Collapsible>
	);
}

function ListItem({ children }: { readonly children: ReactNode }) {
	return (
		<li className="text-xs leading-5 text-nova-text-secondary [overflow-wrap:anywhere]">
			{children}
		</li>
	);
}
