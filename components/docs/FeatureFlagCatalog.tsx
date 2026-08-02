/** Public docs projection of the same catalog publish detection consumes. */

import { HQ_FEATURE_FLAG_REQUIREMENTS } from "@/lib/publish/hqFeatureFlags";

export function FeatureFlagCatalog() {
	return (
		<div className="not-prose my-6 space-y-4">
			{HQ_FEATURE_FLAG_REQUIREMENTS.map((flag) => (
				<section
					key={flag.id}
					id={flag.docs_url.split("#")[1]}
					className="scroll-mt-24 rounded-xl border border-fd-border bg-fd-card p-5"
				>
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
						<h2 className="m-0 text-lg font-semibold text-fd-foreground">
							{flag.label}
						</h2>
						<code className="text-xs text-fd-muted-foreground">
							{flag.slug}
						</code>
					</div>
					<p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
						{flag.description}
					</p>
					<dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
						<div>
							<dt className="font-medium text-fd-foreground">
								When Nova needs it
							</dt>
							<dd className="mt-1 leading-relaxed text-fd-muted-foreground">
								{flag.required_for}
							</dd>
						</div>
						<div>
							<dt className="font-medium text-fd-foreground">
								Where it is enabled
							</dt>
							<dd className="mt-1 leading-relaxed text-fd-muted-foreground">
								For one CommCare HQ project space. It does not automatically
								carry over to another space.
							</dd>
						</div>
					</dl>
				</section>
			))}
		</div>
	);
}
