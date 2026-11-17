/**
 * What a first publish over an app brought in from CommCare HQ changes, for
 * one surface: the bring-in's review and the Publish dialog.
 *
 * Every word and every rule is `lib/publish/firstPublishCopy.ts::
 * firstPublishLines`, which MCP reads too, so the three surfaces say one
 * thing in one order. This draws its six parts in order and decides nothing:
 * it never reads whether a line touches workers, never sorts one and never
 * picks a string.
 */
"use client";

import { type ReactElement, useId, useState } from "react";
import type { FirstPublishView } from "@/lib/publish/firstPublishChangeIds";
import { firstPublishLines } from "@/lib/publish/firstPublishCopy";

/* The renderer's value. Its own type shares this component's name. */
type Lines = ReturnType<typeof firstPublishLines>;

/** One view's identity, so a change of row is told from a re-render. */
function viewKey(view: FirstPublishView): string {
	return `${view.of}|${view.touchesWorkers}|${view.ids.join(",")}`;
}

export function FirstPublishLines({
	view,
	surface,
}: {
	readonly view: FirstPublishView;
	readonly surface: "review" | "publish";
}): ReactElement {
	const lines: Lines = firstPublishLines(view, surface);
	const headingId = useId();
	const workersId = useId();
	const hqOnlyId = useId();
	/* Where the list changes under the person (another row chosen), the
	 * heading is announced once, not each sentence. A live region speaks a
	 * change of its text, so the text alternates between two spellings that
	 * read alike on every change after the first render. */
	const key = viewKey(view);
	const [seen, setSeen] = useState({ key, changes: 0 });
	if (seen.key !== key) setSeen({ key, changes: seen.changes + 1 });
	const announcement =
		seen.changes === 0
			? ""
			: seen.changes % 2 === 1
				? lines.heading
				: `${lines.heading}​`;

	return (
		<section
			aria-labelledby={headingId}
			className="mt-4 rounded-lg border border-nova-border bg-nova-well px-3 py-3 text-[13px] leading-relaxed"
			data-first-publish-lines
		>
			<h2 id={headingId} className="text-sm font-semibold text-nova-text">
				{lines.heading}
			</h2>
			<p aria-live="polite" className="sr-only">
				{announcement}
			</p>
			<p className="mt-1 text-nova-text-secondary">{lines.lead}</p>
			{lines.workers.lines.length > 0 ? (
				<>
					<h3
						id={workersId}
						className="mt-3 text-[13px] font-medium text-nova-text"
					>
						{lines.workers.label}
					</h3>
					<ul
						aria-labelledby={workersId}
						className="mt-1 flex list-disc flex-col gap-1 pl-5 text-nova-text-secondary"
					>
						{lines.workers.lines.map((line) => (
							<li key={line.id}>{line.sentence}</li>
						))}
					</ul>
				</>
			) : null}
			{lines.reassurance !== null ? (
				<p className="mt-3 text-nova-text-secondary">{lines.reassurance}</p>
			) : null}
			<h3 id={hqOnlyId} className="mt-3 text-[13px] font-medium text-nova-text">
				{lines.hqOnly.label}
			</h3>
			<ul
				aria-labelledby={hqOnlyId}
				className="mt-1 flex list-disc flex-col gap-1 pl-5 text-nova-text-secondary"
			>
				{lines.hqOnly.lines.map((line) => (
					<li key={line.id}>{line.sentence}</li>
				))}
			</ul>
			<p className="mt-3 text-nova-text-muted">{lines.note}</p>
		</section>
	);
}
