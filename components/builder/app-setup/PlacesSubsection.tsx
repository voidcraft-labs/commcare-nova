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
import { LocationChoiceSelect } from "@/components/builder/LocationChoiceSelect";
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
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	useLocationProperties,
	useOrganizationLevels,
} from "@/lib/doc/hooks/useOrganizationCollections";
import {
	type BlueprintDoc,
	type LocationProperty,
	levelMayNestUnder,
	type OrganizationLevel,
} from "@/lib/domain";
import { locationChoiceLabel } from "@/lib/organization/locationLabels";
import { locationTopologyChangeIssue } from "@/lib/organization/ownerTargetVerdicts";
import type { ArchiveImpact, StoredLocation } from "@/lib/organization/types";
import type { useOrganization } from "@/lib/organization/useOrganization";
import { useCanEdit } from "@/lib/session/hooks";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import {
	propertiesForLevel,
	requiredValuesPresent,
	valuesForLevel,
} from "./organizationUi";
import { buildPlaceTree, PLACE_PAGE_SIZE, type PlaceTree } from "./placeTree";
import { EntryRow, Subsection, SubsectionEmpty } from "./subsection";

type Organization = ReturnType<typeof useOrganization>;
const FIRST_POSITION = "__first__";
const END_POSITION = "__end__";

interface LocalLocationSave {
	readonly before: StoredLocation;
	readonly saved: StoredLocation;
}

export function PlacesSubsection({
	organization,
}: {
	organization: Organization;
}) {
	const levels = useOrganizationLevels();
	const properties = useLocationProperties();
	const canEdit = useCanEdit();
	const doc = useBlueprintDoc((state) => state);
	const [openId, setOpenId] = useState<string | undefined>(undefined);
	const [adding, setAdding] = useState(false);
	const [page, setPage] = useState(0);
	const [message, setMessage] = useState<string | undefined>(undefined);
	const authoritative =
		!organization.loading && organization.error === undefined;

	useEffect(() => {
		if (canEdit) return;
		setAdding(false);
	}, [canEdit]);

	const tree = buildPlaceTree(organization.locations);
	const pageCount = Math.max(1, Math.ceil(tree.rows.length / PLACE_PAGE_SIZE));
	const shownPage = Math.min(page, pageCount - 1);
	const pageStart = shownPage * PLACE_PAGE_SIZE;
	const pageRows = tree.rows.slice(pageStart, pageStart + PLACE_PAGE_SIZE);

	useEffect(() => {
		setPage((current) => Math.min(current, pageCount - 1));
	}, [pageCount]);
	useEffect(() => {
		if (openId === undefined) return;
		const index = tree.rows.findIndex(({ location }) => location.id === openId);
		if (index >= 0) setPage(Math.floor(index / PLACE_PAGE_SIZE));
	}, [openId, tree.rows]);

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
			) : tree.rows.length === 0 && !adding ? (
				<SubsectionEmpty>
					No places yet. Add the first one at your top level, then build
					downward.
				</SubsectionEmpty>
			) : (
				<div className="flex flex-col gap-2">
					<ol aria-label="Place hierarchy" className="flex flex-col gap-2">
						{pageRows.map(({ location, depth }) => (
							<li
								key={location.id}
								style={{ paddingInlineStart: `min(${depth * 16}px, 25%)` }}
								className="min-w-0"
							>
								<PlaceRow
									location={location}
									depth={depth}
									levels={levels}
									properties={properties}
									doc={doc}
									tree={tree}
									organization={organization}
									open={openId === location.id}
									onOpenChange={(next) =>
										setOpenId(next ? location.id : undefined)
									}
								/>
							</li>
						))}
					</ol>
					{pageCount > 1 && (
						<fieldset className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-nova-border px-3 py-2">
							<legend className="sr-only">Place pages</legend>
							<Button
								type="button"
								variant="ghost"
								className="min-h-11 px-2.5 text-[12px]"
								disabled={shownPage === 0}
								onClick={() => setPage((current) => Math.max(0, current - 1))}
							>
								Previous
							</Button>
							<p
								className="text-[12px] text-nova-text-muted"
								aria-live="polite"
							>
								Places {pageStart + 1}–
								{Math.min(pageStart + PLACE_PAGE_SIZE, tree.rows.length)} of{" "}
								{tree.rows.length}
							</p>
							<Button
								type="button"
								variant="ghost"
								className="min-h-11 px-2.5 text-[12px]"
								disabled={shownPage === pageCount - 1}
								onClick={() =>
									setPage((current) => Math.min(pageCount - 1, current + 1))
								}
							>
								Next
							</Button>
						</fieldset>
					)}
				</div>
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
							return true;
						}
						setMessage(result.message);
						return false;
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
	children: ReadonlyMap<string | null, readonly StoredLocation[]>,
	rootId: string,
): ReadonlySet<string> {
	const descendants = new Set<string>();
	const pending = (children.get(rootId) ?? []).map((location) => location.id);
	while (pending.length > 0) {
		const id = pending.pop();
		if (id === undefined || descendants.has(id)) continue;
		descendants.add(id);
		pending.push(...(children.get(id) ?? []).map((location) => location.id));
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
		sameStringRecord(left.values, right.values)
	);
}

