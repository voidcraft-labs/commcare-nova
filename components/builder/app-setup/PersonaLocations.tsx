/**
 * Where a persona works.
 *
 * One list rather than a primary field beside a list of others, because
 * CommCare refuses a primary location supplied without its list and requires
 * the primary to be in it — two independent controls could produce a state no
 * push can represent. The first place in the list IS the primary, and saying
 * so once beside it beats a second control that can disagree with the first.
 *
 * Places come from the locations store rather than the document, so this
 * subscribes separately. An app with no organization shows nothing to choose
 * and says where to go instead of rendering an empty picker.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerX from "@iconify-icons/tabler/x";
import { useEffect, useState } from "react";
import { LocationChoiceSelect } from "@/components/builder/LocationChoiceSelect";
import { Button } from "@/components/shadcn/button";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useOrganizationLevelRecord } from "@/lib/doc/hooks/useOrganizationCollections";
import type { Uuid } from "@/lib/doc/types";
import {
	assignedLocationUuids,
	levelHoldsWorkers,
	type Persona,
} from "@/lib/domain";
import { locationChoiceLabel } from "@/lib/organization/locationLabels";
import { personaAssignmentIssue } from "@/lib/organization/ownerTargetVerdicts";
import type { StoredLocation } from "@/lib/organization/types";
import { useCanEdit } from "@/lib/session/hooks";
import { useRemovedRowFocus } from "@/lib/ui/hooks/useRemovedRowFocus";
import {
	PERSONA_LOCATION_PAGE_SIZE,
	personaLocationPage,
} from "./organizationUi";

export function PersonaLocations({
	persona,
	locations,
	loading,
	error,
}: {
	persona: Persona;
	/** Every place in the app, archived included. */
	locations: readonly StoredLocation[];
	loading: boolean;
	error: string | undefined;
}) {
	const canEdit = useCanEdit();
	const mutations = useBlueprintMutations();
	const doc = useBlueprintDoc((state) => state);
	const levels = useOrganizationLevelRecord();
	const assigned = assignedLocationUuids(persona.locations);
	const assignedSet = new Set(assigned);
	const [requestedPage, setRequestedPage] = useState(0);
	const assignedPage = personaLocationPage(assigned, requestedPage);
	const rowFocus = useRemovedRowFocus(assigned.length);
	const byId = new Map<string, StoredLocation>(
		locations.map((location) => [location.id, location]),
	);
	// A worker cannot be assigned to an archived place, so it is not offered —
	// and archiving one already removed the assignments that pointed at it.
	const available = locations.filter(
		(location) =>
			location.archivedAt === null &&
			levels[location.levelUuid] !== undefined &&
			levelHoldsWorkers(levels[location.levelUuid]) &&
			!assignedSet.has(location.id),
	);
	const assignableCount = locations.filter(
		(location) =>
			location.archivedAt === null &&
			levels[location.levelUuid] !== undefined &&
			levelHoldsWorkers(levels[location.levelUuid]),
	).length;

	const set = (next: readonly string[]) =>
		mutations.setPersonaLocations(persona.uuid as Uuid, next);

	useEffect(() => {
		if (requestedPage !== assignedPage.page) {
			setRequestedPage(assignedPage.page);
		}
	}, [assignedPage.page, requestedPage]);

	return (
		<div className="flex flex-col gap-3">
			<h4 className="text-[12px] font-medium text-nova-text-secondary">
				Where they work
			</h4>

			{error !== undefined ? (
				<p role="alert" className="text-[13px] leading-relaxed text-nova-red">
					Places could not be loaded: {error}
				</p>
			) : assignableCount === 0 && assigned.length === 0 ? (
				<p className="text-[13px] leading-relaxed text-nova-text-muted">
					{loading
						? "Loading places…"
						: locations.length === 0
							? "This app has no places yet. Add them in Organization, then assign this persona to one."
							: "No live place is at a level where people work. Change a level in Organization, then assign this persona."}
				</p>
			) : (
				<>
					{assigned.length === 0 ? (
						<p className="text-[13px] leading-relaxed text-nova-text-muted">
							Not assigned anywhere. A worker with no place carries no location
							information at all — the same as an unassigned CommCare worker.
						</p>
					) : (
						<div className="flex flex-col gap-2">
							<ul className="flex flex-col gap-1.5">
								{assignedPage.ids.map((id, pageIndex) => {
									const index = assignedPage.start + pageIndex;
									const location = byId.get(id);
									return (
										<li
											key={id}
											className="flex min-h-11 items-center gap-2.5 rounded-lg border border-nova-border bg-nova-deep px-3 py-1.5"
										>
											<span className="min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere]">
												{location === undefined
													? "A place that no longer exists"
													: locationChoiceLabel(location)}
											</span>
											{index === 0 && (
												<span className="shrink-0 rounded-sm bg-nova-violet/[0.15] px-1.5 py-0.5 text-[11px] text-nova-violet-bright">
													Main
												</span>
											)}
											{canEdit && !loading && (
												<>
													{index > 0 && (
														<Button
															type="button"
															variant="ghost"
															className="min-h-11 shrink-0 px-2 text-[12px]"
															onClick={() => {
																set([
																	id,
																	...assigned.filter((other) => other !== id),
																]);
																setRequestedPage(0);
																rowFocus.focusRow(0);
															}}
														>
															Make main
														</Button>
													)}
													<Button
														ref={rowFocus.register(index)}
														type="button"
														variant="ghost"
														aria-label={`Remove ${location?.name ?? "this place"}`}
														className="size-11 shrink-0 p-0 text-nova-text-muted hover:text-nova-text"
														onClick={() => {
															rowFocus.onRemoved(index);
															set(assigned.filter((other) => other !== id));
														}}
													>
														<Icon
															icon={tablerX}
															width="15"
															height="15"
															aria-hidden="true"
														/>
													</Button>
												</>
											)}
										</li>
									);
								})}
							</ul>
							{assignedPage.pageCount > 1 && (
								<fieldset className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-nova-border px-3 py-2">
									<legend className="sr-only">Assigned place pages</legend>
									<Button
										type="button"
										variant="ghost"
										className="min-h-11 px-2 text-[12px]"
										disabled={assignedPage.page === 0}
										onClick={() =>
											setRequestedPage((current) => Math.max(0, current - 1))
										}
									>
										Previous
									</Button>
									<span
										className="text-[12px] text-nova-text-muted"
										aria-live="polite"
									>
										Places {assignedPage.start + 1}–
										{Math.min(
											assignedPage.start + PERSONA_LOCATION_PAGE_SIZE,
											assigned.length,
										)}{" "}
										of {assigned.length}
									</span>
									<Button
										type="button"
										variant="ghost"
										className="min-h-11 px-2 text-[12px]"
										disabled={assignedPage.page === assignedPage.pageCount - 1}
										onClick={() =>
											setRequestedPage((current) =>
												Math.min(assignedPage.pageCount - 1, current + 1),
											)
										}
									>
										Next
									</Button>
								</fieldset>
							)}
						</div>
					)}

					{canEdit && !loading && available.length > 0 && (
						<LocationChoiceSelect
							locations={available}
							value=""
							onValueChange={(value) => {
								setRequestedPage(
									Math.floor(assigned.length / PERSONA_LOCATION_PAGE_SIZE),
								);
								set([...assigned, value]);
							}}
							ariaLabel="Add a place"
							placeholder="Choose a place"
							triggerRef={rowFocus.addRef}
							className="min-h-11 w-full"
							issueFor={(location) =>
								personaAssignmentIssue(doc, locations, persona.uuid, [
									...assigned,
									location.id,
								])
							}
							triggerContent={
								<span className="flex items-center gap-2 text-[13px] text-nova-violet-bright">
									<Icon
										icon={tablerPlus}
										width="15"
										height="15"
										aria-hidden="true"
									/>
									{assigned.length === 0
										? "Assign a place"
										: "Add another place"}
								</span>
							}
						/>
					)}

					{assigned.length > 1 && (
						<p className="text-[12px] leading-relaxed text-nova-text-muted">
							The main place is the one CommCare reports as this worker's
							primary. They receive cases from every place listed, according to
							what each one's level owns.
						</p>
					)}
				</>
			)}
		</div>
	);
}
