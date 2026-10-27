"use client";

import { useId } from "react";
import { Switch } from "@/components/shadcn/switch";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useOwnerPlatformFeatures } from "@/lib/doc/hooks/usePlatformNotes";
import type { PlatformFeatureOwner } from "@/lib/domain/platformUses";
import { PlatformNoteRow } from "../../shared/PlatformNoteRow";

const APP: PlatformFeatureOwner = { kind: "app" };

/**
 * The app's saved and incomplete forms lists: two switches, each reading the
 * document through `useAppSettings` and committing `setAppSettings` with the
 * one key it changes, so a stale editor never writes over a peer's change to
 * the other. The section holds no state of its own; the reducer is its state
 * model. Under each switch that is on, the platform note row says how a
 * platform the app runs on treats the list.
 */
export function AppSavedFormsSection() {
	const settings = useAppSettings();
	const { setAppSettings } = useBlueprintMutations();
	const features = useOwnerPlatformFeatures(APP, [
		"saved-forms",
		"incomplete-forms",
	]);

	return (
		<div className="border-t border-white/[0.06] pt-3">
			<span className="text-xs font-medium text-nova-text-secondary mb-1.5 block">
				Saved and incomplete forms
			</span>
			<div className="space-y-1.5">
				<SettingRow
					label="Show saved forms"
					description="Workers can look back at forms they have sent."
					checked={settings.showSavedForms}
					onChange={(next) => setAppSettings({ showSavedForms: next })}
				/>
				<PlatformNoteRow
					features={features.filter((feature) => feature === "saved-forms")}
				/>
				<SettingRow
					label="Show incomplete forms"
					description="Workers can pick up a form they started and left unfinished."
					checked={settings.showIncompleteForms}
					onChange={(next) => setAppSettings({ showIncompleteForms: next })}
				/>
				<PlatformNoteRow
					features={features.filter(
						(feature) => feature === "incomplete-forms",
					)}
				/>
			</div>
		</div>
	);
}

/** One labeled switch. The whole row toggles, so the target is the panel's
 *  full width, never just the switch. */
function SettingRow({
	label,
	description,
	checked,
	onChange,
}: {
	readonly label: string;
	readonly description: string;
	readonly checked: boolean;
	readonly onChange: (next: boolean) => void;
}) {
	const id = useId();
	return (
		<label
			htmlFor={id}
			className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-white/[0.05] bg-white/[0.03] px-2.5 py-1.5 transition-colors hover:border-white/[0.08]"
		>
			<span className="flex-1 min-w-0">
				<span className="block text-xs text-nova-text">{label}</span>
				<span className="mt-0.5 block text-xs leading-snug text-nova-text-muted">
					{description}
				</span>
			</span>
			<Switch id={id} checked={checked} onCheckedChange={onChange} />
		</label>
	);
}
