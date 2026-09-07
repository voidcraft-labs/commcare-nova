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
import { builderWriteAdmission } from "@/lib/doc/builderWriteAdmission";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useOrganizationRuleInputs } from "@/lib/doc/hooks/useOrganizationCollections";
import { useLookupCommitState } from "@/lib/doc/lookupCommitContext";
import type { Persona } from "@/lib/domain";
import { locationChoiceLabel } from "@/lib/organization/locationLabels";
import { personaAssignmentIssue } from "@/lib/organization/ownerTargetVerdicts";
import type { StoredLocation } from "@/lib/organization/types";
import { useCanEdit } from "@/lib/session/hooks";
import { useRemovedRowFocus } from "@/lib/ui/hooks/useRemovedRowFocus";
import { PERSONA_LOCATION_PAGE_SIZE } from "./organizationUi";
import {
	type PersonaLocationChange,
	personaLocationEditor,
	planPersonaLocationChange,
} from "./personaLocationEditor";

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
	const lookupCommitState = useLookupCommitState();
	const canWrite = builderWriteAdmission({ canEdit, lookupCommitState }).ok;
	const mutations = useBlueprintMutations();
	const doc = useOrganizationRuleInputs();
	const [requestedPage, setRequestedPage] = useState(0);
	const inputs = useMemo(
		() => ({
			doc,
			persona,
			locations,
			loading,
			error,
			warning,
			refreshing,
			canEdit,
			requestedPage,
		}),
		[
			doc,
			persona,
			locations,
			loading,
			error,
			warning,
			refreshing,
			canEdit,
			requestedPage,
		],
	);
	const {
		assigned,
		assignedPage,
		authoritative,
		available,
		rows,
		removalIssues,
		emptyMessage,
	} = useMemo(() => personaLocationEditor(inputs), [inputs]);
	const rowFocus = useRemovedRowFocus(assigned.length);
	const changeAssignment = (change: PersonaLocationChange) => {
		if (!canWrite) return;
		const planned = planPersonaLocationChange(inputs, change);
		if (planned === undefined) return;
		if (planned.removedIndex !== undefined)
			rowFocus.onRemoved(planned.removedIndex);
		const result = mutations.setPersonaLocations(persona.uuid, planned.ids);
		if (!result.ok) return;
		setRequestedPage(planned.page);
		if (planned.focusIndex !== undefined) rowFocus.focusRow(planned.focusIndex);
	};

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
						<Button type="button" variant="ghost-action" onClick={reload}>
							Try again
						</Button>
					)}
				</p>
			) : loading ? (
				<p className="text-[13px] leading-relaxed text-nova-text-muted">
					Loading places…
				</p>
			) : emptyMessage !== undefined ? (
				<p className="text-[13px] leading-relaxed text-nova-text-muted">
					{emptyMessage}
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
								<Button type="button" variant="ghost-action" onClick={reload}>
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
							Not assigned to a place. This persona has no location information
							in Preview.
						</p>
					) : (
						<div className="flex flex-col gap-2">
							<ul className="flex flex-col gap-1.5">
								{rows.map(({ id, index, location, label }) => {
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
												{label}
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
															disabled={!canWrite}
															className="shrink-0"
															onClick={() => {
																changeAssignment({ kind: "main", id });
															}}
														>
															Make main
														</Button>
													)}
													<Button
														type="button"
														variant="ghost"
														size="icon"
														aria-label={`Remove ${location === undefined ? "this place" : locationChoiceLabel(location)}`}
														aria-describedby={
															removalIssue === undefined
																? undefined
																: removalIssueId
														}
														className="shrink-0"
														disabled={!canWrite || removalIssue !== undefined}
														onClick={() => {
															changeAssignment({ kind: "remove", id });
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
							disabled={!canWrite}
							locations={available}
							value=""
							onValueChange={(value) => {
								changeAssignment({ kind: "add", id: value });
							}}
							ariaLabel="Add a place"
							placeholder="Choose a place"
							triggerRef={rowFocus.addRef}
							className="w-full"
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
							The first place is this persona's main place. All assigned places
							are available in Preview.
						</p>
					)}
				</>
			)}
		</div>
	);
}
