/**
 * Organization — where people work.
 *
 * Three subsections in the order an author builds them: the rungs, what the
 * places at those rungs carry, then the places themselves. The first two are
 * blueprint vocabulary and the third is app-scoped rows, and the surface
 * deliberately does not advertise that split — an author is arranging one
 * organization, not two stores.
 *
 * The store's snapshot is read once here and passed down, so the two
 * subsections that need it (Places, and Levels for its occupied set) share
 * one subscription rather than racing two.
 */
"use client";

import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";
import { useOrganization } from "@/lib/organization/useOrganization";
import { useAppId } from "@/lib/session/hooks";
import { LevelsSubsection } from "./LevelsSubsection";
import { PlaceInformationSubsection } from "./PlaceInformationSubsection";
import { PlacesSubsection } from "./PlacesSubsection";

export function OrganizationSection() {
	// Absent only on a brand-new build before its app row exists, where there is
	// no organization to read and nothing to write into.
	const appId = useAppId();
	const organization = useOrganization(appId ?? "");

	// Which levels currently hold a place — including archived ones, because
	// CommCare's own guard counts them and unarchiving into a removed level
	// would resurrect a row pointing at nothing.
	const occupiedLevelUuids = new Set(
		organization.locations.map((location) => location.levelUuid),
	);
	const status = organization.loading ? (
		<p className="flex items-center gap-2 rounded-lg border border-nova-border px-3 py-4 text-[13px] text-nova-text-muted">
			<Spinner className="size-4" />
			Loading the organization…
		</p>
	) : organization.error !== undefined ? (
		<p
			role="alert"
			className="rounded-lg border border-nova-red/40 bg-nova-red/[0.06] px-3 py-3 text-[13px] leading-relaxed text-nova-text"
		>
			{organization.error}{" "}
			<Button
				type="button"
				variant="ghost-action"
				onClick={organization.reload}
			>
				Try again
			</Button>
		</p>
	) : undefined;

	return (
		<section aria-labelledby="app-setup-organization-heading" className="pb-10">
			<h2 id="app-setup-organization-heading" className="sr-only">
				Organization
			</h2>
			<p className="mt-2 max-w-prose text-[13px] leading-relaxed text-nova-text-secondary">
				Set up the places where people work, which places own cases, and what
				workers can see.
			</p>
			<aside
				aria-label="Current support"
				className="mt-4 max-w-prose rounded-lg border border-nova-violet/30 bg-nova-violet/[0.06] px-3 py-3 text-[13px] leading-relaxed text-nova-text-secondary"
			>
				Preview can use assigned places and place-based case ownership, and
				publishing puts these places on your CommCare HQ project space. These
				settings do not filter Preview case lists yet, and an owner rule set to
				a particular place cannot be exported.
			</aside>
			<div className="mt-8 flex flex-col gap-10">
				{status ?? (
					<>
						{organization.warning !== undefined && (
							<p
								role="status"
								className="rounded-lg border border-nova-amber/40 bg-nova-amber/[0.06] px-3 py-3 text-[13px] leading-relaxed text-nova-text"
							>
								The saved organization could not be refreshed. Your open edits
								are still here. {organization.warning}{" "}
								<Button
									type="button"
									variant="ghost-action"
									onClick={organization.reload}
								>
									Try again
								</Button>
							</p>
						)}
						<LevelsSubsection
							occupiedLevelUuids={occupiedLevelUuids}
							locations={organization.locations}
						/>
						<PlaceInformationSubsection locations={organization.locations} />
						<PlacesSubsection organization={organization} />
					</>
				)}
			</div>
		</section>
	);
}
