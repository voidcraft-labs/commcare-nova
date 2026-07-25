/**
 * Places — the organization's contents.
 *
 * These are not blueprint entities and this subsection is the one surface in
 * App setup that talks to a different store: places are app-scoped Postgres
 * rows, read as one snapshot with a revision. Two people editing the same
 * organization get a refusal naming the current revision rather than a
 * last-write-wins clobber, and the refusal is what prompts a re-read.
 *
 * The tree renders as indented rows rather than a nested list, because a
 * flat list with depth is what stays legible at 320px — and because every
 * row needs the same actions at the same place regardless of depth.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerArchive from "@iconify-icons/tabler/archive";
import tablerArchiveOff from "@iconify-icons/tabler/archive-off";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { Label } from "@/components/shadcn/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { Spinner } from "@/components/shadcn/spinner";
import { useOrganizationLevels } from "@/lib/doc/hooks/useOrganizationCollections";
import { levelMayNestUnder, type OrganizationLevel } from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import type { useOrganization } from "@/lib/organization/useOrganization";
import { useCanEdit } from "@/lib/session/hooks";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { EntryRow, Subsection, SubsectionEmpty } from "./subsection";

type Organization = ReturnType<typeof useOrganization>;

/** One row plus its depth, in the order the tree reads top to bottom. */
interface TreeRow {
	readonly location: StoredLocation;
	readonly depth: number;
}

function flatten(locations: readonly StoredLocation[]): TreeRow[] {
	const childrenOf = new Map<string | null, StoredLocation[]>();
	for (const location of locations) {
		const siblings = childrenOf.get(location.parentId);
		if (siblings === undefined) childrenOf.set(location.parentId, [location]);
		else siblings.push(location);
	}
	const rows: TreeRow[] = [];
	const seen = new Set<string>();
	const walk = (parentId: string | null, depth: number) => {
		for (const location of childrenOf.get(parentId) ?? []) {
			// A cycle is unreachable through the store's own rules, but this walk
			// also runs over rows an operator may have repaired by hand.
			if (seen.has(location.id)) continue;
			seen.add(location.id);
			rows.push({ location, depth });
			walk(location.id, depth + 1);
		}
	};
	walk(null, 0);
	// Anything the walk could not reach from a root still belongs on screen —
	// hiding a row because its parent is missing would make it unfixable.
	for (const location of locations) {
		if (!seen.has(location.id)) rows.push({ location, depth: 0 });
	}
	return rows;
}

export function PlacesSubsection({
	organization,
}: {
	organization: Organization;
}) {
	const levels = useOrganizationLevels();
	const canEdit = useCanEdit();
	const [openId, setOpenId] = useState<string | undefined>(undefined);
	const [adding, setAdding] = useState(false);
	const [message, setMessage] = useState<string | undefined>(undefined);

	const rows = flatten(organization.locations);

	if (levels.length === 0) {
		return (
			<Subsection
				id="app-setup-places"
				title="Places"
				description="The districts, facilities, and wards themselves — the organization's contents."
				addLabel="Add place"
				onAdd={() => undefined}
				canEdit={false}
			>
				<SubsectionEmpty>
					Add a level first. A place has to stand at one of them.
				</SubsectionEmpty>
			</Subsection>
		);
	}

	return (
		<Subsection
			id="app-setup-places"
			title="Places"
			description="The districts, facilities, and wards themselves. Unlike levels, these are data — you can add thousands, and later push them to CommCare."
			addLabel="Add place"
			onAdd={() => setAdding(true)}
			canEdit={canEdit && !adding}
		>
			{organization.loading ? (
				<p className="flex items-center gap-2 px-3 py-4 text-[13px] text-nova-text-muted">
					<Spinner className="size-4" />
					Loading places…
				</p>
			) : organization.error !== undefined ? (
				<p
					role="alert"
					className="rounded-lg border border-nova-red/40 bg-nova-red/[0.06] px-3 py-3 text-[13px] leading-relaxed text-nova-text"
				>
					{organization.error}{" "}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-9 px-2 text-[12px] text-nova-violet-bright hover:bg-nova-violet/[0.12] hover:text-nova-violet-bright"
						onClick={organization.reload}
					>
						Try again
					</Button>
				</p>
			) : rows.length === 0 && !adding ? (
				<SubsectionEmpty>
					No places yet. Add the first one at your top level, then build
					downward.
				</SubsectionEmpty>
			) : (
				rows.map(({ location, depth }) => (
					<div
						key={location.id}
						style={{ marginInlineStart: `${Math.min(depth, 6) * 16}px` }}
					>
						<PlaceRow
							location={location}
							levels={levels}
							organization={organization}
							open={openId === location.id}
							onOpenChange={(next) => setOpenId(next ? location.id : undefined)}
						/>
					</div>
				))
			)}

			{adding && (
				<AddPlaceForm
					levels={levels}
					locations={organization.locations}
					onCancel={() => setAdding(false)}
					onSubmit={async (input) => {
						const result = await organization.create(input);
						if (result.ok) {
							setAdding(false);
							setMessage(undefined);
							if (result.id !== undefined) setOpenId(result.id);
							return;
						}
						setMessage(result.message);
					}}
				/>
			)}

			{message !== undefined && (
				<p
					role="alert"
					className="max-w-prose text-[12px] leading-relaxed text-nova-red"
				>
					{message}
				</p>
			)}
		</Subsection>
	);
}

