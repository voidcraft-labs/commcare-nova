"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { EntryPointSettingsShortcut } from "@/components/builder/app-setup/EntryPointSettingsShortcut";
import { DisplayConditionSection } from "@/components/builder/conditions/DisplayConditionSection";
import { Button } from "@/components/shadcn/button";
import { PopoverTitle } from "@/components/shadcn/popover";
import { useAdvancedKindLine } from "@/lib/doc/hooks/useAdvancedKindReasons";
import type { Uuid } from "@/lib/doc/types";
import { CaseListMenuItemSection } from "./CaseListMenuItemSection";
import { MenuPlacementSection } from "./MenuPlacementSection";
import { MenuScreenSection } from "./MenuScreenSection";
import { ModuleAppearanceSection } from "./ModuleAppearanceSection";
import { ModuleCaseTypeSection } from "./ModuleCaseTypeSection";
import { ModuleNameSection } from "./ModuleNameSection";

/** Shell prop shape: the module being edited plus a dismiss callback
 *  wired from the popover trigger. */
interface ModuleSettingsPanelProps {
	moduleUuid: Uuid;
	onClose: () => void;
}

/**
 * Module-settings drawer body rendered inside the Popover popup. Pure
 * chrome: a labeled header with a dismiss button and a content region
 * that hosts the module's name (when it has no other screen), case type,
 * appearance, the case list in the menu (for a module with a case type),
 * menu sections (whether the module is on the menu, and the display
 * condition that applies while it is), and, for a menu CommCare HQ receives
 * as an advanced one, a read-only line saying why. The shell keeps its header
 * fixed while the body scrolls within the available viewport.
 */
export function ModuleSettingsPanel({
	moduleUuid,
	onClose,
}: ModuleSettingsPanelProps) {
	return (
		<div className="flex max-h-[calc(var(--available-height)-0.5rem)] min-h-0 w-full flex-col">
			{/* Header */}
			<div className="flex min-h-14 shrink-0 items-center justify-between border-b border-nova-border px-4">
				<PopoverTitle className="font-display tracking-tighter text-base font-semibold text-nova-text">
					Module settings
				</PopoverTitle>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={onClose}
					aria-label="Close module settings"
					className="-mr-2"
				>
					<Icon icon={tablerX} className="size-4" />
				</Button>
			</div>

			{/* Content */}
			<div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
				<ModuleNameSection moduleUuid={moduleUuid} />
				<EntryPointSettingsShortcut
					target={{ kind: "module", moduleUuid }}
					onNavigateAway={onClose}
				/>
				<EntryPointSettingsShortcut
					target={{ kind: "case-list", moduleUuid }}
					onNavigateAway={onClose}
				/>
				<MenuPlacementSection moduleUuid={moduleUuid} />
				<MenuScreenSection moduleUuid={moduleUuid} />
				<ModuleCaseTypeSection moduleUuid={moduleUuid} />
				<ModuleAppearanceSection moduleUuid={moduleUuid} />
				<CaseListMenuItemSection moduleUuid={moduleUuid} />
				<DisplayConditionSection
					target={{ kind: "module", moduleUuid }}
					onNavigateAway={onClose}
				/>
				<ModuleAdvancedKindRow moduleUuid={moduleUuid} />
			</div>
		</div>
	);
}

/**
 * **In CommCare HQ**: why CommCare HQ shows this menu as an advanced one,
 * read-only and shown only for a menu emitted advanced. Nova offers no way
 * to make a menu advanced; the line says when a publish keeps one so or a
 * link after submit needs one.
 */
function ModuleAdvancedKindRow({ moduleUuid }: { moduleUuid: Uuid }) {
	const line = useAdvancedKindLine(moduleUuid);
	if (line === undefined) return null;
	return (
		<div data-module-advanced-row>
			<span className="mb-2 block text-sm font-medium text-nova-text-secondary">
				In CommCare HQ
			</span>
			<p className="text-[13px] leading-relaxed text-nova-text-muted">{line}</p>
		</div>
	);
}
