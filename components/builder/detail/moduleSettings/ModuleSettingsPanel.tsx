"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { Button } from "@/components/shadcn/button";
import { PopoverTitle } from "@/components/shadcn/popover";
import type { Uuid } from "@/lib/doc/types";
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
 * chrome — a labeled header with a dismiss button and a content region
 * that hosts the module's name (when it has no other screen), case type, and
 * appearance sections. The shell keeps its header fixed while the body scrolls
 * within the available viewport.
 */
export function ModuleSettingsPanel({
	moduleUuid,
	onClose,
}: ModuleSettingsPanelProps) {
	return (
		<div className="flex max-h-[calc(var(--available-height)-0.5rem)] min-h-0 w-full flex-col">
			{/* Header */}
			<div className="flex min-h-14 shrink-0 items-center justify-between border-b border-nova-border px-4">
				<PopoverTitle className="font-display text-base font-semibold text-nova-text">
					Module settings
				</PopoverTitle>
				<Button
					type="button"
					variant="ghost"
					size="icon-lg"
					onClick={onClose}
					aria-label="Close module settings"
					className="-mr-2 size-11 text-nova-text-muted not-disabled:hover:bg-white/[0.06] not-disabled:hover:text-nova-text"
				>
					<Icon icon={tablerX} className="size-4" />
				</Button>
			</div>

			{/* Content */}
			<div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
				<ModuleNameSection moduleUuid={moduleUuid} />
				<ModuleCaseTypeSection moduleUuid={moduleUuid} />
				<ModuleAppearanceSection moduleUuid={moduleUuid} />
			</div>
		</div>
	);
}
