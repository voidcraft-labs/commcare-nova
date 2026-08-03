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

	return (
		<div className="flex flex-col gap-8">
			<section aria-labelledby="app-setup-organization-heading">
				<h2
					id="app-setup-organization-heading"
					className="text-base font-semibold text-nova-text"
				>
					Organization
				</h2>
				<p className="mt-2 max-w-prose text-[13px] leading-relaxed text-nova-text-secondary">
					The places people work — districts, facilities, and the rest of your
					structure — and which of them own cases. Workers see and receive
					different things depending on where they are assigned.
				</p>
			</section>
			<LevelsSubsection occupiedLevelUuids={occupiedLevelUuids} />
			<PlaceInformationSubsection locations={organization.locations} />
			<PlacesSubsection organization={organization} />
		</div>
	);
}