function levelName(levels: readonly OrganizationLevel[], uuid: string): string {
	return levels.find((level) => level.uuid === uuid)?.name ?? "Unknown level";
}

function PlaceRow({
	location,
	levels,
	organization,
	open,
	onOpenChange,
}: {
	location: StoredLocation;
	levels: readonly OrganizationLevel[];
	organization: Organization;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const canEdit = useCanEdit();
	const nameId = useId();
	const externalId = useId();
	const [draftName, setDraftName] = useState(location.name);
	const [message, setMessage] = useState<string | undefined>(undefined);
	const archived = location.archivedAt !== null;

	return (
		<EntryRow
			summary={
				<span className={archived ? "text-nova-text-muted" : undefined}>
					{location.name}
					{archived && (
						<span className="ml-2 rounded-sm bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-nova-text-muted">
							Archived
						</span>
					)}
				</span>
			}
			detail={levelName(levels, location.levelUuid)}
			open={open}
			onOpenChange={onOpenChange}
		>
			<div className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={nameId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Name
					</Label>
					<Input
						id={nameId}
						value={draftName}
						autoComplete="off"
						data-1p-ignore
						disabled={!canEdit || archived}
						onChange={(e) => setDraftName(e.target.value)}
						onBlur={async () => {
							if (draftName === location.name) return;
							const result = await organization.update(location.id, {
								name: draftName,
							});
							if (!result.ok) {
								setDraftName(location.name);
								setMessage(result.message);
							}
						}}
					/>
					<p className="text-[12px] text-nova-text-muted">
						Code{" "}
						<code className="text-nova-text-secondary">
							{location.siteCode}
						</code>{" "}
						— fixed when the place was created, because bulk uploads and
						CommCare identify it by that code.
					</p>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={externalId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Id in another system
					</Label>
					<Input
						id={externalId}
						value={location.externalId ?? ""}
						autoComplete="off"
						data-1p-ignore
						disabled={!canEdit || archived}
						onChange={() => undefined}
						onBlur={async (e) => {
							const next = e.target.value;
							if (next === (location.externalId ?? "")) return;
							await organization.update(location.id, {
								externalId: next === "" ? null : next,
							});
						}}
					/>
				</div>

				{canEdit && (
					<ArchivePlace
						location={location}
						organization={organization}
						onMessage={setMessage}
					/>
				)}

				{message !== undefined && (
					<p
						role="alert"
						className="max-w-prose text-[12px] leading-relaxed text-nova-red"
					>
						{message}
					</p>
				)}
			</div>
		</EntryRow>
	);
}

/**
 * Archiving, confirmed in place with the consequences read from the server
 * rather than guessed.
 *
 * Three things are stated because three things actually happen: the subtree
 * goes with it, personas standing there stop working there, and cases owned
 * there stay put and stop reaching anyone. That last one has no undo, so it
 * is the sentence the confirmation leads with when the count is non-zero.
 */
function ArchivePlace({
	location,
	organization,
	onMessage,
}: {
	location: StoredLocation;
	organization: Organization;
	onMessage: (message: string | undefined) => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const [impact, setImpact] = useState<
		| { locations: number; personas: readonly string[]; cases: number }
		| undefined
	>(undefined);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);
	const archived = location.archivedAt !== null;

	if (archived) {
		return (
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="h-9 gap-2 self-start px-2.5 text-[12px]"
				onClick={async () => {
					const result = await organization.setArchived(location.id, false);
					if (!result.ok) onMessage(result.message);
				}}
			>
				<Icon
					icon={tablerArchiveOff}
					width="15"
					height="15"
					aria-hidden="true"
				/>
				Bring back
			</Button>
		);
	}

	if (!confirming) {
		return (
			<Button
				ref={triggerRef}
				type="button"
				variant="ghost"
				size="sm"
				className="h-9 gap-2 self-start px-2.5 text-[12px] text-nova-red hover:bg-nova-red/[0.12] hover:text-nova-red"
				onClick={async () => {
					onMessage(undefined);
					setImpact(undefined);
					setConfirming(true);
					const described = await organization.describeArchive(location.id);
					if (described !== undefined) {
						setImpact({
							locations: described.locationIds.length,
							personas: described.unassignedPersonas,
							cases: described.ownedCases,
						});
					}
				}}
			>
				<Icon icon={tablerArchive} width="15" height="15" aria-hidden="true" />
				Archive
			</Button>
		);
	}

	return (
		<div
			ref={panelRef}
			tabIndex={-1}
			className="flex flex-col gap-2.5 rounded-lg border border-nova-amber/40 bg-nova-amber/[0.06] p-3 outline-none"
		>
			<p className="text-[13px] leading-relaxed text-nova-text">
				Archive “{location.name}”?
			</p>
			{impact === undefined ? (
				<p className="flex items-center gap-2 text-[12px] text-nova-text-muted">
					<Spinner className="size-3.5" />
					Checking what this affects…
				</p>
			) : (
				<ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] leading-relaxed text-nova-text-secondary">
					{impact.locations > 1 && (
						<li>
							{impact.locations} places are archived — this one and everything
							under it.
						</li>
					)}
					{impact.personas.length > 0 && (
						<li>
							{impact.personas.join(", ")} stop working there. Their next
							remaining place becomes their main one.
						</li>
					)}
					{impact.cases > 0 && (
						<li className="text-nova-amber">
							{impact.cases} {impact.cases === 1 ? "case is" : "cases are"}{" "}
							owned here and will stop reaching anyone. Nothing moves them —
							bringing the place back is what makes them reachable again.
						</li>
					)}
					<li>Archiving is reversible. You can bring the place back.</li>
				</ul>
			)}
			<div className="flex gap-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-9 px-2.5 text-[12px] text-nova-red hover:bg-nova-red/[0.12] hover:text-nova-red"
					onClick={async () => {
						setConfirming(false);
						const result = await organization.setArchived(location.id, true);
						if (!result.ok) onMessage(result.message);
					}}
				>
					Archive
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-9 px-2.5 text-[12px]"
					onClick={() => setConfirming(false)}
				>
					Keep it
				</Button>
			</div>
		</div>
	);
}

/** Adding a place: its level, where it sits, and its name. */
function AddPlaceForm({
	levels,
	locations,
	onCancel,
	onSubmit,
}: {
	levels: readonly OrganizationLevel[];
	locations: readonly StoredLocation[];
	onCancel: () => void;
	onSubmit: (input: {
		levelUuid: string;
		parentId: string | null;
		name: string;
		externalId: null;
		latitude: null;
		longitude: null;
		values: Record<string, string>;
	}) => Promise<void>;
}) {
	const nameId = useId();
	const levelId = useId();
	const parentId = useId();
	const [levelUuid, setLevelUuid] = useState(levels[0]?.uuid ?? "");
	const [parent, setParent] = useState<string>("");
	const [name, setName] = useState("");

	const levelRecord = Object.fromEntries(levels.map((l) => [l.uuid, l]));
	// Only places whose level is strictly above the chosen one can hold it —
	// the same predicate the store enforces, so nothing offered here is
	// refused there.
	const parentOptions = locations.filter(
		(candidate) =>
			candidate.archivedAt === null &&
			levelMayNestUnder(levelUuid, candidate.levelUuid, levelRecord),
	);
	const needsParent = levelRecord[levelUuid]?.parentLevelUuid !== undefined;

	return (
		<div className="flex flex-col gap-3 rounded-lg border border-nova-border bg-nova-deep p-3">
			<div className="flex flex-col gap-1.5">
				<Label
					htmlFor={nameId}
					className="text-[12px] font-medium text-nova-text-secondary"
				>
					Name
				</Label>
				<Input
					id={nameId}
					value={name}
					autoComplete="off"
					data-1p-ignore
					placeholder="Mercy Clinic"
					onChange={(e) => setName(e.target.value)}
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label
					htmlFor={levelId}
					className="text-[12px] font-medium text-nova-text-secondary"
				>
					Level
				</Label>
				<Select
					value={levelUuid}
					onValueChange={(value) => {
						if (typeof value !== "string") return;
						setLevelUuid(value);
						setParent("");
					}}
				>
					<SelectTrigger id={levelId} className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{levels.map((level) => (
							<SelectItem key={level.uuid} value={level.uuid}>
								{level.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{needsParent && (
				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={parentId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Sits in
					</Label>
					<Select
						value={parent}
						onValueChange={(value) => {
							if (typeof value === "string") setParent(value);
						}}
					>
						<SelectTrigger id={parentId} className="w-full">
							<SelectValue placeholder="Choose a place" />
						</SelectTrigger>
						<SelectContent>
							{parentOptions.map((candidate) => (
								<SelectItem key={candidate.id} value={candidate.id}>
									{candidate.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{parentOptions.length === 0 && (
						<p className="text-[12px] leading-relaxed text-nova-text-muted">
							Nothing can hold a {levelRecord[levelUuid]?.name.toLowerCase()}{" "}
							yet. Add a place at a level above it first.
						</p>
					)}
				</div>
			)}
			<div className="flex gap-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-9 gap-2 px-2.5 text-[12px] text-nova-violet-bright hover:bg-nova-violet/[0.12] hover:text-nova-violet-bright"
					disabled={
						name.trim() === "" ||
						levelUuid === "" ||
						(needsParent && parent === "")
					}
					onClick={() =>
						void onSubmit({
							levelUuid,
							parentId: needsParent ? parent : null,
							name: name.trim(),
							externalId: null,
							latitude: null,
							longitude: null,
							values: {},
						})
					}
				>
					<Icon icon={tablerPlus} width="15" height="15" aria-hidden="true" />
					Add place
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-9 px-2.5 text-[12px]"
					onClick={onCancel}
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}
