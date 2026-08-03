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
import { useEffect, useId, useRef, useState } from "react";
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
import {
	useLocationProperties,
	useOrganizationLevels,
} from "@/lib/doc/hooks/useOrganizationCollections";
import {
	type LocationProperty,
	levelMayNestUnder,
	type OrganizationLevel,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import type { useOrganization } from "@/lib/organization/useOrganization";
import { useCanEdit } from "@/lib/session/hooks";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import {
	propertiesForLevel,
	requiredValuesPresent,
	valuesForLevel,
} from "./organizationUi";
import { EntryRow, Subsection, SubsectionEmpty } from "./subsection";

type Organization = ReturnType<typeof useOrganization>;
const FIRST_POSITION = "__first__";
const END_POSITION = "__end__";

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
	const properties = useLocationProperties();
	const canEdit = useCanEdit();
	const [openId, setOpenId] = useState<string | undefined>(undefined);
	const [adding, setAdding] = useState(false);
	const [message, setMessage] = useState<string | undefined>(undefined);
	const authoritative =
		!organization.loading && organization.error === undefined;

	useEffect(() => {
		if (canEdit) return;
		setAdding(false);
	}, [canEdit]);

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
			canEdit={canEdit && authoritative && !adding}
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
						className="min-h-11 px-2 text-[12px] text-nova-violet-bright hover:bg-nova-violet/[0.12] hover:text-nova-violet-bright"
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
							properties={properties}
							locations={organization.locations}
							organization={organization}
							open={openId === location.id}
							onOpenChange={(next) => setOpenId(next ? location.id : undefined)}
						/>
					</div>
				))
			)}

			{adding && canEdit && authoritative && (
				<AddPlaceForm
					levels={levels}
					properties={properties}
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

function descendantIds(
	locations: readonly StoredLocation[],
	rootId: string,
): ReadonlySet<string> {
	const children = new Map<string, string[]>();
	for (const location of locations) {
		if (location.parentId === null) continue;
		const current = children.get(location.parentId);
		if (current === undefined) children.set(location.parentId, [location.id]);
		else current.push(location.id);
	}
	const descendants = new Set<string>();
	const pending = [...(children.get(rootId) ?? [])];
	while (pending.length > 0) {
		const id = pending.pop();
		if (id === undefined || descendants.has(id)) continue;
		descendants.add(id);
		pending.push(...(children.get(id) ?? []));
	}
	return descendants;
}

function sameStoredLocation(
	left: StoredLocation,
	right: StoredLocation,
): boolean {
	return (
		left.id === right.id &&
		left.levelUuid === right.levelUuid &&
		left.parentId === right.parentId &&
		left.siteCode === right.siteCode &&
		left.name === right.name &&
		left.externalId === right.externalId &&
		left.latitude === right.latitude &&
		left.longitude === right.longitude &&
		String(left.archivedAt) === String(right.archivedAt) &&
		left.orderKey === right.orderKey &&
		JSON.stringify(left.values) === JSON.stringify(right.values)
	);
}

function PlaceRow({
	location,
	levels,
	properties,
	locations,
	organization,
	open,
	onOpenChange,
}: {
	location: StoredLocation;
	levels: readonly OrganizationLevel[];
	properties: readonly LocationProperty[];
	locations: readonly StoredLocation[];
	organization: Organization;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const canEdit = useCanEdit();
	const nameId = useId();
	const externalId = useId();
	const latitudeId = useId();
	const longitudeId = useId();
	const levelId = useId();
	const positionId = useId();
	const [draftName, setDraftName] = useState(location.name);
	const [draftExternalId, setDraftExternalId] = useState(
		location.externalId ?? "",
	);
	const [draftValues, setDraftValues] = useState<Record<string, string>>(
		valuesForLevel(properties, location.levelUuid, location.values),
	);
	const [draftLatitude, setDraftLatitude] = useState(location.latitude ?? "");
	const [draftLongitude, setDraftLongitude] = useState(
		location.longitude ?? "",
	);
	const [draftLevelUuid, setDraftLevelUuid] = useState<string>(
		location.levelUuid,
	);
	const [message, setMessage] = useState<string | undefined>(undefined);
	const [dirtyName, setDirtyName] = useState(false);
	const [dirtyExternalId, setDirtyExternalId] = useState(false);
	const [dirtyValues, setDirtyValues] = useState(false);
	const [dirtyLatitude, setDirtyLatitude] = useState(false);
	const [dirtyLongitude, setDirtyLongitude] = useState(false);
	const [dirtyLevel, setDirtyLevel] = useState(false);
	const [peerChanged, setPeerChanged] = useState(false);
	const sourceRef = useRef(location);
	const archived = location.archivedAt !== null;
	const applicableProperties = propertiesForLevel(properties, draftLevelUuid);
	const level = levels.find(
		(candidate) => candidate.uuid === location.levelUuid,
	);
	const levelRecord = Object.fromEntries(
		levels.map((candidate) => [candidate.uuid, candidate]),
	);
	const parent =
		location.parentId === null
			? undefined
			: locations.find((candidate) => candidate.id === location.parentId);
	const hasChildren = locations.some(
		(candidate) => candidate.parentId === location.id,
	);
	const retypeOptions = levels.filter(
		(candidate) =>
			candidate.uuid === location.levelUuid ||
			(!hasChildren &&
				(location.parentId === null
					? candidate.parentLevelUuid === undefined
					: parent !== undefined &&
						levelMayNestUnder(candidate.uuid, parent.levelUuid, levelRecord))),
	);
	const siblings = locations.filter(
		(candidate) =>
			candidate.parentId === location.parentId && candidate.id !== location.id,
	);
	const siblingOrder = locations.filter(
		(candidate) => candidate.parentId === location.parentId,
	);
	const ownIndex = siblingOrder.findIndex(
		(candidate) => candidate.id === location.id,
	);
	const previousSibling = ownIndex > 0 ? siblingOrder[ownIndex - 1] : undefined;
	const positionValue =
		ownIndex === 0
			? FIRST_POSITION
			: ownIndex === siblingOrder.length - 1
				? END_POSITION
				: (previousSibling?.id ?? FIRST_POSITION);
	const descendants = descendantIds(locations, location.id);
	const parentOptions = locations.filter(
		(candidate) =>
			candidate.archivedAt === null &&
			!descendants.has(candidate.id) &&
			candidate.id !== location.id &&
			levelMayNestUnder(
				location.levelUuid,
				candidate.levelUuid,
				Object.fromEntries(
					levels.map((candidateLevel) => [candidateLevel.uuid, candidateLevel]),
				),
			),
	);

	useEffect(() => {
		if (
			dirtyName ||
			dirtyExternalId ||
			dirtyValues ||
			dirtyLatitude ||
			dirtyLongitude ||
			dirtyLevel
		) {
			if (!sameStoredLocation(sourceRef.current, location))
				setPeerChanged(true);
			return;
		}
		setDraftName(location.name);
		setDraftExternalId(location.externalId ?? "");
		setDraftLatitude(location.latitude ?? "");
		setDraftLongitude(location.longitude ?? "");
		setDraftLevelUuid(location.levelUuid);
		setDraftValues(
			valuesForLevel(properties, location.levelUuid, location.values),
		);
		sourceRef.current = location;
		setPeerChanged(false);
	}, [
		location,
		properties,
		dirtyName,
		dirtyExternalId,
		dirtyValues,
		dirtyLatitude,
		dirtyLongitude,
		dirtyLevel,
	]);

	const adoptLatest = () => {
		setDraftName(location.name);
		setDraftExternalId(location.externalId ?? "");
		setDraftLatitude(location.latitude ?? "");
		setDraftLongitude(location.longitude ?? "");
		setDraftLevelUuid(location.levelUuid);
		setDraftValues(
			valuesForLevel(properties, location.levelUuid, location.values),
		);
		setDirtyName(false);
		setDirtyExternalId(false);
		setDirtyValues(false);
		setDirtyLatitude(false);
		setDirtyLongitude(false);
		setDirtyLevel(false);
		setPeerChanged(false);
		setMessage(undefined);
		sourceRef.current = location;
	};

	const saveValues = async (next: Record<string, string>) => {
		const filtered = valuesForLevel(properties, draftLevelUuid, next);
		setDraftValues(filtered);
		setDirtyValues(true);
		if (dirtyLevel) return;
		if (peerChanged) {
			setMessage(
				"This place changed while you were editing. Use the latest saved values before saving your draft.",
			);
			return;
		}
		const result = await organization.update(location.id, { values: filtered });
		if (!result.ok) {
			setMessage(result.message);
		} else {
			setDirtyValues(false);
			setMessage(undefined);
		}
	};

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
				{peerChanged && (
					<div
						role="alert"
						className="rounded-lg border border-nova-amber/40 bg-nova-amber/[0.06] p-3 text-[12px] leading-relaxed text-nova-text-secondary"
					>
						This place changed while you were editing. Your draft is still here.
						<Button
							type="button"
							variant="ghost"
							className="ml-2 min-h-11 px-2 text-[12px] text-nova-violet-bright"
							onClick={adoptLatest}
						>
							Use latest saved values
						</Button>
					</div>
				)}
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
						onChange={(e) => {
							setDraftName(e.target.value);
							setDirtyName(true);
						}}
						onBlur={async () => {
							if (draftName === location.name) {
								setDirtyName(false);
								return;
							}
							if (peerChanged) {
								setMessage(
									"This place changed while you were editing. Use the latest saved values before saving your draft.",
								);
								return;
							}
							const result = await organization.update(location.id, {
								name: draftName,
							});
							if (!result.ok) {
								setMessage(result.message);
							} else {
								setDirtyName(false);
								setMessage(undefined);
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
						value={draftExternalId}
						autoComplete="off"
						data-1p-ignore
						disabled={!canEdit || archived}
						onChange={(event) => {
							setDraftExternalId(event.target.value);
							setDirtyExternalId(true);
						}}
						onBlur={async (e) => {
							const next = e.target.value;
							if (next === (location.externalId ?? "")) {
								setDirtyExternalId(false);
								return;
							}
							if (peerChanged) {
								setMessage(
									"This place changed while you were editing. Use the latest saved values before saving your draft.",
								);
								return;
							}
							const result = await organization.update(location.id, {
								externalId: next === "" ? null : next,
							});
							if (!result.ok) {
								setMessage(result.message);
							} else {
								setDirtyExternalId(false);
								setMessage(undefined);
							}
						}}
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
						value={draftLevelUuid}
						disabled={!canEdit || archived || hasChildren || peerChanged}
						onValueChange={(value) => {
							if (typeof value !== "string") return;
							setDraftLevelUuid(value);
							const nextValues = valuesForLevel(properties, value, draftValues);
							setDraftValues(nextValues);
							setDirtyLevel(value !== location.levelUuid);
							setDirtyValues(
								JSON.stringify(nextValues) !==
									JSON.stringify(
										valuesForLevel(
											properties,
											location.levelUuid,
											location.values,
										),
									),
							);
						}}
					>
						<SelectTrigger id={levelId} className="w-full">
							<SelectValue>{levelName(levels, draftLevelUuid)}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{retypeOptions.map((candidate) => (
								<SelectItem key={candidate.uuid} value={candidate.uuid}>
									{candidate.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{hasChildren && (
						<p className="text-[12px] leading-relaxed text-nova-text-muted">
							A place with other places under it keeps its level. Move or
							archive those places before changing this one.
						</p>
					)}
					{dirtyLevel && (
						<Button
							type="button"
							variant="ghost"
							className="min-h-11 self-start px-2.5 text-[12px] text-nova-violet-bright"
							disabled={
								peerChanged ||
								!requiredValuesPresent(properties, draftLevelUuid, draftValues)
							}
							onClick={async () => {
								const result = await organization.update(location.id, {
									levelUuid: draftLevelUuid,
									values: valuesForLevel(
										properties,
										draftLevelUuid,
										draftValues,
									),
								});
								if (!result.ok) setMessage(result.message);
								else {
									setDirtyLevel(false);
									setDirtyValues(false);
									setMessage(undefined);
								}
							}}
						>
							Apply level change
						</Button>
					)}
				</div>

				<div className="grid gap-3 @sm:grid-cols-2">
					<div className="flex flex-col gap-1.5">
						<Label
							htmlFor={latitudeId}
							className="text-[12px] font-medium text-nova-text-secondary"
						>
							Latitude
						</Label>
						<Input
							id={latitudeId}
							value={draftLatitude}
							inputMode="decimal"
							disabled={!canEdit || archived}
							onChange={(event) => {
								setDraftLatitude(event.target.value);
								setDirtyLatitude(true);
							}}
							onBlur={async () => {
								if (draftLatitude === (location.latitude ?? "")) {
									setDirtyLatitude(false);
									return;
								}
								if (peerChanged) {
									setMessage(
										"This place changed while you were editing. Use the latest saved values before saving your draft.",
									);
									return;
								}
								const result = await organization.update(location.id, {
									latitude: draftLatitude === "" ? null : draftLatitude,
								});
								if (!result.ok) setMessage(result.message);
								else {
									setDirtyLatitude(false);
									setMessage(undefined);
								}
							}}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label
							htmlFor={longitudeId}
							className="text-[12px] font-medium text-nova-text-secondary"
						>
							Longitude
						</Label>
						<Input
							id={longitudeId}
							value={draftLongitude}
							inputMode="decimal"
							disabled={!canEdit || archived}
							onChange={(event) => {
								setDraftLongitude(event.target.value);
								setDirtyLongitude(true);
							}}
							onBlur={async () => {
								if (draftLongitude === (location.longitude ?? "")) {
									setDirtyLongitude(false);
									return;
								}
								if (peerChanged) {
									setMessage(
										"This place changed while you were editing. Use the latest saved values before saving your draft.",
									);
									return;
								}
								const result = await organization.update(location.id, {
									longitude: draftLongitude === "" ? null : draftLongitude,
								});
								if (!result.ok) setMessage(result.message);
								else {
									setDirtyLongitude(false);
									setMessage(undefined);
								}
							}}
						/>
					</div>
				</div>

				{level?.parentLevelUuid !== undefined && (
					<div className="flex flex-col gap-1.5">
						<Label className="text-[12px] font-medium text-nova-text-secondary">
							Sits in
						</Label>
						<Select
							value={location.parentId ?? ""}
							disabled={!canEdit || archived || peerChanged || dirtyLevel}
							onValueChange={async (value) => {
								if (typeof value !== "string" || value === "") return;
								const result = await organization.move(location.id, {
									parentId: value,
								});
								if (!result.ok) setMessage(result.message);
							}}
						>
							<SelectTrigger className="w-full" aria-label="Sits in">
								<SelectValue>
									{parentOptions.find(
										(candidate) => candidate.id === location.parentId,
									)?.name ?? "Choose a place"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{parentOptions.map((candidate) => (
									<SelectItem key={candidate.id} value={candidate.id}>
										{candidate.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}

				{siblings.length > 0 && (
					<div className="flex flex-col gap-1.5">
						<Label
							htmlFor={positionId}
							className="text-[12px] font-medium text-nova-text-secondary"
						>
							Position
						</Label>
						<Select
							value={positionValue}
							disabled={!canEdit || archived || peerChanged}
							onValueChange={async (value) => {
								if (typeof value !== "string") return;
								const afterSiblingId =
									value === FIRST_POSITION
										? null
										: value === END_POSITION
											? undefined
											: value;
								const result = await organization.move(location.id, {
									parentId: location.parentId,
									...(afterSiblingId === undefined ? {} : { afterSiblingId }),
								});
								if (!result.ok) setMessage(result.message);
								else setMessage(undefined);
							}}
						>
							<SelectTrigger id={positionId} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={END_POSITION}>At the end</SelectItem>
								<SelectItem value={FIRST_POSITION}>At the beginning</SelectItem>
								{siblings.map((sibling) => (
									<SelectItem key={sibling.id} value={sibling.id}>
										After {sibling.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}

				{applicableProperties.length > 0 && (
					<fieldset className="flex flex-col gap-3 rounded-lg border border-nova-border p-3">
						<legend className="px-1 text-[12px] font-medium text-nova-text-secondary">
							Place information
						</legend>
						{applicableProperties.map((property) => (
							<PlaceValueField
								key={property.uuid}
								property={property}
								value={draftValues[property.uuid] ?? ""}
								disabled={!canEdit || archived}
								onDraft={(value) => {
									setDraftValues((current) => ({
										...current,
										[property.uuid]: value,
									}));
									setDirtyValues(true);
								}}
								onCommit={(value) =>
									void saveValues({ ...draftValues, [property.uuid]: value })
								}
							/>
						))}
					</fieldset>
				)}

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

function PlaceValueField({
	property,
	value,
	disabled,
	onDraft,
	onCommit,
}: {
	property: LocationProperty;
	value: string;
	disabled: boolean;
	onDraft: (value: string) => void;
	onCommit: (value: string) => void;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1.5">
			<Label
				htmlFor={id}
				className="text-[12px] font-medium text-nova-text-secondary"
			>
				{property.label}
				{property.required === true && (
					<span className="ml-1 text-nova-rose" aria-hidden="true">
						*
					</span>
				)}
			</Label>
			{property.choices === undefined ? (
				<Input
					id={id}
					value={value}
					autoComplete="off"
					data-1p-ignore
					required={property.required === true}
					disabled={disabled}
					onChange={(event) => onDraft(event.target.value)}
					onBlur={(event) => onCommit(event.target.value)}
				/>
			) : (
				<div className="flex items-center gap-2">
					<Select
						value={value}
						disabled={disabled}
						onValueChange={(next) => {
							if (typeof next !== "string") return;
							onDraft(next);
							onCommit(next);
						}}
					>
						<SelectTrigger
							id={id}
							className="min-w-0 flex-1"
							aria-required={property.required === true}
						>
							<SelectValue>
								{value === "" ? "Choose a value" : value}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{property.choices.map((choice) => (
								<SelectItem key={choice} value={choice}>
									{choice}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{property.required !== true && value !== "" && (
						<Button
							type="button"
							variant="ghost"
							className="min-h-11 shrink-0 px-2.5 text-[12px]"
							disabled={disabled}
							onClick={() => {
								onDraft("");
								onCommit("");
							}}
						>
							Clear
						</Button>
					)}
				</div>
			)}
		</div>
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
		| {
				locations: number;
				personas: readonly string[];
				cases: number;
				blockingOwnerRuleForms: readonly string[];
		  }
		| undefined
	>(undefined);
	const [impactError, setImpactError] = useState<string | undefined>();
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);
	const archived = location.archivedAt !== null;

	if (archived) {
		return (
			<Button
				type="button"
				variant="ghost"
				className="min-h-11 gap-2 self-start px-2.5 text-[12px]"
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
				className="min-h-11 gap-2 self-start px-2.5 text-[12px] text-nova-red hover:bg-nova-red/[0.12] hover:text-nova-red"
				onClick={async () => {
					onMessage(undefined);
					setImpact(undefined);
					setImpactError(undefined);
					setConfirming(true);
					const described = await organization.describeArchive(location.id);
					if (described.ok) {
						setImpact({
							locations: described.impact.locationIds.length,
							personas: described.impact.unassignedPersonas,
							cases: described.impact.ownedCases,
							blockingOwnerRuleForms: described.impact.blockingOwnerRuleForms,
						});
					} else setImpactError(described.message);
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
			{impactError !== undefined ? (
				<p role="alert" className="text-[12px] leading-relaxed text-nova-red">
					{impactError}
				</p>
			) : impact === undefined ? (
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
					{impact.blockingOwnerRuleForms.length > 0 && (
						<li className="text-nova-amber">
							Used as a fixed case owner in{" "}
							{impact.blockingOwnerRuleForms.join(", ")}. Change{" "}
							{impact.blockingOwnerRuleForms.length === 1
								? "that rule"
								: "those rules"}{" "}
							before archiving.
						</li>
					)}
					<li>Archiving is reversible. You can bring the place back.</li>
				</ul>
			)}
			<div className="flex gap-2">
				<Button
					type="button"
					variant="ghost"
					className="min-h-11 px-2.5 text-[12px] text-nova-red hover:bg-nova-red/[0.12] hover:text-nova-red"
					disabled={
						impact === undefined || impact.blockingOwnerRuleForms.length > 0
					}
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
					className="min-h-11 px-2.5 text-[12px]"
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
	properties,
	locations,
	onCancel,
	onSubmit,
}: {
	levels: readonly OrganizationLevel[];
	properties: readonly LocationProperty[];
	locations: readonly StoredLocation[];
	onCancel: () => void;
	onSubmit: (input: {
		levelUuid: string;
		parentId: string | null;
		name: string;
		siteCode?: string;
		externalId: string | null;
		latitude: string | null;
		longitude: string | null;
		values: Record<string, string>;
		afterSiblingId?: string | null;
	}) => Promise<void>;
}) {
	const nameId = useId();
	const siteCodeId = useId();
	const externalId = useId();
	const latitudeId = useId();
	const longitudeId = useId();
	const levelId = useId();
	const parentId = useId();
	const positionId = useId();
	const [levelUuid, setLevelUuid] = useState(levels[0]?.uuid ?? "");
	const [parent, setParent] = useState<string>("");
	const [name, setName] = useState("");
	const [siteCode, setSiteCode] = useState("");
	const [external, setExternal] = useState("");
	const [latitude, setLatitude] = useState("");
	const [longitude, setLongitude] = useState("");
	const [afterSiblingId, setAfterSiblingId] = useState<
		string | null | undefined
	>();
	const [values, setValues] = useState<Record<string, string>>({});

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
	const siblings = locations.filter(
		(location) => location.parentId === (needsParent ? parent : null),
	);
	const applicableProperties = propertiesForLevel(properties, levelUuid);

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
			<div className="grid gap-3 @sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={siteCodeId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Code (optional)
					</Label>
					<Input
						id={siteCodeId}
						value={siteCode}
						autoComplete="off"
						data-1p-ignore
						placeholder="Derived from the name"
						onChange={(event) => setSiteCode(event.target.value)}
					/>
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
						value={external}
						autoComplete="off"
						data-1p-ignore
						onChange={(event) => setExternal(event.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={latitudeId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Latitude
					</Label>
					<Input
						id={latitudeId}
						value={latitude}
						inputMode="decimal"
						onChange={(event) => setLatitude(event.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={longitudeId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Longitude
					</Label>
					<Input
						id={longitudeId}
						value={longitude}
						inputMode="decimal"
						onChange={(event) => setLongitude(event.target.value)}
					/>
				</div>
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
						setAfterSiblingId(undefined);
						setValues((current) => valuesForLevel(properties, value, current));
					}}
				>
					<SelectTrigger id={levelId} className="w-full">
						<SelectValue>
							{levels.find((level) => level.uuid === levelUuid)?.name ??
								"Choose a level"}
						</SelectValue>
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
							if (typeof value === "string") {
								setParent(value);
								setAfterSiblingId(undefined);
							}
						}}
					>
						<SelectTrigger id={parentId} className="w-full">
							<SelectValue>
								{parent === ""
									? "Choose a place"
									: (parentOptions.find((c) => c.id === parent)?.name ??
										"Choose a place")}
							</SelectValue>
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
			{(!needsParent || parent !== "") && siblings.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={positionId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Position
					</Label>
					<Select
						value={
							afterSiblingId === null
								? FIRST_POSITION
								: (afterSiblingId ?? END_POSITION)
						}
						onValueChange={(value) => {
							if (typeof value !== "string") return;
							setAfterSiblingId(
								value === END_POSITION
									? undefined
									: value === FIRST_POSITION
										? null
										: value,
							);
						}}
					>
						<SelectTrigger id={positionId} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={END_POSITION}>At the end</SelectItem>
							<SelectItem value={FIRST_POSITION}>At the beginning</SelectItem>
							{siblings.map((sibling) => (
								<SelectItem key={sibling.id} value={sibling.id}>
									After {sibling.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}
			{applicableProperties.length > 0 && (
				<fieldset className="flex flex-col gap-3 rounded-lg border border-nova-border p-3">
					<legend className="px-1 text-[12px] font-medium text-nova-text-secondary">
						Place information
					</legend>
					{applicableProperties.map((property) => (
						<PlaceValueField
							key={property.uuid}
							property={property}
							value={values[property.uuid] ?? ""}
							disabled={false}
							onDraft={(value) =>
								setValues((current) => ({
									...current,
									[property.uuid]: value,
								}))
							}
							onCommit={(value) =>
								setValues((current) => ({
									...current,
									[property.uuid]: value,
								}))
							}
						/>
					))}
				</fieldset>
			)}
			<div className="flex gap-2">
				<Button
					type="button"
					variant="ghost"
					className="min-h-11 gap-2 px-2.5 text-[12px] text-nova-violet-bright hover:bg-nova-violet/[0.12] hover:text-nova-violet-bright"
					disabled={
						name.trim() === "" ||
						levelUuid === "" ||
						(needsParent && parent === "") ||
						!requiredValuesPresent(properties, levelUuid, values)
					}
					onClick={() =>
						void onSubmit({
							levelUuid,
							parentId: needsParent ? parent : null,
							name: name.trim(),
							...(siteCode.trim() === "" ? {} : { siteCode: siteCode.trim() }),
							externalId: external === "" ? null : external,
							latitude: latitude === "" ? null : latitude,
							longitude: longitude === "" ? null : longitude,
							values: valuesForLevel(properties, levelUuid, values),
							afterSiblingId,
						})
					}
				>
					<Icon icon={tablerPlus} width="15" height="15" aria-hidden="true" />
					Add place
				</Button>
				<Button
					type="button"
					variant="ghost"
					className="min-h-11 px-2.5 text-[12px]"
					onClick={onCancel}
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}
