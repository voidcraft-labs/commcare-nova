/** Public docs projection of the semantic project-space compatibility catalog. */

import {
	PROJECT_SPACE_ADVISORIES,
	PROJECT_SPACE_CAPABILITIES,
} from "@/lib/publish/projectSpaceCompatibility";

export function ProjectSpaceCapabilityCatalog() {
	return (
		<div className="not-prose my-6 space-y-8">
			<div className="space-y-4">
				{Object.values(PROJECT_SPACE_CAPABILITIES).map((capability) => (
					<section
						key={capability.id}
						id={capability.id}
						className="scroll-mt-24 rounded-xl border border-fd-border bg-fd-card p-5"
					>
						<h3 className="m-0 text-lg font-semibold text-fd-foreground">
							{capability.label}
						</h3>
						<p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
							{capability.description}
						</p>
						<p className="mt-4 text-sm leading-relaxed text-fd-muted-foreground">
							Nova adds this requirement when the app uses the capability. A
							direct publish waits until the selected project space confirms it
							can run the app.
						</p>
					</section>
				))}
			</div>

			<section
				id={PROJECT_SPACE_ADVISORIES["large-search-performance"].id}
				className="scroll-mt-24 rounded-xl border border-fd-border bg-fd-card p-5"
			>
				<p className="m-0 text-sm font-medium text-fd-muted-foreground">
					Performance guidance
				</p>
				<h3 className="mt-2 text-lg font-semibold text-fd-foreground">
					{PROJECT_SPACE_ADVISORIES["large-search-performance"].title}
				</h3>
				<p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
					{PROJECT_SPACE_ADVISORIES["large-search-performance"].description}
				</p>
				<p className="mt-4 text-sm leading-relaxed text-fd-muted-foreground">
					This never blocks publishing. Nova includes the faster large-result
					behavior automatically when the project space supports it.
				</p>
			</section>
		</div>
	);
}
