"use client";
import { useId, useState } from "react";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { Switch } from "@/components/shadcn/switch";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useConnectRoles } from "@/lib/doc/hooks/useConnectRoles";
import { CONNECT_ROLE_LABELS, CONNECT_ROLES } from "@/lib/domain";
import { CONNECT_LOCATION_ON_ENABLE } from "@/lib/domain/platforms";
import { useCanEdit } from "@/lib/session/hooks";

export function AppConnectSection() {
	const id = useId();
	const roles = useConnectRoles();
	const platform = useAppSettings().runsOnlyOn;
	const [refusal, setRefusal] = useState<string | null>(null);
	const { setConnectRole } = useBlueprintMutations();
	const canEdit = useCanEdit();
	return (
		<fieldset className="space-y-2 border-t border-white/[0.06] pt-3">
			<legend className="flex items-center gap-1.5 text-xs font-medium text-nova-text-secondary">
				CommCare Connect{" "}
				<ConnectLogomark size={12} className="text-nova-violet-bright" />
			</legend>
			<p className="text-xs text-nova-text-muted">
				{platform === "android"
					? "Choose the roles your app serves. You can add activities wherever they belong in a form."
					: platform === "web-apps"
						? "You can choose Android only under Where workers use this app. Nova will check that your forms and media work on Android."
						: "Choosing a Connect role sets this app to Android only."}
			</p>
			<p className="text-xs text-nova-text-muted">
				{CONNECT_LOCATION_ON_ENABLE}
			</p>
			{CONNECT_ROLES.map((role) => (
				<div key={role} className="flex items-center justify-between gap-2">
					<label
						htmlFor={id + role}
						className="text-xs text-nova-text-secondary"
					>
						{CONNECT_ROLE_LABELS[role]}
					</label>
					<Switch
						id={id + role}
						checked={roles.includes(role)}
						disabled={!canEdit || platform === "web-apps"}
						onCheckedChange={(on) => {
							const result = setConnectRole(role, on);
							setRefusal(result.ok ? null : result.messages.join(" "));
						}}
					/>
				</div>
			))}
			{refusal && <RejectionInline message={refusal} />}
		</fieldset>
	);
}
