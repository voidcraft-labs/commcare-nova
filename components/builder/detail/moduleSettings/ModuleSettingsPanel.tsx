"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { EntryPointSettingsShortcut } from "@/components/builder/app-setup/EntryPointSettingsShortcut";
import { DisplayConditionSection } from "@/components/builder/conditions/DisplayConditionSection";
import { PlatformNoteRow } from "@/components/builder/shared/PlatformNoteRow";
import { Button } from "@/components/shadcn/button";
import { PopoverTitle } from "@/components/shadcn/popover";
import { useOwnerPlatformFeatures } from "@/lib/doc/hooks/usePlatformNotes";
import type { Uuid } from "@/lib/doc/types";
import type { PlatformFeatureId } from "@/lib/domain/platforms";
import { MenuPlacementSection } from "./MenuPlacementSection";
import { ModuleAppearanceSection } from "./ModuleAppearanceSection";
import { ModuleCaseTypeSection } from "./ModuleCaseTypeSection";
import { ModuleNameSection } from "./ModuleNameSection";

/** What a module's own platform note can state: a case list on the menu. */
const MODULE_NOTE_FEATURES: readonly PlatformFeatureId[] = [
	"case-list-menu-item",
];

/** The module's platform note row: how a platform the app runs on shows a
 *  module that is only a case list. */
function ModulePlatformNotes({ moduleUuid }: { readonly moduleUuid: Uuid }) {
	const features = useOwnerPlatformFeatures(
		{ kind: "module", moduleUuid },
		MODULE_NOTE_FEATURES,
	);
	return <PlatformNoteRow features={features} />;
}

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
 * appearance, and menu sections (whether the module is on the menu, and the
 * display condition that applies while it is). The shell keeps its header
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
				<ModulePlatformNotes moduleUuid={moduleUuid} />
				<ModuleCaseTypeSection moduleUuid={moduleUuid} />
				<ModuleAppearanceSection moduleUuid={moduleUuid} />
				<DisplayConditionSection
					target={{ kind: "module", moduleUuid }}
					onNavigateAway={onClose}
				/>
			</div>
		</div>
	);
}
