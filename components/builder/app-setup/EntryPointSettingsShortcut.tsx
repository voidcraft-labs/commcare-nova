"use client";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { useEntryPointActions } from "@/lib/doc/hooks/useEntryPoints";
import type { EntryPointTarget } from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { EntryPointWriteNotice } from "./EntryPointWriteNotice";

export function EntryPointSettingsShortcut({
	target,
	onNavigateAway,
}: {
	target: EntryPointTarget;
	onNavigateAway?: () => void;
}) {
	const module = useModule(target.moduleUuid);
	const form = useForm(target.kind === "form" ? target.formUuid : undefined);
	const entryPoint =
		target.kind === "form"
			? form?.entryPoint
			: target.kind === "case-list"
				? module?.caseListEntryPoint
				: module?.entryPoint;
	const navigate = useNavigate();
	const actions = useEntryPointActions();
	const canEdit = useCanEdit();
	const [failure, setFailure] = useState<string>();
	const label =
		target.kind === "case-list"
			? "case list"
			: target.kind === "module"
				? "module"
				: "form";
	return (
		<div className="space-y-2">
			<Button
				variant="ghost-action"
				disabled={!entryPoint && canEdit && !actions.writeAdmission.ok}
				onClick={() => {
					if (entryPoint) {
						onNavigateAway?.();
						navigate.openAppSetup("deep-links", entryPoint.uuid);
						return;
					}
					if (!canEdit) {
						onNavigateAway?.();
						navigate.openAppSetup("deep-links");
						return;
					}
					const outcome = actions.add(target);
					if (!outcome.ok) {
						setFailure(outcome.messages[0]);
						return;
					}
					onNavigateAway?.();
					navigate.openAppSetup("deep-links", outcome.uuid);
				}}
			>
				{entryPoint
					? `Edit ${label} deep link`
					: canEdit
						? `Add ${label} deep link`
						: "View deep links"}
			</Button>
			{!entryPoint && canEdit && (
				<EntryPointWriteNotice admission={actions.writeAdmission} />
			)}
			{failure && (
				<p role="alert" className="text-sm text-nova-red">
					{failure}
				</p>
			)}
		</div>
	);
}