function sameStringRecord(
	left: Readonly<Record<string, string>>,
	right: Readonly<Record<string, string>>,
): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key) => left[key] === right[key])
	);
}

function PlaceRow({
	location,
	depth,
	doc,
	levels,
	properties,
	tree,
	organization,
	open,
	onOpenChange,
}: {
	location: StoredLocation;
	depth: number;
	doc: BlueprintDoc;
	levels: readonly OrganizationLevel[];
	properties: readonly LocationProperty[];
	tree: PlaceTree;
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
	const [draftParentId, setDraftParentId] = useState<string | null>(
		location.parentId,
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
	// Server Actions return the authoritative row before the post-write refresh
	// lands. Keep those accepted rows as a chain so an old render is not mistaken
	// for a peer edit, while a genuinely different row still raises a conflict.
	const localSavesRef = useRef<LocalLocationSave[]>([]);
	const archived = location.archivedAt !== null;
	const applicableProperties = propertiesForLevel(properties, draftLevelUuid);
	const levelRecord = Object.fromEntries(
		levels.map((candidate) => [candidate.uuid, candidate]),
	);
	const hasChildren = (tree.childrenOf.get(location.id)?.length ?? 0) > 0;
	const siblingOrder = tree.childrenOf.get(location.parentId) ?? [];
	const siblings = siblingOrder.filter(
		(candidate) => candidate.id !== location.id,
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
	const descendants = open
		? descendantIds(tree.childrenOf, location.id)
		: new Set<string>();
	const retypeDefaults = new Map<string, string | null>();
	if (open) {
		for (const candidateLevel of levels) {
			if (hasChildren && candidateLevel.uuid !== location.levelUuid) continue;
			if (candidateLevel.parentLevelUuid === undefined) {
				retypeDefaults.set(candidateLevel.uuid, null);
				continue;
			}
			const compatible = tree.locations.filter(
				(candidate) =>
					candidate.archivedAt === null &&
					candidate.id !== location.id &&
					!descendants.has(candidate.id) &&
					levelMayNestUnder(
						candidateLevel.uuid,
						candidate.levelUuid,
						levelRecord,
					),
			);
			const currentParent = compatible.find(
				(candidate) => candidate.id === draftParentId,
			);
			const defaultParent = currentParent ?? compatible[0];
			if (defaultParent !== undefined) {
				// Retyping is staged. Keep every structurally possible level reachable,
				// then let the searchable parent picker verdict its bounded visible page.
				// The selected parent is checked again before Apply can write.
				retypeDefaults.set(candidateLevel.uuid, defaultParent.id);
			}
		}
	}
	const retypeOptions = levels.filter((candidate) =>
		retypeDefaults.has(candidate.uuid),
	);
	const parentOptions = open
		? tree.locations.filter(
				(candidate) =>
					candidate.archivedAt === null &&
					!descendants.has(candidate.id) &&
					candidate.id !== location.id &&
					levelMayNestUnder(draftLevelUuid, candidate.levelUuid, levelRecord),
			)
		: [];
	const draftPlacementIssue = open
		? locationTopologyChangeIssue(doc, tree.locations, location.id, {
				levelUuid: draftLevelUuid,
				parentId: draftParentId,
			})
		: undefined;
	useEffect(() => {
		if (
			dirtyName ||
			dirtyExternalId ||
			dirtyValues ||
			dirtyLatitude ||
			dirtyLongitude ||
			dirtyLevel
		) {
			if (sameStoredLocation(sourceRef.current, location)) return;
			const acceptedIndex = localSavesRef.current.findIndex(({ saved }) =>
				sameStoredLocation(saved, location),
			);
			if (acceptedIndex >= 0) {
				localSavesRef.current.splice(0, acceptedIndex + 1);
				sourceRef.current = localSavesRef.current.at(-1)?.saved ?? location;
				setPeerChanged(false);
				return;
			}
			if (
				localSavesRef.current.some(({ before }) =>
					sameStoredLocation(before, location),
				)
			) {
				return;
			}
			setPeerChanged(true);
			return;
		}
		const acceptedIndex = localSavesRef.current.findIndex(({ saved }) =>
			sameStoredLocation(saved, location),
		);
		if (acceptedIndex >= 0) {
			localSavesRef.current.splice(0, acceptedIndex + 1);
		}
		const pendingLocal = localSavesRef.current.at(-1);
		if (
			pendingLocal !== undefined &&
			localSavesRef.current.some(({ before }) =>
				sameStoredLocation(before, location),
			)
		) {
			sourceRef.current = pendingLocal.saved;
			setPeerChanged(false);
			return;
		}
		// A changed prop that is neither the pre-save row nor one of our accepted
		// rows is newer authoritative state (for example a peer edit after our
		// write). Do not pin the UI to the local response forever.
		if (pendingLocal !== undefined) localSavesRef.current = [];
		setDraftName(location.name);
		setDraftExternalId(location.externalId ?? "");
		setDraftLatitude(location.latitude ?? "");
		setDraftLongitude(location.longitude ?? "");
		setDraftLevelUuid(location.levelUuid);
		setDraftParentId(location.parentId);
		setDraftValues(
			valuesForLevel(properties, location.levelUuid, location.values),
		);
		sourceRef.current = location;
		localSavesRef.current = [];
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
		setDraftParentId(location.parentId);
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
		localSavesRef.current = [];
	};

	const keepDraft = () => {
		// The author explicitly chooses the just-read peer row as the new base.
		// Draft fields stay untouched and the next write uses the hook's refreshed
		// organization revision, so no peer value is silently overwritten.
		sourceRef.current = location;
		localSavesRef.current = [];
		setPeerChanged(false);
		setMessage(undefined);
	};

	const rebaseAfterLocalSave = (saved: StoredLocation | undefined) => {
		if (saved !== undefined) {
			localSavesRef.current.push({ before: sourceRef.current, saved });
			sourceRef.current = saved;
		}
		setPeerChanged(false);
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
			rebaseAfterLocalSave(result.location);
			setDirtyValues(false);
			setMessage(undefined);
		}
	};

	return (
		<EntryRow
			summary={
				<span className="flex min-w-0 items-center gap-2">
					<span
						className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${archived ? "text-nova-text-muted" : ""}`}
					>
						{location.name}
					</span>
					{archived && (
						<span className="shrink-0 rounded-sm bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-nova-text-muted">
							Archived
						</span>
					)}
					<span className="shrink-0 rounded-sm bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-nova-text-muted">
						Depth {depth + 1}
					</span>
				</span>
			}
			detail={levelName(levels, location.levelUuid)}
			open={open}
			onOpenChange={onOpenChange}
			keepMounted={false}
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
							onClick={keepDraft}
						>
							Keep my draft
						</Button>
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
								rebaseAfterLocalSave(result.location);
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
								rebaseAfterLocalSave(result.location);
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
							const defaultParentId = retypeDefaults.get(value);
							if (defaultParentId === undefined) return;
							setDraftLevelUuid(value);
							setDraftParentId(defaultParentId);
							const nextValues = valuesForLevel(properties, value, draftValues);
							setDraftValues(nextValues);
							setDirtyLevel(value !== location.levelUuid);
							setDirtyValues(
								!sameStringRecord(
									nextValues,
									valuesForLevel(
										properties,
										location.levelUuid,
										location.values,
									),
								),
							);
						}}
					>
						<SelectTrigger id={levelId} wrapValue className="w-full">
							<SelectValue>{levelName(levels, draftLevelUuid)}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{retypeOptions.map((candidate) => (
								<SelectItem wrap key={candidate.uuid} value={candidate.uuid}>
									{candidate.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{hasChildren && (
						<p className="text-[12px] leading-relaxed text-nova-text-muted">
							A place with other places under it keeps its level. Move every
							child somewhere else first; bring archived children back before
							moving them.
						</p>
					)}
					{dirtyLevel && (
						<Button
							type="button"
							variant="ghost"
							className="min-h-11 self-start px-2.5 text-[12px] text-nova-violet-bright"
							disabled={
								peerChanged ||
								!requiredValuesPresent(
									properties,
									draftLevelUuid,
									draftValues,
								) ||
								(levels.find((candidate) => candidate.uuid === draftLevelUuid)
									?.parentLevelUuid !== undefined &&
									draftParentId === null) ||
								draftPlacementIssue !== undefined
							}
							onClick={async () => {
								if (draftPlacementIssue !== undefined) {
									setMessage(draftPlacementIssue);
									return;
								}
								const result = await organization.update(location.id, {
									levelUuid: draftLevelUuid,
									values: valuesForLevel(
										properties,
										draftLevelUuid,
										draftValues,
									),
									parentId: draftParentId,
								});
								if (!result.ok) setMessage(result.message);
								else {
									rebaseAfterLocalSave(result.location);
									setDirtyLevel(false);
									setDirtyValues(false);
									setMessage(undefined);
								}
							}}
						>
							Apply level change
						</Button>
					)}
					{dirtyLevel && draftPlacementIssue !== undefined && (
						<p className="text-[12px] leading-relaxed text-nova-red">
							Choose a different parent before applying this level:{" "}
							{draftPlacementIssue}
						</p>
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
									rebaseAfterLocalSave(result.location);
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
									rebaseAfterLocalSave(result.location);
									setDirtyLongitude(false);
									setMessage(undefined);
								}
							}}
						/>
					</div>
				</div>

				{levels.find((candidate) => candidate.uuid === draftLevelUuid)
					?.parentLevelUuid !== undefined && (
					<div className="flex flex-col gap-1.5">
						<Label className="text-[12px] font-medium text-nova-text-secondary">
							Sits in
						</Label>
						<LocationChoiceSelect
							locations={parentOptions}
							value={draftParentId ?? ""}
							disabled={!canEdit || archived || peerChanged}
							onValueChange={async (value) => {
								setDraftParentId(value);
								if (dirtyLevel) return;
								const result = await organization.move(location.id, {
									parentId: value,
								});
								if (!result.ok) setMessage(result.message);
								else {
									rebaseAfterLocalSave(result.location);
									setMessage(undefined);
								}
							}}
							ariaLabel="Sits in"
							placeholder="Choose a place"
							issueFor={(candidate) =>
								locationTopologyChangeIssue(doc, tree.locations, location.id, {
									levelUuid: draftLevelUuid,
									parentId: candidate.id,
								})
							}
						/>
						{(dirtyLevel || draftParentId !== location.parentId) && (
							<p className="text-[12px] leading-relaxed text-nova-text-muted">
								Apply the level or parent change before choosing a position.
							</p>
						)}
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
						<LocationChoiceSelect
							locations={siblings}
							value={positionValue}
							disabled={
								!canEdit ||
								archived ||
								peerChanged ||
								dirtyLevel ||
								draftParentId !== location.parentId
							}
							onValueChange={async (value) => {
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
								else {
									rebaseAfterLocalSave(result.location);
									setMessage(undefined);
								}
							}}
							id={positionId}
							ariaLabel="Position"
							placeholder="Choose a position"
							optionPrefix="After "
							specialOptions={[
								{ value: END_POSITION, label: "At the end" },
								{ value: FIRST_POSITION, label: "At the beginning" },
							]}
							triggerContent={
								<span>
									{positionValue === FIRST_POSITION
										? "At the beginning"
										: positionValue === END_POSITION
											? "At the end"
											: `After ${
													siblings.find(
														(sibling) => sibling.id === positionValue,
													) === undefined
														? "another place"
														: locationChoiceLabel(
																siblings.find(
																	(sibling) => sibling.id === positionValue,
																) as StoredLocation,
															)
												}`}
								</span>
							}
						/>
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
							wrapValue
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
								<SelectItem wrap key={choice} value={choice}>
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
	const [impact, setImpact] = useState<ArchiveImpact | undefined>(undefined);
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
						setImpact(described.impact);
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
					{impact.affectedLocationCount > 1 && (
						<li>
							{impact.affectedLocationCount} places are archived — this one and
							everything under it.
						</li>
					)}
					{impact.unassignedPersonaCount > 0 && (
						<li>
							{impact.unassignedPersonaPreview.join(", ")}
							{impact.unassignedPersonaCount >
							impact.unassignedPersonaPreview.length
								? ` and ${impact.unassignedPersonaCount - impact.unassignedPersonaPreview.length} more`
								: ""}{" "}
							stop working there. Their next remaining place becomes their main
							one.
						</li>
					)}
					{impact.ownedCases > 0 && (
						<li className="text-nova-amber">
							{impact.ownedCases}{" "}
							{impact.ownedCases === 1 ? "case is" : "cases are"} owned here and
							will stop reaching anyone. Nothing moves them. Bringing the place
							back restores its path; restore a worker assignment before
							expecting the cases to reach a device again.
						</li>
					)}
					{impact.blockingOwnerRuleFormCount > 0 && (
						<li className="text-nova-amber">
							Used as a fixed case owner in{" "}
							{impact.blockingOwnerRuleFormPreview.join(", ")}
							{impact.blockingOwnerRuleFormCount >
							impact.blockingOwnerRuleFormPreview.length
								? ` and ${impact.blockingOwnerRuleFormCount - impact.blockingOwnerRuleFormPreview.length} more`
								: ""}
							. Change{" "}
							{impact.blockingOwnerRuleFormCount === 1
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
						impact === undefined || impact.blockingOwnerRuleFormCount > 0
					}
					onClick={async () => {
						setConfirming(false);
						const result = await organization.setArchived(
							location.id,
							true,
							impact,
						);
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
	}) => Promise<boolean>;
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
	const [submitting, setSubmitting] = useState(false);
	const nameRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		nameRef.current?.focus();
	}, []);

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

	const submit = async () => {
		if (submitting) return;
		setSubmitting(true);
		const succeeded = await onSubmit({
			levelUuid,
			parentId: needsParent ? parent : null,
			name: name.trim(),
			...(siteCode.trim() === "" ? {} : { siteCode: siteCode.trim() }),
			externalId: external === "" ? null : external,
			latitude: latitude === "" ? null : latitude,
			longitude: longitude === "" ? null : longitude,
			values: valuesForLevel(properties, levelUuid, values),
			afterSiblingId,
		});
		// A successful submit unmounts this form. A refusal leaves it available
		// for correction without admitting a duplicate click while in flight.
		if (!succeeded) setSubmitting(false);
	};

	return (
		<fieldset
			disabled={submitting}
			aria-busy={submitting}
			className="flex flex-col gap-3 rounded-lg border border-nova-border bg-nova-deep p-3"
		>
			<div className="flex flex-col gap-1.5">
				<Label
					htmlFor={nameId}
					className="text-[12px] font-medium text-nova-text-secondary"
				>
					Name
				</Label>
				<Input
					ref={nameRef}
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
					<SelectTrigger id={levelId} wrapValue className="w-full">
						<SelectValue>
							{levels.find((level) => level.uuid === levelUuid)?.name ??
								"Choose a level"}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{levels.map((level) => (
							<SelectItem wrap key={level.uuid} value={level.uuid}>
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
					<LocationChoiceSelect
						locations={parentOptions}
						value={parent}
						onValueChange={(value) => {
							setParent(value);
							setAfterSiblingId(undefined);
						}}
						id={parentId}
						ariaLabel="Sits in"
						placeholder="Choose a place"
					/>
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
					<LocationChoiceSelect
						locations={siblings}
						value={
							afterSiblingId === null
								? FIRST_POSITION
								: (afterSiblingId ?? END_POSITION)
						}
						onValueChange={(value) => {
							setAfterSiblingId(
								value === END_POSITION
									? undefined
									: value === FIRST_POSITION
										? null
										: value,
							);
						}}
						id={positionId}
						ariaLabel="Position"
						placeholder="Choose a position"
						optionPrefix="After "
						specialOptions={[
							{ value: END_POSITION, label: "At the end" },
							{ value: FIRST_POSITION, label: "At the beginning" },
						]}
						triggerContent={
							<span>
								{afterSiblingId === null
									? "At the beginning"
									: afterSiblingId === undefined
										? "At the end"
										: `After ${
												siblings.find(
													(sibling) => sibling.id === afterSiblingId,
												) === undefined
													? "another place"
													: locationChoiceLabel(
															siblings.find(
																(sibling) => sibling.id === afterSiblingId,
															) as StoredLocation,
														)
											}`}
							</span>
						}
					/>
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
						submitting ||
						name.trim() === "" ||
						levelUuid === "" ||
						(needsParent && parent === "") ||
						!requiredValuesPresent(properties, levelUuid, values)
					}
					onClick={() => void submit()}
				>
					<Icon icon={tablerPlus} width="15" height="15" aria-hidden="true" />
					{submitting ? "Adding…" : "Add place"}
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
		</fieldset>
	);
}
