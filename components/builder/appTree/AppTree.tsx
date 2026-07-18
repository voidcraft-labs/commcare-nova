/**
 * AppTree — structure sidebar with per-entity subscriptions.
 *
 * Each tree component (ModuleCard, FormCard, FieldRow) subscribes to
 * its own entity in the builder store by ID/UUID. Immer structural
 * sharing means editing field A's label only re-renders FieldRow(A) in
 * the sidebar — not the other 166 FieldRows, not the FormCards, not the
 * ModuleCards.
 *
 * Selection uses boolean selectors — only the old and new selected
 * components re-render on selection change (2 total), not every tree
 * item.
 *
 * Search filtering operates directly on entity maps — no assembled
 * TreeData is constructed.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerX from "@iconify-icons/tabler/x";
import { AnimatePresence } from "motion/react";
import { useCallback, useDeferredValue, useState } from "react";
import { AddModulePopover } from "@/components/builder/appTree/insertion/AddModulePopover";
import { interleaveInsertions } from "@/components/builder/appTree/insertion/interleaveInsertions";
import { ModuleCard } from "@/components/builder/appTree/ModuleCard";
import { useAppTreeSelection } from "@/components/builder/appTree/useAppTreeSelection";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { useModuleIds } from "@/lib/doc/hooks/useModuleIds";
import { useSearchFilter } from "@/lib/doc/hooks/useSearchFilter";
import { BuilderPhase } from "@/lib/session/builderTypes";
import { useBuilderPhase } from "@/lib/session/hooks";
import { InsertionIntentProvider } from "@/lib/ui/hooks/useInsertionZone";

export function AppTree() {
	const moduleOrder = useModuleIds();
	const phase = useBuilderPhase();

	const locked =
		phase !== BuilderPhase.Ready && phase !== BuilderPhase.Completed;

	const handleSelect = useAppTreeSelection();
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [searchQuery, setSearchQuery] = useState("");
	const deferredQuery = useDeferredValue(searchQuery);

	const toggle = useCallback((key: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	/* Search: compute match indices from entity maps.
	 * Only fires when the deferred query or entities change. */
	const searchResult = useSearchFilter(deferredQuery);

	if (!moduleOrder || moduleOrder.length === 0) {
		return (
			<div className="h-full flex items-center justify-center text-nova-text-muted text-sm">
				Building your app…
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
							className="h-11 bg-nova-surface pl-9 pr-11 text-sm text-nova-text placeholder:text-nova-text-muted focus-visible:border-nova-violet focus-visible:ring-nova-violet/30 dark:bg-nova-surface"
						/>
						{searchQuery && (
							<Button
								type="button"
								variant="ghost"
								size="icon-lg"
								disabled={locked}
								aria-label="Clear search"
								onClick={() => setSearchQuery("")}
								className="absolute right-0 top-1/2 size-11 -translate-y-1/2 text-nova-text-muted not-disabled:hover:text-nova-text"
							>
								<Icon icon={tablerX} />
							</Button>
						)}
					</div>
				</div>

				{/* Scrollable module cards */}
				<div className="flex-1 overflow-auto">
					{searchResult && searchResult.visibleModuleIndices.size === 0 ? (
						<div className="flex items-center justify-center px-4 py-8 text-center text-sm text-nova-text-muted">
							No matches in your app
						</div>
					) : (
						<ul aria-label="App structure" className="m-0 list-none p-0">
							<AnimatePresence mode="sync">
								{/* Insertion points interleave between modules so new
								 *  modules can be added at any position — hidden while
								 *  a search filter is active or the app is locked. */}
								{interleaveInsertions(moduleOrder, {
									suppress: locked || !!searchResult,
									itemKey: (moduleId) => moduleId,
									renderItem: (_moduleId, mIdx) =>
										searchResult &&
										!searchResult.visibleModuleIndices.has(mIdx) ? null : (
											<ModuleCard
												key={_moduleId}
												moduleUuid={_moduleId}
												moduleIndex={mIdx}
												onSelect={handleSelect}
												collapsed={collapsed}
												toggle={toggle}
												searchResult={searchResult}
												locked={locked}
											/>
										),
									renderInsertion: (atIndex, key) => (
										<AddModulePopover
											key={key}
											atIndex={atIndex}
											prominent={atIndex === moduleOrder.length}
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
