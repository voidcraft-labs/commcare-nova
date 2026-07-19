// components/builder/detail/moduleSettings/ModuleCaseTypeSection.tsx
//
// Module-settings section for viewing and changing a module's case type. Picks
// an existing type, creates a new one, or clears it — all through the gated
// `updateModule` (the inline flavor, so a rejection renders beside the control
// instead of only as a toast). The born-valid shaping lives in the
// `caseTypeSetPatch` / `caseTypeClearPatch` builders (`lib/doc/scaffolds`):
// setting a type seeds a "Name" column (and makes a formless module a viewer),
// clearing drops the case-list config AND the `caseListOnly` flag (so a module
// with forms becomes a survey). `updateModule` itself declares a brand-new type
// in the catalog and runs the case-type retirement cascade. A change the gate
// refuses surfaces inline — clearing the type while case forms still need it,
// or clearing a FORMLESS viewer (a module with neither forms nor a case list is
// invalid in CommCare, so the user must add a form first or delete the module).

"use client";
import { useRef, useState } from "react";
import { CaseTypePicker } from "@/components/builder/shared/CaseTypePicker";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import { useFormIds } from "@/lib/doc/hooks/useModuleIds";
import { caseTypeClearPatch, caseTypeSetPatch } from "@/lib/doc/scaffolds";
import type { Uuid } from "@/lib/doc/types";
import { humanizeId, type Module } from "@/lib/domain";

interface ModuleCaseTypeSectionProps {
	moduleUuid: Uuid;
}

interface PendingCaseTypeSwitch {
	readonly from: string;
	readonly to: string;
}

export function ModuleCaseTypeSection({
	moduleUuid,
}: ModuleCaseTypeSectionProps) {
	const module = useModule(moduleUuid);
	const formIds = useFormIds(moduleUuid);
	const { inline } = useBlueprintMutations();
	const [error, setError] = useState<string | null>(null);
	const [pendingSwitch, setPendingSwitch] =
		useState<PendingCaseTypeSwitch | null>(null);
	const [switchError, setSwitchError] = useState<string | null>(null);
	const [clearOpen, setClearOpen] = useState(false);
	const [clearError, setClearError] = useState<string | null>(null);
	const pickerTriggerRef = useRef<HTMLButtonElement>(null);

	if (!module) return null;
	const hasForms = (formIds?.length ?? 0) > 0;

	// The set/clear patches (including the born-valid Name-column seed and the
	// config drop on clear) live in `lib/doc/scaffolds` so the rule isn't
	// re-encoded here; this component just supplies what it already has.
	const apply = (patch: Partial<Omit<Module, "uuid">>) => {
		const outcome = inline.updateModule(moduleUuid, patch);
		setError(outcome.ok ? null : outcome.messages.join(" "));
		return outcome;
	};

	const restorePickerFocus = () => {
		requestAnimationFrame(() => pickerTriggerRef.current?.focus());
	};

	const chooseCaseType = (caseType: string) => {
		if (caseType === module.caseType) return;
		setError(null);
		setSwitchError(null);

		if (!module.caseType) {
			apply(caseTypeSetPatch(module, hasForms, caseType));
			return;
		}

		setPendingSwitch({ from: module.caseType, to: caseType });
	};

	const confirmCaseTypeSwitch = () => {
		if (!pendingSwitch) return;
		const outcome = inline.updateModule(
			moduleUuid,
			caseTypeSetPatch(module, hasForms, pendingSwitch.to),
		);
		if (outcome.ok) {
			setPendingSwitch(null);
			setSwitchError(null);
			setError(null);
			restorePickerFocus();
			return;
		}
		setSwitchError(outcome.messages.join(" "));
	};

	const clearCaseType = () => {
		const outcome = inline.updateModule(moduleUuid, caseTypeClearPatch());
		if (outcome.ok) {
			setClearOpen(false);
			setClearError(null);
			setError(null);
			restorePickerFocus();
			return;
		}
		setClearError(outcome.messages.join(" "));
	};

	return (
		<>
			<div>
				<span className="mb-2 block text-sm font-medium text-nova-text-secondary">
					Case type
				</span>
				<CaseTypePicker
					triggerRef={pickerTriggerRef}
					value={module.caseType}
					onChange={chooseCaseType}
					onClear={() => {
						setError(null);
						setClearError(null);
						setClearOpen(true);
					}}
				/>
				<p className="mt-2 text-[13px] leading-relaxed text-nova-text-muted">
					Choose the kind of case this module works with
				</p>
				{error && (
					<p
						role="alert"
						className="mt-2 text-xs leading-relaxed text-nova-rose"
					>
						{error}
					</p>
				)}
			</div>

			<AlertDialog
				open={pendingSwitch !== null}
				onOpenChange={(nextOpen) => {
					if (nextOpen) return;
					setPendingSwitch(null);
					setSwitchError(null);
					restorePickerFocus();
				}}
			>
				<AlertDialogContent className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display">
							{pendingSwitch
								? `Switch to ${humanizeId(pendingSwitch.to)} cases?`
								: "Switch case type?"}
						</AlertDialogTitle>
						<AlertDialogDescription className="text-left">
							{pendingSwitch
								? `Search, Results, and Details will use ${humanizeId(pendingSwitch.to)} cases. The current layout and rules will stay. Existing ${humanizeId(pendingSwitch.from)} cases won’t be deleted and will remain available to other modules that use them.`
								: "Search, Results, and Details will use the new case type."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{switchError && (
						<p
							role="alert"
							className="rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-3 text-sm leading-relaxed text-nova-rose"
						>
							{switchError}
						</p>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={confirmCaseTypeSwitch}>
							Switch
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				open={clearOpen}
				onOpenChange={(nextOpen) => {
					setClearOpen(nextOpen);
					if (!nextOpen) {
						setClearError(null);
						restorePickerFocus();
					}
				}}
			>
				<AlertDialogContent className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display">
							{hasForms ? "Stop managing cases?" : "Add a form first"}
						</AlertDialogTitle>
						<AlertDialogDescription className="text-left">
							{hasForms
								? `This removes Search, Results, and Details from this module, leaving only its forms. Existing ${humanizeId(module.caseType ?? "case")} cases won’t be deleted and will remain available to other modules that use them. Forms that use cases may need changes first.`
								: "This module has no forms, so stopping case management would leave it empty. Add a form first."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{clearError && (
						<p
							role="alert"
							className="rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-3 text-sm leading-relaxed text-nova-rose"
						>
							{clearError}
						</p>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel>
							{hasForms ? "Cancel" : "Close"}
						</AlertDialogCancel>
						{hasForms && (
							<AlertDialogAction variant="destructive" onClick={clearCaseType}>
								Stop managing
							</AlertDialogAction>
						)}
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
