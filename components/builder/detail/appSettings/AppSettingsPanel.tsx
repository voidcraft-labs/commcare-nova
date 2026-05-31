"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { AppAppearanceSection } from "./AppAppearanceSection";

/** Shell prop shape: just a dismiss callback wired from the popover
 *  trigger. The app surface is a singleton — there is no entity uuid to
 *  thread through, unlike the form / module panels. */
interface AppSettingsPanelProps {
	onClose: () => void;
}

/**
 * App-settings drawer body rendered inside the Popover popup. Pure
 * chrome — a labeled header with a dismiss button and a content region
 * hosting the app-level appearance section. Mirrors `FormSettingsPanel`'s
 * `w-80` drawer layout; the app surface currently carries a single
 * section (the logo), but the shell is shaped to compose more the same
 * way the form panel composes its three.
 */
export function AppSettingsPanel({ onClose }: AppSettingsPanelProps) {
	return (
		<div className="w-80">
			{/* Header */}
			<div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/[0.06]">
				<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider">
					App Settings
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
				<AppAppearanceSection />
			</div>
		</div>
	);
}
