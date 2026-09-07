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
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { LocationChoiceSelect } from "@/components/builder/LocationChoiceSelect";
import { Button } from "@/components/shadcn/button";
import { Field, FieldDescription, FieldLabel } from "@/components/shadcn/field";
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
	useOrganizationRuleInputs,
} from "@/lib/doc/hooks/useOrganizationCollections";
import {
	type LocationProperty,
	levelMayNestUnder,
	type OrganizationLevel,
} from "@/lib/domain";
import { locationChoiceLabel } from "@/lib/organization/locationLabels";
import type { OrganizationRuleInputs } from "@/lib/organization/ownerTargetVerdicts";
import { locationTopologyChangeIssue } from "@/lib/organization/ownerTargetVerdicts";
import type { ArchiveImpact, StoredLocation } from "@/lib/organization/types";
import type { useOrganization } from "@/lib/organization/useOrganization";
import { useAccessPhase, useCanEdit } from "@/lib/session/hooks";
import { useOptionalBuilderSessionApi } from "@/lib/session/provider";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { useRemovedRowFocus } from "@/lib/ui/hooks/useRemovedRowFocus";
import {
	flattenRequiredReverseHopDescendants,
	propertiesForLevel,
	type RequiredReverseHopDescendant,
	requiredReverseHopDescendants,
	requiredValuesPresent,
	valuesForLevel,
} from "./organizationUi";
import { createPlaceDraft } from "./placeDraft";
import {
	buildPlaceTree,
	PLACE_PAGE_SIZE,
	type PlaceTree,
	placeTreePage,
} from "./placeTree";
import { EntryRow, Subsection, SubsectionEmpty } from "./subsection";

type Organization = ReturnType<typeof useOrganization>;
const FIRST_POSITION = "__first__";
const END_POSITION = "__end__";

