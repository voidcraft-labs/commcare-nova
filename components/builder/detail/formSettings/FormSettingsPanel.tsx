"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { AfterSubmitSection } from "./AfterSubmitSection";
import { CloseConditionSection } from "./CloseConditionSection";
import { ConnectSection } from "./ConnectSection";
import type { FormSettingsSectionProps } from "./types";

/** Shell prop shape: the standard section props plus a dismiss callback
 *  wired from the popover trigger. Extending `FormSettingsSectionProps`
 *  keeps the `{ moduleUuid, formUuid }` contract in one place. */
interface FormSettingsPanelProps extends FormSettingsSectionProps {
	onClose: () => void;
}

/**
 * Form-settings drawer body rendered inside the Popover popup. Pure
 * chrome — a labeled header with a dismiss button and a scrollable
 * content region that composes the three feature sections in a fixed
 * vertical order. Each section decides whether it renders (close forms
 * only for `CloseConditionSection`, non-null `connectType` for
 * `ConnectSection`, always for `AfterSubmitSection`).
 */
export function FormSettingsPanel({
	moduleUuid,
	formUuid,
	onClose,
}: FormSettingsPanelProps) {
	return (
		<div className="w-80">
			{/* Header */}
			<div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/[0.06]">
				<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider">
					Form Settings
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
				<CloseConditionSection moduleUuid={moduleUuid} formUuid={formUuid} />

				<AfterSubmitSection moduleUuid={moduleUuid} formUuid={formUuid} />

				<ConnectSection moduleUuid={moduleUuid} formUuid={formUuid} />
			</div>
		</div>
	);
}
