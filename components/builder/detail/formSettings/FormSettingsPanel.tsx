"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { DisplayConditionSection } from "@/components/builder/conditions/DisplayConditionSection";
import { Button } from "@/components/shadcn/button";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { isNoMatchesForm } from "@/lib/domain";
import { AfterSubmitSection } from "./AfterSubmitSection";
import { CaseChangesSection } from "./CaseChangesSection";
import { CloseConditionSection } from "./CloseConditionSection";
import { ConnectSection } from "./ConnectSection";
import { FormAppearanceSection } from "./FormAppearanceSection";
import { FormEntrySection } from "./FormEntrySection";
import type { FormSettingsSectionProps } from "./types";

/** Shell prop shape: the standard section props plus a dismiss callback
 *  wired from the popover trigger. Extending `FormSettingsSectionProps`
 *  keeps the `{ moduleUuid, formUuid }` contract in one place. */
interface FormSettingsPanelProps extends FormSettingsSectionProps {
	onClose: () => void;
}

/**
 * Form-settings drawer body rendered inside the Popover popup. Pure
 * chrome: a labeled header with a dismiss button and a scrollable
 * content region that composes the feature sections in a fixed vertical
 * order. Each section decides whether it renders (close forms only for
 * `CloseConditionSection`, non-null `connectType` for `ConnectSection`,
 * registration forms with somewhere to be offered from for
 * `FormEntrySection`). A no-matches registration form has no after-submit
 * choice and no display condition (its entry decides both), so those rows
 * give way to the entry row's explanation.
 */
export function FormSettingsPanel({
	moduleUuid,
	formUuid,
	onClose,
}: FormSettingsPanelProps) {
	const form = useForm(formUuid);
	const noMatches = form !== undefined && isNoMatchesForm(form);
	return (
		<div className="w-80">
			{/* Header */}
			<div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/[0.06]">
				<span className="text-xs font-medium text-nova-text-secondary">
					Form settings
				</span>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					aria-label="Close form settings"
					className="-mr-2"
					onClick={onClose}
				>
					<Icon icon={tablerX} width="16" height="16" />
				</Button>
			</div>

			{/* Content */}
			<div className="px-3.5 py-3 space-y-3 overflow-y-auto max-h-[480px]">
				<CloseConditionSection moduleUuid={moduleUuid} formUuid={formUuid} />

				<FormEntrySection moduleUuid={moduleUuid} formUuid={formUuid} />

				{!noMatches && (
					<AfterSubmitSection
						moduleUuid={moduleUuid}
						formUuid={formUuid}
						onNavigateAway={onClose}
					/>
				)}

				<ConnectSection moduleUuid={moduleUuid} formUuid={formUuid} />

				<FormAppearanceSection moduleUuid={moduleUuid} formUuid={formUuid} />

				{!noMatches && (
					<DisplayConditionSection
						target={{ kind: "form", moduleUuid, formUuid }}
						onNavigateAway={onClose}
					/>
				)}

				<CaseChangesSection
					moduleUuid={moduleUuid}
					formUuid={formUuid}
					onNavigateAway={onClose}
				/>
			</div>
		</div>
	);
}