export function PlacesSubsection({
	organization,
}: {
	organization: Organization;
}) {
	const levels = useOrganizationLevels();
	const properties = useLocationProperties();
	const canEdit = useCanEdit();
	const accessPhase = useAccessPhase();
	const doc = useOrganizationRuleInputs();
	const [openId, setOpenId] = useState<string | undefined>(undefined);
	const [adding, setAdding] = useState(false);
	const [page, setPage] = useState(0);
	const [message, setMessage] = useState<string | undefined>(undefined);
	const [conflictedId, setConflictedId] = useState<string | undefined>();
	const [protectedId, setProtectedId] = useState<string | undefined>();
	const pendingAddedFocusIdRef = useRef<string | undefined>(undefined);
	const authoritative =
		!organization.loading && organization.error === undefined;

	const tree = useMemo(
		() => buildPlaceTree(organization.locations),
		[organization.locations],
	);
	const rowFocus = useRemovedRowFocus(tree.rows.length);
	const { page: shownPage, pageCount } = placeTreePage(tree.rows, openId, page);
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
	useEffect(() => {
		if (!adding || canEdit) return;
		if (accessPhase === "refreshing" || accessPhase === "reconnecting") return;
		setAdding(false);
	}, [accessPhase, adding, canEdit]);
	useEffect(() => {
		const pendingId = pendingAddedFocusIdRef.current;
		if (pendingId === undefined) return;
		const index = tree.rows.findIndex(
			({ location }) => location.id === pendingId,
		);
		if (index < 0) return;
		pendingAddedFocusIdRef.current = undefined;
		rowFocus.focusRow(index);
	}, [rowFocus.focusRow, tree.rows]);
	const handleConflictChange = useCallback(
		(locationId: string, conflicted: boolean) => {
			setConflictedId((current) => {
				if (conflicted) return locationId;
				return current === locationId ? undefined : current;
			});
			if (conflicted) setOpenId(locationId);
		},
		[],
	);
	const handleDraftProtectionChange = useCallback(
		(locationId: string, protectedDraft: boolean) => {
			setProtectedId((current) => {
				if (protectedDraft) return locationId;
				return current === locationId ? undefined : current;
			});
		},
		[],
	);

	if (levels.length === 0) {
		return (
			<Subsection
				id="app-setup-places"
				title="Places"
				description="Add the regions, districts, facilities, and other places in this organization."
				addLabel="Add place"
				onAdd={() => undefined}
				canEdit={false}
			>
				<SubsectionEmpty>Add a level before adding its places.</SubsectionEmpty>
			</Subsection>
		);
	}

	return (
		<Subsection
			id="app-setup-places"
			title="Places"
			description="Add the regions, districts, facilities, and other places in this organization."
			addLabel="Add place"
			onAdd={() => {
				if (conflictedId === undefined && protectedId === undefined)
					setAdding(true);
			}}
			canEdit={
				canEdit &&
				authoritative &&
				!adding &&
				conflictedId === undefined &&
				protectedId === undefined
			}
			addButtonRef={rowFocus.addRef}
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
						variant="ghost-action"
						onClick={organization.reload}
					>
						Try again
					</Button>
				</p>
			) : tree.rows.length === 0 && !adding ? (
				<SubsectionEmpty>
					Start with a place at the top level. Then add the places below it.
				</SubsectionEmpty>
			) : (
				<div className="flex flex-col gap-2">
					<ol aria-label="Place hierarchy" className="flex flex-col gap-2">
						{pageRows.map(({ location, depth }, rowIndex) => (
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
									onOpenChange={(next) => {
										if (
											(conflictedId !== undefined &&
												(conflictedId !== location.id || !next)) ||
											(protectedId !== undefined &&
												(protectedId !== location.id || !next))
										) {
											return;
										}
										setOpenId(next ? location.id : undefined);
									}}
									onConflictChange={handleConflictChange}
									onDraftProtectionChange={handleDraftProtectionChange}
									rowFocusRef={rowFocus.register(pageStart + rowIndex)}
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
								disabled={shownPage === 0 || openId !== undefined}
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
								disabled={shownPage === pageCount - 1 || openId !== undefined}
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

			{adding && (
				<AddPlaceForm
					doc={doc}
					levels={levels}
					properties={properties}
					locations={organization.locations}
					disabled={!canEdit || accessPhase !== "authorized" || !authoritative}
					onCancel={() => {
						setAdding(false);
						rowFocus.focusRow(tree.rows.length);
					}}
					onSubmit={async (input) => {
						const result = await organization.create(input);
						if (result.ok) {
							setAdding(false);
							setMessage(undefined);
							if (result.id !== undefined) {
								pendingAddedFocusIdRef.current = result.id;
								setOpenId(result.id);
							} else {
								rowFocus.focusRow(tree.rows.length);
							}
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
	onConflictChange,
	onDraftProtectionChange,
	rowFocusRef,
}: {
	location: StoredLocation;
	depth: number;
	doc: OrganizationRuleInputs;
	levels: readonly OrganizationLevel[];
	properties: readonly LocationProperty[];
	tree: PlaceTree;
	organization: Organization;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConflictChange: (locationId: string, conflicted: boolean) => void;
	onDraftProtectionChange: (
		locationId: string,
		protectedDraft: boolean,
	) => void;
	rowFocusRef: (element: HTMLButtonElement | null) => void;
}) {
	const canEdit = useCanEdit();
	const sessionApi = useOptionalBuilderSessionApi();
	const nameId = useId();
	const nameDescriptionId = useId();
	const externalId = useId();
	const latitudeId = useId();
	const longitudeId = useId();
	const levelId = useId();
	const positionId = useId();
	const writerRef = useRef(organization);
	writerRef.current = organization;
	const [editor] = useState(() =>
		createPlaceDraft(location, properties, () => writerRef.current),
	);
	const state = useSyncExternalStore(
		editor.subscribe,
		editor.getSnapshot,
		editor.getSnapshot,
	);
	const {
		source,
		dirtyLevel,
		dirtyPlacement,
		valuesNeedApply,
		peerChanged,
		protected: draftProtected,
		hiddenDirtyPropertyUuids,
		message,
	} = state;
	const {
		name: draftName,
		externalId: draftExternalId,
		latitude: draftLatitude,
		longitude: draftLongitude,
		levelUuid: draftLevelUuid,
		parentId: draftParentId,
		values: draftValues,
	} = state.draft;
	useEffect(
		() => editor.receive(location, properties),
		[editor, location, properties],
	);
	useEffect(() => {
		onConflictChange(location.id, peerChanged);
	}, [location.id, onConflictChange, peerChanged]);
	useEffect(
		() => () => onConflictChange(location.id, false),
		[location.id, onConflictChange],
	);
	useEffect(() => {
		onDraftProtectionChange(location.id, draftProtected);
	}, [location.id, onDraftProtectionChange, draftProtected]);
	useEffect(
		() => () => onDraftProtectionChange(location.id, false),
		[location.id, onDraftProtectionChange],
	);
	const setMessage = editor.setMessage;
	const adoptLatest = editor.adoptLatest;
	const keepDraft = editor.keepDraft;
	const discardHiddenValueDrafts = editor.discardHiddenValues;
	const saveValue = editor.saveValue;
	const archived = location.archivedAt !== null;
	const applicableProperties = useMemo(
		() => propertiesForLevel(properties, draftLevelUuid),
		[properties, draftLevelUuid],
	);
	const levelRecord = useMemo(
		() =>
			Object.fromEntries(
				levels.map((candidate) => [candidate.uuid, candidate]),
			),
		[levels],
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
	const descendants = useMemo(
		() =>
			open ? descendantIds(tree.childrenOf, location.id) : new Set<string>(),
		[location.id, open, tree.childrenOf],
	);
	const retypeDefaults = useMemo(() => {
		const defaults = new Map<string, string | null>();
		if (!open) return defaults;
		for (const candidateLevel of levels) {
			if (hasChildren && candidateLevel.uuid !== location.levelUuid) continue;
			if (candidateLevel.parentLevelUuid === undefined) {
				defaults.set(candidateLevel.uuid, null);
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
			if (defaultParent !== undefined)
				defaults.set(candidateLevel.uuid, defaultParent.id);
		}
		return defaults;
	}, [
		descendants,
		draftParentId,
		hasChildren,
		levelRecord,
		levels,
		location.id,
		location.levelUuid,
		open,
		tree.locations,
	]);
	const retypeOptions = useMemo(
		() => levels.filter((candidate) => retypeDefaults.has(candidate.uuid)),
		[levels, retypeDefaults],
	);
	const parentOptions = useMemo(
		() =>
			open
				? tree.locations.filter(
						(candidate) =>
							candidate.archivedAt === null &&
							!descendants.has(candidate.id) &&
							candidate.id !== location.id &&
							levelMayNestUnder(
								draftLevelUuid,
								candidate.levelUuid,
								levelRecord,
							),
					)
				: [],
		[
			descendants,
			draftLevelUuid,
			levelRecord,
			location.id,
			open,
			tree.locations,
		],
	);
	const draftPlacementIssue = useMemo(() => {
		if (!open || !dirtyPlacement) return undefined;
		return locationTopologyChangeIssue(doc, tree.locations, location.id, {
			levelUuid: draftLevelUuid,
			parentId: draftParentId,
		});
	}, [
		dirtyPlacement,
		doc,
		draftLevelUuid,
		draftParentId,
		location.id,
		open,
		tree.locations,
	]);
	const parentIssueFor = useMemo(() => {
		const cache = new Map<string, string | undefined>();
		return (candidate: StoredLocation) => {
			if (
				candidate.id === source.parentId &&
				draftLevelUuid === source.levelUuid
			) {
				return undefined;
			}
			if (cache.has(candidate.id)) return cache.get(candidate.id);
			const issue = locationTopologyChangeIssue(
				doc,
				tree.locations,
				location.id,
				{ levelUuid: draftLevelUuid, parentId: candidate.id },
			);
			cache.set(candidate.id, issue);
			return issue;
		};
	}, [
		doc,
		draftLevelUuid,
		location.id,
		tree.locations,
		source.parentId,
		source.levelUuid,
	]);

	return (
		<EntryRow
			triggerRef={rowFocusRef}
			summary={
				<span className="flex min-w-0 items-center gap-2">
					<span
						className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${archived ? "text-nova-text-muted" : ""}`}
					>
						{location.name}
					</span>
					<span className="min-w-0 max-w-[45%] text-right text-[11px] text-nova-text-muted [overflow-wrap:anywhere]">
						{location.siteCode}
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
							variant="ghost-action"
							className="ml-2"
							disabled={!canEdit || archived}
							onClick={keepDraft}
						>
							Keep my draft
						</Button>
						<Button
							type="button"
							variant="ghost-action"
							className="ml-2"
							onClick={adoptLatest}
						>
							Use latest saved values
						</Button>
					</div>
				)}
				<Field>
					<FieldLabel htmlFor={nameId}>Name</FieldLabel>
					<Input
						id={nameId}
						value={draftName}
						autoComplete="off"
						data-1p-ignore
						aria-describedby={nameDescriptionId}
						disabled={!canEdit || archived}
						onChange={(event) => editor.editScalar("name", event.target.value)}
						onBlur={() => void editor.saveScalar("name")}
					/>
					<FieldDescription id={nameDescriptionId}>
						Code{" "}
						<code className="text-nova-text-secondary [overflow-wrap:anywhere]">
							{location.siteCode}
						</code>
						. The code stays the same when you rename this place.
					</FieldDescription>
				</Field>

				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={externalId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						ID in another system
					</Label>
					<Input
						id={externalId}
						value={draftExternalId}
						autoComplete="off"
						data-1p-ignore
						disabled={!canEdit || archived}
						onChange={(event) =>
							editor.editScalar("externalId", event.target.value)
						}
						onBlur={() => void editor.saveScalar("externalId")}
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
							editor.stageLevel(value, defaultParentId);
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
					{(dirtyPlacement || valuesNeedApply) && (
						<Button
							type="button"
							variant="ghost-action"
							className="self-start"
							disabled={
								!canEdit ||
								archived ||
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
								const liveSession = sessionApi?.getState();
								if (
									!canEdit ||
									archived ||
									(liveSession !== undefined &&
										(liveSession.accessPhase !== "authorized" ||
											!liveSession.canEdit)) ||
									source.archivedAt !== null
								) {
									setMessage(
										"This place is read-only now. Reload the latest organization before applying this draft.",
									);
									return;
								}
								if (draftPlacementIssue !== undefined) {
									setMessage(draftPlacementIssue);
									return;
								}
								await editor.applyPlacement();
							}}
						>
							{dirtyLevel
								? "Apply level change"
								: dirtyPlacement
									? "Apply parent change"
									: "Apply place information"}
						</Button>
					)}
					{dirtyPlacement && draftPlacementIssue !== undefined && (
						<p className="text-[12px] leading-relaxed text-nova-red">
							Resolve this before applying the level or parent change:{" "}
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
							autoComplete="off"
							data-1p-ignore
							disabled={!canEdit || archived}
							onChange={(event) =>
								editor.editScalar("latitude", event.target.value)
							}
							onBlur={() => void editor.saveScalar("latitude")}
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
							autoComplete="off"
							data-1p-ignore
							disabled={!canEdit || archived}
							onChange={(event) =>
								editor.editScalar("longitude", event.target.value)
							}
							onBlur={() => void editor.saveScalar("longitude")}
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
							onValueChange={editor.stageParent}
							ariaLabel="Sits in"
							placeholder="Choose a place"
							issueFor={parentIssueFor}
						/>
						{dirtyPlacement && (
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
								await editor.move(afterSiblingId);
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

				{hiddenDirtyPropertyUuids.length > 0 && (
					<div
						role="alert"
						className="rounded-lg border border-nova-amber/40 bg-nova-amber/[0.06] p-3 text-[12px] leading-relaxed text-nova-text-secondary"
					>
						Place information changed while you were editing.{" "}
						{hiddenDirtyPropertyUuids.length}{" "}
						{hiddenDirtyPropertyUuids.length === 1 ? "draft is" : "drafts are"}{" "}
						no longer available here.
						<Button
							type="button"
							variant="ghost-action"
							className="ml-2"
							onClick={discardHiddenValueDrafts}
						>
							Discard unavailable{" "}
							{hiddenDirtyPropertyUuids.length === 1 ? "draft" : "drafts"}
						</Button>
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
								onDraft={(value) => editor.editValue(property.uuid, value)}
								onCommit={(value) => void saveValue(property.uuid, value)}
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
							className="shrink-0"
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
 * there stay put. Preview does not yet derive the owner sets that change case
 * list visibility, so the confirmation says exactly what changes today.
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
	const impactGenerationRef = useRef(0);
	const archived = location.archivedAt !== null;
	useEffect(
		() => () => {
			impactGenerationRef.current += 1;
		},
		[],
	);
	const closeConfirmation = () => {
		impactGenerationRef.current += 1;
		setConfirming(false);
		setImpact(undefined);
		setImpactError(undefined);
	};

	if (archived) {
		return (
			<Button
				type="button"
				variant="ghost-action"
				className="self-start"
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
				variant="ghost-destructive"
				className="self-start"
				onClick={async () => {
					const generation = impactGenerationRef.current + 1;
					impactGenerationRef.current = generation;
					onMessage(undefined);
					setImpact(undefined);
					setImpactError(undefined);
					setConfirming(true);
					const described = await organization.describeArchive(location.id);
					if (generation !== impactGenerationRef.current) return;
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
							{impact.affectedLocationCount} places are archived. This includes
							this place and everything under it.
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
							will stay owned here. Archiving does not move them.
						</li>
					)}
					{impact.blockingOwnerRuleFormCount > 0 && (
						<li className="text-nova-amber">
							Archiving would break a case-owner rule in{" "}
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
					{impact.blockingAutomationCount > 0 && (
						<li className="text-nova-amber">
							Archiving would break{" "}
							{impact.blockingAutomationCount === 1
								? "the automation"
								: "these automations"}{" "}
							{impact.blockingAutomationPreview.join(", ")}
							{impact.blockingAutomationCount >
							impact.blockingAutomationPreview.length
								? ` and ${impact.blockingAutomationCount - impact.blockingAutomationPreview.length} more`
								: ""}
							. Change the location condition or recipient before archiving.
						</li>
					)}
					<li>Archiving is reversible. You can bring the place back.</li>
				</ul>
			)}
			<div className="flex gap-2">
				<Button
					type="button"
					variant="destructive"
					disabled={
						impact === undefined ||
						impact.blockingOwnerRuleFormCount > 0 ||
						impact.blockingAutomationCount > 0
					}
					onClick={async () => {
						closeConfirmation();
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
				<Button type="button" variant="ghost" onClick={closeConfirmation}>
					Keep it
				</Button>
			</div>
		</div>
	);
}

interface AddPlaceDescendantInput {
	readonly levelUuid: string;
	readonly name: string;
	readonly siteCode?: string;
	readonly externalId: null;
	readonly latitude: null;
	readonly longitude: null;
	readonly values: Record<string, string>;
	readonly descendants?: readonly AddPlaceDescendantInput[];
}

/** Adding a place: its level, where it sits, and its name. */
function AddPlaceForm({
	doc,
	levels,
	properties,
	locations,
	disabled,
	onCancel,
	onSubmit,
}: {
	doc: OrganizationRuleInputs;
	levels: readonly OrganizationLevel[];
	properties: readonly LocationProperty[];
	locations: readonly StoredLocation[];
	disabled: boolean;
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
		descendants?: readonly AddPlaceDescendantInput[];
	}) => Promise<boolean>;
}) {
	const nameId = useId();
	const siteCodeId = useId();
	const siteCodeDescriptionId = useId();
	const externalId = useId();
	const latitudeId = useId();
	const longitudeId = useId();
	const levelId = useId();
	const parentId = useId();
	const positionId = useId();
	const requiredBranchId = useId();
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
	const [requiredDrafts, setRequiredDrafts] = useState<
		Record<
			string,
			{ name: string; siteCode: string; values: Record<string, string> }
		>
	>({});
	const [submitting, setSubmitting] = useState(false);
	const nameRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!disabled) nameRef.current?.focus();
	}, [disabled]);

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
	const requiredDescendants = requiredReverseHopDescendants(doc, levelUuid);
	const flatRequiredDescendants =
		flattenRequiredReverseHopDescendants(requiredDescendants);
	const requiredDraft = (uiPath: string) =>
		requiredDrafts[uiPath] ?? { name: "", siteCode: "", values: {} };
	const descendantInput = (
		required: RequiredReverseHopDescendant,
	): AddPlaceDescendantInput => {
		const draft = requiredDraft(required.uiPath);
		return {
			levelUuid: required.level.uuid,
			name: draft.name.trim(),
			...(draft.siteCode.trim() === ""
				? {}
				: { siteCode: draft.siteCode.trim() }),
			externalId: null,
			latitude: null,
			longitude: null,
			values: valuesForLevel(properties, required.level.uuid, draft.values),
			...(required.descendants.length === 0
				? {}
				: { descendants: required.descendants.map(descendantInput) }),
		};
	};

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
			...(requiredDescendants.length === 0
				? {}
				: { descendants: requiredDescendants.map(descendantInput) }),
		});
		// A successful submit unmounts this form. A refusal leaves it available
		// for correction without admitting a duplicate click while in flight.
		if (!succeeded) setSubmitting(false);
	};

	return (
		<fieldset
			disabled={disabled || submitting}
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
				<Field>
					<FieldLabel htmlFor={siteCodeId}>Code (optional)</FieldLabel>
					<Input
						id={siteCodeId}
						value={siteCode}
						autoComplete="off"
						data-1p-ignore
						aria-describedby={siteCodeDescriptionId}
						placeholder="Derived from the name"
						onChange={(event) => setSiteCode(event.target.value)}
					/>
					<FieldDescription id={siteCodeDescriptionId}>
						Leave this blank to create a code from the name. You can't change
						the code later.
					</FieldDescription>
				</Field>
				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={externalId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						ID in another system
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
						autoComplete="off"
						data-1p-ignore
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
						autoComplete="off"
						data-1p-ignore
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
						setRequiredDrafts({});
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
			{requiredDescendants.length > 0 && (
				<fieldset className="flex flex-col gap-3 rounded-lg border border-nova-amber/40 bg-nova-amber/[0.05] p-3">
					<legend className="px-1 text-[12px] font-medium text-nova-text-secondary">
						Required owner destinations
					</legend>
					<p className="text-[12px] leading-relaxed text-nova-text-muted">
						A saved case-owner rule needs these places below the new{" "}
						{levelRecord[levelUuid]?.name.toLowerCase()}. Nova adds the complete
						branch in one save so the rule never has a missing destination.
					</p>
					{flatRequiredDescendants.map((required) => {
						const draft = requiredDraft(required.uiPath);
						const childProperties = propertiesForLevel(
							properties,
							required.level.uuid,
						);
						const nameInputId = `${requiredBranchId}-${required.uiPath}-name`;
						const codeInputId = `${requiredBranchId}-${required.uiPath}-code`;
						const updateDraft = (patch: Partial<typeof draft>) =>
							setRequiredDrafts((current) => ({
								...current,
								[required.uiPath]: { ...draft, ...patch },
							}));
						return (
							<div
								key={required.uiPath}
								style={{
									marginInlineStart: `min(${required.depth * 12}px, 72px)`,
								}}
								className="flex flex-col gap-3 rounded-md border border-nova-border bg-nova-deep p-3"
							>
								<p className="text-[12px] font-medium text-nova-text-secondary">
									One {required.level.name}
								</p>
								<div className="grid gap-3 @sm:grid-cols-2">
									<div className="flex flex-col gap-1.5">
										<Label htmlFor={nameInputId}>Name</Label>
										<Input
											id={nameInputId}
											value={draft.name}
											autoComplete="off"
											data-1p-ignore
											onChange={(event) =>
												updateDraft({ name: event.target.value })
											}
										/>
									</div>
									<div className="flex flex-col gap-1.5">
										<Label htmlFor={codeInputId}>Code (optional)</Label>
										<Input
											id={codeInputId}
											value={draft.siteCode}
											autoComplete="off"
											data-1p-ignore
											onChange={(event) =>
												updateDraft({ siteCode: event.target.value })
											}
										/>
									</div>
								</div>
								{childProperties.length > 0 && (
									<div className="flex flex-col gap-3">
										{childProperties.map((property) => (
											<PlaceValueField
												key={property.uuid}
												property={property}
												value={draft.values[property.uuid] ?? ""}
												disabled={false}
												onDraft={(value) =>
													updateDraft({
														values: { ...draft.values, [property.uuid]: value },
													})
												}
												onCommit={(value) =>
													updateDraft({
														values: { ...draft.values, [property.uuid]: value },
													})
												}
											/>
										))}
									</div>
								)}
							</div>
						);
					})}
				</fieldset>
			)}
			<div className="flex gap-2">
				<Button
					type="button"
					disabled={
						submitting ||
						name.trim() === "" ||
						levelUuid === "" ||
						(needsParent && parent === "") ||
						!requiredValuesPresent(properties, levelUuid, values) ||
						flatRequiredDescendants.some((required) => {
							const draft = requiredDraft(required.uiPath);
							return (
								draft.name.trim() === "" ||
								!requiredValuesPresent(
									properties,
									required.level.uuid,
									draft.values,
								)
							);
						})
					}
					onClick={() => void submit()}
				>
					<Icon icon={tablerPlus} width="15" height="15" aria-hidden="true" />
					{submitting ? "Adding" : "Add place"}
				</Button>
				<Button type="button" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</fieldset>
	);
}
