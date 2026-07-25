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
import { Button } from "@/components/shadcn/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { Uuid } from "@/lib/doc/types";
import { assignedLocationUuids, type Persona } from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import { useCanEdit } from "@/lib/session/hooks";

export function PersonaLocations({
	persona,
	locations,
	loading,
}: {
	persona: Persona;
	/** Every place in the app, archived included. */
	locations: readonly StoredLocation[];
	loading: boolean;
}) {
	const canEdit = useCanEdit();
	const mutations = useBlueprintMutations();
	const assigned = assignedLocationUuids(persona.locations);
	const byId = new Map(locations.map((location) => [location.id, location]));
	// A worker cannot be assigned to an archived place, so it is not offered —
	// and archiving one already removed the assignments that pointed at it.
	const available = locations.filter(
		(location) =>
			location.archivedAt === null && !assigned.includes(location.id),
	);

	const set = (next: readonly string[]) =>
		mutations.setPersonaLocations(persona.uuid as Uuid, next);

	return (
		<div className="flex flex-col gap-3">
			<h4 className="text-[12px] font-medium text-nova-text-secondary">
				Where they work
			</h4>

			{locations.length === 0 ? (
				<p className="text-[13px] leading-relaxed text-nova-text-muted">
					{loading
						? "Loading places…"
						: "This app has no places yet. Add them in Organization, then assign this persona to one."}
				</p>
			) : (
				<>
					{assigned.length === 0 ? (
						<p className="text-[13px] leading-relaxed text-nova-text-muted">
							Not assigned anywhere. A worker with no place carries no location
							information at all — the same as an unassigned CommCare worker.
						</p>
					) : (
						<ul className="flex flex-col gap-1.5">
							{assigned.map((id, index) => {
								const location = byId.get(id);
								return (
									<li
										key={id}
										className="flex min-h-11 items-center gap-2.5 rounded-lg border border-nova-border bg-nova-deep px-3 py-1.5"
									>
										<span className="min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere]">
											{location?.name ?? "A place that no longer exists"}
										</span>
										{index === 0 && (
											<span className="shrink-0 rounded-sm bg-nova-violet/[0.15] px-1.5 py-0.5 text-[11px] text-nova-violet-bright">
												Main
											</span>
										)}
										{canEdit && (
											<>
												{index > 0 && (
													<Button
														type="button"
														variant="ghost"
														size="sm"
														className="h-9 shrink-0 px-2 text-[12px]"
														onClick={() =>
															set([
																id,
																...assigned.filter((other) => other !== id),
															])
														}
													>
														Make main
													</Button>
												)}
												<Button
													type="button"
													variant="ghost"
													size="sm"
													aria-label={`Remove ${location?.name ?? "this place"}`}
													className="size-9 shrink-0 p-0 text-nova-text-muted hover:text-nova-text"
													onClick={() =>
														set(assigned.filter((other) => other !== id))
													}
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
					)}

					{canEdit && available.length > 0 && (
						<Select
							value=""
							onValueChange={(value) => {
								if (typeof value !== "string" || value === "") return;
								set([...assigned, value]);
							}}
						>
							<SelectTrigger
								aria-label="Add a place"
								className="min-h-11 w-full"
							>
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
								<SelectValue className="sr-only" />
							</SelectTrigger>
							<SelectContent>
								{available.map((location) => (
									<SelectItem key={location.id} value={location.id}>
										{location.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
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
