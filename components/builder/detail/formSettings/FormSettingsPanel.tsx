"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { EntryPointSettingsShortcut } from "@/components/builder/app-setup/EntryPointSettingsShortcut";
import { DisplayConditionSection } from "@/components/builder/conditions/DisplayConditionSection";
import { MenuBadgeSection } from "@/components/builder/conditions/MenuBadgeSection";
import { ControlWording } from "@/components/builder/localization/ControlWording";
import { Button } from "@/components/shadcn/button";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { useIsCaseListRegistrationForm } from "@/lib/doc/hooks/useOfferedBatchRefusals";
import { useCanEdit } from "@/lib/session/hooks";
import { AfterSubmitSection } from "./AfterSubmitSection";
import { AnswerRootSection } from "./AnswerRootSection";
import { CaseChangesSection } from "./CaseChangesSection";
import { FormAppearanceSection } from "./FormAppearanceSection";
import { FormBehaviorSection } from "./FormBehaviorSection";
import { FormEntrySection } from "./FormEntrySection";
import { FormLocationSection } from "./FormLocationSection";
import { NoMatchesAfterSubmitSection } from "./NoMatchesAfterSubmitSection";
import { OwnCaseSection } from "./OwnCaseSection";
import { RecordNameSection } from "./RecordNameSection";
import { SubmitButtonSection } from "./SubmitButtonSection";
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
 * `OwnCaseSection`,
 * registration forms with somewhere to be offered from for
 * `FormEntrySection`). A case list registration form has a restricted after-submit choice
 * and no menu section: it is on no menu, so it takes neither "Show on the
 * menu" nor a display condition. Its native search return is scalar-only;
 * First menu is the explicit destination for either selection cardinality.
 */
export function FormSettingsPanel({
	moduleUuid,
	formUuid,
	onClose,
}: FormSettingsPanelProps) {
	const shared = useForm(formUuid)?.shadowOf;
	const noMatches = useIsCaseListRegistrationForm(moduleUuid, formUuid);
	const canEdit = useCanEdit();
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
			{canEdit ? (
				<div className="px-3.5 py-3 space-y-3 overflow-y-auto max-h-[480px]">
					{!shared && (
						<RecordNameSection moduleUuid={moduleUuid} formUuid={formUuid} />
					)}
					{!shared && (
						<OwnCaseSection moduleUuid={moduleUuid} formUuid={formUuid} />
					)}

					<FormEntrySection moduleUuid={moduleUuid} formUuid={formUuid} />
					<SubmitButtonSection formUuid={formUuid} />
					<FormBehaviorSection moduleUuid={moduleUuid} formUuid={formUuid} />
					{!noMatches && (
						<EntryPointSettingsShortcut
							target={{ kind: "form", moduleUuid, formUuid }}
							onNavigateAway={onClose}
						/>
					)}

					{noMatches ? (
						<NoMatchesAfterSubmitSection
							moduleUuid={moduleUuid}
							formUuid={formUuid}
						/>
					) : (
						<AfterSubmitSection
							moduleUuid={moduleUuid}
							formUuid={formUuid}
							onNavigateAway={onClose}
						/>
					)}

					{!shared && <FormLocationSection formUuid={formUuid} />}
					<FormAppearanceSection moduleUuid={moduleUuid} formUuid={formUuid} />
					{!noMatches && (
						<MenuBadgeSection moduleUuid={moduleUuid} formUuid={formUuid} />
					)}
					<AnswerRootSection formUuid={formUuid} />
					<ControlWording owner={formUuid} />

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
			) : (
				<div className="px-3.5 py-3">
					<AnswerRootSection formUuid={formUuid} />
				</div>
			)}
		</div>
	);
}
