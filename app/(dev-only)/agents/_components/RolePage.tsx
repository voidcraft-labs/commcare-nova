"use client";

import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { useEffect, useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Drawer,
	DrawerBackdrop,
	DrawerClose,
	DrawerContent,
	DrawerPopup,
	DrawerPortal,
	DrawerTitle,
	DrawerViewport,
} from "@/components/shadcn/drawer";
import type { RoleFacts } from "@/lib/agent/anatomy/catalog";
import type { MomentDiff } from "@/lib/agent/anatomy/diff";
import type {
	AnatomyRoleId,
	InputNeed,
	MomentSpec,
	WeighedMoment,
} from "@/lib/agent/anatomy/types";
import { useIsBreakpoint } from "@/lib/ui/hooks/useIsBreakpoint";
import { ContextList } from "./ContextList";
import { FactsBand } from "./FactsBand";
import { MomentDiffStrip } from "./MomentDiff";
import { MomentPicker } from "./MomentPicker";
import { ReadingPane } from "./ReadingPane";
import { RoleSwitcher } from "./RoleSwitcher";
import { SourcePicker, type SourceState } from "./SourcePicker";
import { TokenBar } from "./TokenBar";

const EXPANDED = 1024;

/**
 * One role, one moment at a time: the facts band, the moment picker, the
 * token bar, then the ordered context list beside the reading pane. Below
 * the expanded width the list is the page and the pane opens as a drawer.
 */
export function RolePage({
	facts,
	roles,
	lifecycles,
	moments,
	momentId,
	weighed,
	diff,
	providerOptions,
	modelLabel,
	sources,
}: {
	facts: RoleFacts;
	roles: readonly { id: AnatomyRoleId; title: string }[];
	lifecycles: readonly string[];
	moments: readonly MomentSpec[];
	momentId: string;
	weighed: WeighedMoment;
	diff: MomentDiff | null;
	providerOptions: unknown;
	modelLabel: string | null;
	sources: SourceState;
}) {
	const current =
		moments.find((moment) => moment.id === momentId) ?? moments[0];
	const expanded = useIsBreakpoint("min", EXPANDED);
	const firstId = weighed.items[0]?.id ?? null;
	const [selectedId, setSelectedId] = useState<string | null>(firstId);
	const [drawerOpen, setDrawerOpen] = useState(false);
	/* A new moment replaces the items; keep the selection when the id survives
	 * (the system prompt and tools usually do), else start at the top. */
	useEffect(() => {
		if (!weighed.items.some((item) => item.id === selectedId)) {
			setSelectedId(firstId);
		}
	}, [weighed.items, selectedId, firstId]);
	const selected = weighed.items.find((item) => item.id === selectedId) ?? null;
	const needs = new Set<InputNeed>(moments.flatMap((moment) => moment.needs));
	const select = (id: string) => {
		setSelectedId(id);
		if (!expanded) setDrawerOpen(true);
	};
	if (current === undefined) return null;
	return (
		<div className="space-y-6">
			<RoleSwitcher roles={roles} current={facts.role} />
			<div className="max-w-[72ch] space-y-1.5">
				<h1 className="font-display text-[28px] font-semibold leading-tight tracking-[-0.015em]">
					{facts.title}
				</h1>
				<p className="text-nova-text-secondary text-[15px] leading-relaxed">
					{facts.tagline}
				</p>
			</div>
			<FactsBand
				facts={facts}
				lifecycles={lifecycles}
				providerOptions={providerOptions}
				modelLabel={modelLabel}
			/>
			<SourcePicker sources={sources} needs={needs} />
			<MomentPicker moments={moments} current={current} />
			<TokenBar moment={weighed} selectedId={selectedId} onSelect={select} />
			{diff && <MomentDiffStrip diff={diff} onSelect={select} />}
			<div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
				<div className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
					<ContextList
						items={weighed.items}
						selectedId={selectedId}
						onSelect={select}
					/>
				</div>
				{expanded && (
					<div className="min-w-0 rounded-xl border border-nova-border bg-nova-surface p-5 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
						{selected ? (
							<ReadingPane key={selected.id} item={selected} />
						) : (
							<p className="text-nova-text-secondary text-sm">
								Pick an item on the left to read it here
							</p>
						)}
					</div>
				)}
			</div>
			{!expanded && (
				<Drawer
					open={drawerOpen}
					modal
					swipeDirection="right"
					onOpenChange={setDrawerOpen}
				>
					<DrawerPortal>
						<DrawerBackdrop className="fixed" />
						<DrawerViewport className="fixed z-raised justify-end">
							<DrawerPopup className="w-[min(100vw,640px)] border-nova-border-bright border-l [transform:translateX(var(--drawer-swipe-movement-x))] transition-transform duration-200 data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full">
								<DrawerContent className="flex h-full flex-col">
									<div className="flex shrink-0 items-center justify-between gap-3 border-nova-border border-b px-4 py-2">
										<DrawerTitle>{selected?.label ?? "Item"}</DrawerTitle>
										<DrawerClose
											render={
												<Button
													variant="ghost"
													size="icon"
													aria-label="Close"
												/>
											}
										>
											<Icon icon={tablerX} aria-hidden />
										</DrawerClose>
									</div>
									<div className="min-h-0 flex-1 overflow-y-auto p-4">
										{selected && (
											<ReadingPane key={selected.id} item={selected} />
										)}
									</div>
								</DrawerContent>
							</DrawerPopup>
						</DrawerViewport>
					</DrawerPortal>
				</Drawer>
			)}
		</div>
	);
}
