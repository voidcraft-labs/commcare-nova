// components/builder/case-list-config/SampleDataButton.tsx
//
// The "Generate Sample Data" affordance shared by every empty-state
// surface — the case-list and case-detail canvases and the running-app
// preview. Generating sample data is a builder convenience, not an
// end-user feature, so the affordance stays LOW-EMPHASIS (a tinted
// outline, never a solid primary button) wherever it appears, and a
// single component owns that treatment so the surfaces can't drift
// apart. The button drives the one `SampleDataAction` status machine,
// rendering its own running spinner and error line.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import type { SampleDataAction } from "./useSampleData";

export function GenerateSampleDataButton({
	generate,
	className = "",
}: {
	readonly generate: SampleDataAction;
	/** Extra classes for the button — callers set alignment/width to fit
	 *  their surface (centered in a canvas, full-width in the search rail). */
	readonly className?: string;
}) {
	const running = generate.status.kind === "running";
	return (
		<>
			<button
				type="button"
				onClick={generate.run}
				disabled={running}
				className={`inline-flex items-center justify-center gap-2 px-4 min-h-11 text-[13px] font-medium rounded-lg bg-nova-violet/[0.15] border border-nova-violet/[0.35] text-nova-violet-bright hover:bg-nova-violet/[0.25] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
			>
				<Icon
					icon={running ? tablerLoader2 : tablerSparkles}
					width="14"
					height="14"
					className={running ? "animate-spin" : undefined}
				/>
				{running ? "Generating…" : "Generate Sample Data"}
			</button>
			{generate.status.kind === "error" && (
				<p className="mt-3 text-xs text-nova-rose whitespace-pre-line">
					{generate.status.message}
				</p>
			)}
		</>
	);
}
