/**
 * AppTree: structure sidebar with per-entity subscriptions.
 *
 * Each tree component (ModuleCard, FormCard, FieldRow) subscribes to
 * its own entity in the builder store by ID/UUID. Immer structural
 * sharing means editing field A's label only re-renders FieldRow(A) in
 * the sidebar, not the other 166 FieldRows, not the FormCards, not the
 * ModuleCards.
 *
 * Selection uses boolean selectors: only the old and new selected
 * components re-render on selection change (2 total), not every tree
 * item.
 *
 * Search filtering operates directly on entity maps: no assembled
 * TreeData is constructed.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerX from "@iconify-icons/tabler/x";
import { AnimatePresence } from "motion/react";
import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { AddModulePopover } from "@/components/builder/appTree/insertion/AddModulePopover";
import { interleaveInsertions } from "@/components/builder/appTree/insertion/interleaveInsertions";
import { ModuleCard } from "@/components/builder/appTree/ModuleCard";
import { useAppTreeSelection } from "@/components/builder/appTree/useAppTreeSelection";
import {
	loadFieldInspectorBody,
	loadXPathEditor,
} from "@/components/builder/inspector/lazyInspectorBodies";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { useAncestors } from "@/lib/doc/hooks/useAncestors";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useModuleMenuHierarchy } from "@/lib/doc/hooks/useModuleIds";
import { useLargeFormInitialCollapsedUuids } from "@/lib/doc/hooks/useOrderedFields";
import { useSearchFilter } from "@/lib/doc/hooks/useSearchFilter";
import type { Uuid } from "@/lib/domain";
import {
	useSelectedFieldUuid,
	useSelectedFormUuid,
	useSelectedModuleUuid,
} from "@/lib/routing/hooks";
import { BuilderPhase } from "@/lib/session/builderTypes";
import { useBuilderPhase } from "@/lib/session/hooks";
import { InsertionIntentProvider } from "@/lib/ui/hooks/useInsertionZone";

export function AppTree() {
	const { rootModuleUuids, childModuleUuidsByRoot } = useModuleMenuHierarchy();
	const phase = useBuilderPhase();
	const selectedModuleUuid = useSelectedModuleUuid();
	const selectedFormUuid = useSelectedFormUuid();
	const selectedFieldUuid = useSelectedFieldUuid();
	const selectedFieldAncestors = useAncestors(selectedFieldUuid);
	const selectedModule = useModule(selectedModuleUuid);
	const initiallyCollapsedUuids = useLargeFormInitialCollapsedUuids();

	const locked =
		phase !== BuilderPhase.Ready && phase !== BuilderPhase.Completed;

	const handleSelect = useAppTreeSelection();
	const [collapsed, setCollapsed] = useState<Set<Uuid>>(() => {
		const initiallyCollapsed = new Set(initiallyCollapsedUuids);
		/* Deep links should render their selected form expanded on the first
		 * commit. Waiting for the reveal effect would create a second, avoidable
		 * render of that form's rows immediately after hydration. */
		if (selectedFormUuid !== undefined) {
			initiallyCollapsed.delete(selectedFormUuid);
		}
		for (const ancestorUuid of selectedFieldAncestors) {
			initiallyCollapsed.delete(ancestorUuid);
		}
		return initiallyCollapsed;
	});
	const [pendingFocus, setPendingFocus] = useState<{
		readonly moduleUuid: Uuid;
		readonly fallbackModuleUuid?: Uuid;
	} | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const deferredQuery = useDeferredValue(searchQuery);

	/* A loaded form is very likely to be inspected. Resolve the inspector body
	 * during the browser's next idle period so a later selection can commit its
	 * controls with the urgent URL update, while the Builder home and first paint
	 * stay free of editor code. Expansion and hover retain stronger intent
	 * prefetches for browsers that never report idle. */
	useEffect(() => {
		if (selectedFormUuid === undefined) return;
		/* A field URL is stronger intent than a form URL: the inspector is part of
		 * the requested screen, and XPath is the common heavyweight control in its
		 * schema. Start both independent chunks together instead of discovering the
		 * editor only after the inspector module has rendered. */
		if (selectedFieldUuid !== undefined) {
			void Promise.all([loadFieldInspectorBody(), loadXPathEditor()]);
			return;
		}
		let cancelled = false;
		const preload = () => {
			if (!cancelled) void loadFieldInspectorBody();
		};
		const idleId = window.requestIdleCallback(preload, { timeout: 1_500 });
		return () => {
			cancelled = true;
			window.cancelIdleCallback(idleId);
		};
	}, [selectedFieldUuid, selectedFormUuid]);

	const toggle = useCallback((key: Uuid) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	// Deep navigation, peer following, and remote reparenting should reveal the
	// still-selected identity. This changes only the local disclosure set; the
	// identity URL remains untouched.
	useEffect(() => {
		if (selectedModuleUuid === undefined) return;
		setCollapsed((previous) => {
			const next = new Set(previous);
			next.delete(selectedModuleUuid);
			if (selectedModule?.parentModuleUuid !== undefined) {
				next.delete(selectedModule.parentModuleUuid);
			}
			return next.size === previous.size ? previous : next;
		});
	}, [selectedModule?.parentModuleUuid, selectedModuleUuid]);

	/* A deep link must reveal the selected form and its ancestor path even when
	 * the rest of a large form starts summarized. Once opened, keep that path
	 * expanded for the session so returning through the tree is instant. */
	useEffect(() => {
		if (selectedFormUuid === undefined) return;
		setCollapsed((previous) => {
			const next = new Set(previous);
			next.delete(selectedFormUuid);
			for (const ancestorUuid of selectedFieldAncestors) {
				next.delete(ancestorUuid);
			}
			return next.size === previous.size ? previous : next;
		});
	}, [selectedFieldAncestors, selectedFormUuid]);

	useEffect(() => {
		if (pendingFocus === null) return;
		const trigger = document.querySelector<HTMLButtonElement>(
			`[data-module-actions="${pendingFocus.moduleUuid}"]`,
		);
		const fallback = pendingFocus.fallbackModuleUuid
			? document.querySelector<HTMLButtonElement>(
					`[data-module-actions="${pendingFocus.fallbackModuleUuid}"]`,
				)
			: null;
		const focusTarget = trigger ?? fallback;
		if (focusTarget === null) return;
		focusTarget.focus();
		setPendingFocus(null);
	}, [pendingFocus]);

	const handlePlacementCommitted = useCallback(
		(moduleUuid: Uuid, destinationParentModuleUuid?: Uuid | null) => {
			if (destinationParentModuleUuid) {
				setCollapsed((previous) => {
					if (!previous.has(destinationParentModuleUuid)) return previous;
					const next = new Set(previous);
					next.delete(destinationParentModuleUuid);
					return next;
				});
			}
			setPendingFocus({
				moduleUuid,
				...(destinationParentModuleUuid
					? { fallbackModuleUuid: destinationParentModuleUuid }
					: {}),
			});
		},
		[],
	);

	/* Search: compute match indices from entity maps.
	 * Only fires when the deferred query or entities change. */
	const searchResult = useSearchFilter(deferredQuery);

	if (rootModuleUuids.length === 0) {
		return (
			<div className="h-full flex items-center justify-center text-nova-text-muted text-sm">
				Building your app
			</div>
		);
	}

	return (
		<InsertionIntentProvider>
			{/* data-insertion-surface: hits inside this tree count as unobstructed
			 * for insertion-intent arming; hits in portalled popups don't. */}
			<div className="h-full flex flex-col" data-insertion-surface>
				{/* Search input */}
				<div className="shrink-0 px-3 py-3">
					<div className="relative">
						<Icon
							icon={tablerSearch}
							width="16"
							height="16"
							className="absolute left-2.5 top-1/2 -translate-y-1/2 text-nova-text-muted pointer-events-none"
						/>
						<Input
							type="text"
							value={searchQuery}
							disabled={locked}
							aria-label="Find in app"
							onChange={(e) => setSearchQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									if (searchQuery) setSearchQuery("");
									else (e.target as HTMLInputElement).blur();
								}
							}}
							placeholder="Find in app"
							autoComplete="off"
							data-1p-ignore
							className="nova-focusable h-11 bg-nova-surface pl-9 pr-11 text-sm text-nova-text placeholder:text-nova-text-muted dark:bg-nova-surface"
						/>
						{searchQuery && (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								disabled={locked}
								aria-label="Clear search"
								onClick={() => setSearchQuery("")}
								className="absolute right-0 top-1/2 -translate-y-1/2 text-nova-text-muted"
							>
								<Icon icon={tablerX} />
							</Button>
						)}
					</div>
				</div>

				{/* Scrollable module cards */}
				<div className="flex-1 overflow-auto">
					{searchResult && searchResult.visibleModuleUuids.size === 0 ? (
						<div className="flex items-center justify-center px-4 py-8 text-center text-sm text-nova-text-muted">
							No matches in your app
						</div>
					) : (
						<ul aria-label="App structure" className="m-0 list-none p-0">
							<AnimatePresence mode="sync">
								{/* Insertion points interleave between modules so new
								 *  modules can be added at any position: hidden while
								 *  a search filter is active or the app is locked. */}
								{interleaveInsertions(rootModuleUuids, {
									suppress: locked || !!searchResult,
									itemKey: (moduleId) => moduleId,
									renderItem: (_moduleId) =>
										searchResult &&
										!searchResult.visibleModuleUuids.has(_moduleId) ? null : (
											<ModuleCard
												key={_moduleId}
												moduleUuid={_moduleId}
												onSelect={handleSelect}
												collapsed={collapsed}
												toggle={toggle}
												searchResult={searchResult}
												locked={locked}
												childModuleUuids={
													childModuleUuidsByRoot[_moduleId] ?? []
												}
												rootModuleUuids={rootModuleUuids}
												childModuleUuidsByRoot={childModuleUuidsByRoot}
												siblingModuleUuids={rootModuleUuids}
												onPlacementCommitted={handlePlacementCommitted}
											/>
										),
									renderInsertion: (atIndex, key) => (
										<AddModulePopover
											key={key}
											parentModuleUuid={null}
											afterSiblingUuid={
												atIndex === 0
													? null
													: (rootModuleUuids[atIndex - 1] ?? null)
											}
											prominent={atIndex === rootModuleUuids.length}
										/>
									),
								})}
							</AnimatePresence>
						</ul>
					)}
				</div>
			</div>
		</InsertionIntentProvider>
	);
}
