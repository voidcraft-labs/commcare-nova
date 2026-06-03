"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import type { Uuid } from "@/lib/doc/types";
import { ModuleAppearanceSection } from "./ModuleAppearanceSection";

/** Shell prop shape: the module being edited plus a dismiss callback
 *  wired from the popover trigger. */
interface ModuleSettingsPanelProps {
	moduleUuid: Uuid;
	onClose: () => void;
}

/**
 * Module-settings drawer body rendered inside the Popover popup. Pure
 * chrome — a labeled header with a dismiss button and a content region
 * that hosts the module's appearance section. Mirrors
 * `FormSettingsPanel`'s `w-80` drawer layout; the module surface
 * currently carries a single section (menu appearance), but the shell is
 * shaped to compose more the same way the form panel composes its three.
 */
export function ModuleSettingsPanel({
	moduleUuid,
	onClose,
}: ModuleSettingsPanelProps) {
	return (
		<div className="w-80">
			{/* Header */}
			<div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/[0.06]">
				<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider">
					Module Settings
				</span>
				<button
					type="button"
					onClick={onClose}
					className="p-1 -mr-1 rounded-md text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer"
				>
					<Icon icon={tablerX} width="14" height="14" />
				</button>
			</div>

			{/* Content */}
			<div className="px-3.5 py-3 space-y-3 overflow-y-auto max-h-[480px]">
				<ModuleAppearanceSection moduleUuid={moduleUuid} />
			</div>
		</div>
	);
}
