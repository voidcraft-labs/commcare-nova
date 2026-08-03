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
import { useEffect, useMemo, useState } from "react";
import { LocationChoiceSelect } from "@/components/builder/LocationChoiceSelect";
import { Button } from "@/components/shadcn/button";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useOrganizationLevelRecord } from "@/lib/doc/hooks/useOrganizationCollections";
import {
	assignedLocationUuids,
	levelHoldsWorkers,
	type Persona,
} from "@/lib/domain";
import { locationChoiceLabel } from "@/lib/organization/locationLabels";
import {
	personaAssignmentIssue,
	personaAssignmentRemovalIssues,
} from "@/lib/organization/ownerTargetVerdicts";
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
	warning,
	refreshing = false,
	reload,
}: {
	persona: Persona;
	/** Every place in the app, archived included. */
	locations: readonly StoredLocation[];
	loading: boolean;
	error: string | undefined;
	warning?: string;
	refreshing?: boolean;
	reload?: () => void;
}) {
	const canEdit = useCanEdit();
	const mutations = useBlueprintMutations();
	const doc = useBlueprintDoc((state) => state);
	const levels = useOrganizationLevelRecord();
	const assigned = useMemo(
		() => assignedLocationUuids(persona.locations),
		[persona.locations],
	);
	const assignedSet = useMemo(() => new Set(assigned), [assigned]);
	const authoritative =
		!loading && error === undefined && warning === undefined && !refreshing;
	const [requestedPage, setRequestedPage] = useState(0);
	const assignedPage = useMemo(
		() => personaLocationPage(assigned, requestedPage),
		[assigned, requestedPage],
	);
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
	const removalIssues = useMemo(
		() =>
			canEdit && authoritative
				? personaAssignmentRemovalIssues(
						doc,
						locations,
						persona.uuid,
						assigned,
						assignedPage.ids,
					)
				: new Map<string, string>(),
		[
			assigned,
			assignedPage.ids,
			canEdit,
			doc,
			authoritative,
			locations,
			persona.uuid,
		],
	);

	const set = (next: readonly string[]) =>
		mutations.setPersonaLocations(persona.uuid, next);

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
					Places could not be loaded: {error}{" "}
					{reload !== undefined && (
						<Button
							type="button"
							variant="ghost"
							className="min-h-11 px-2 text-[12px] text-nova-violet-bright"
							onClick={reload}
						>
							Try again
						</Button>
					)}
				</p>
			) : loading ? (
				<p className="text-[13px] leading-relaxed text-nova-text-muted">
					Loading places…
				</p>
			) : assignableCount === 0 && assigned.length === 0 ? (
				<p className="text-[13px] leading-relaxed text-nova-text-muted">
					{locations.length === 0
						? "This app has no places yet. Add them in Organization, then assign this persona to one."
						: "No live place is at a level where people work. Change a level in Organization, then assign this persona."}
				</p>
			) : (
				<>
					{warning !== undefined && (
						<p
							role="status"
							className="rounded-lg border border-nova-amber/40 bg-nova-amber/[0.06] px-3 py-2 text-[12px] leading-relaxed text-nova-text-secondary"
						>
							Saved places could not be refreshed, so assignments are paused.{" "}
							{warning}{" "}
							{reload !== undefined && (
								<Button
									type="button"
									variant="ghost"
									className="min-h-11 px-2 text-[12px] text-nova-violet-bright"
									onClick={reload}
								>
									Try again
								</Button>
							)}
						</p>
					)}
					{refreshing && warning === undefined && (
						<p role="status" className="text-[12px] text-nova-text-muted">
							Refreshing places…
						</p>
					)}
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
									const withoutLocation = assigned.filter(
										(other) => other !== id,
									);
									const removalIssue = removalIssues.get(id);
									const removalIssueId = `persona-location-removal-${persona.uuid}-${id}`;
									return (
										<li
											key={id}
											ref={rowFocus.register(index)}
											tabIndex={-1}
											className="nova-focusable-inset flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-nova-border bg-nova-deep px-3 py-1.5"
										>
											<span className="min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere]">
												{location === undefined
													? authoritative
														? "A place that no longer exists"
														: "Refreshing assigned place"
													: locationChoiceLabel(location)}
											</span>
											{index === 0 && (
												<span className="shrink-0 rounded-sm bg-nova-violet/[0.15] px-1.5 py-0.5 text-[11px] text-nova-violet-bright">
													Main
												</span>
											)}
											{canEdit && authoritative && (
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
														type="button"
														variant="ghost"
														aria-label={`Remove ${location === undefined ? "this place" : locationChoiceLabel(location)}`}
														aria-describedby={
															removalIssue === undefined
																? undefined
																: removalIssueId
														}
														className="size-11 shrink-0 p-0 text-nova-text-muted hover:text-nova-text"
														disabled={removalIssue !== undefined}
														onClick={() => {
															rowFocus.onRemoved(index);
															set(withoutLocation);
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
											{removalIssue !== undefined && (
												<p
													id={removalIssueId}
													className="w-full text-[12px] leading-relaxed text-nova-red"
												>
													Keep this assignment: {removalIssue}
												</p>
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

					{canEdit && authoritative && available.length > 0 && (
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
							primary. These assignments establish intended case delivery and
							already supply Preview's location identity; Preview case lists do
							not yet filter by that delivery scope.
						</p>
					)}
				</>
			)}
		</div>
	);
}
