"use client";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { asUuid } from "@/lib/doc/types";
import { LocationSwitch } from "../LocationSwitch";
import type { FormSettingsSectionProps } from "./types";

export function FormLocationSection({
	formUuid,
}: Pick<FormSettingsSectionProps, "formUuid">) {
	const settings = useAppSettings();
	const connect = Boolean(useConnectTypeOrUndefined());
	const form = useForm(formUuid);
	const { inline } = useBlueprintMutations();
	if (!form) return null;
	const chosen = form.captureLocation === true;
	const all = connect || settings.captureLocation === true;
	return (
		<LocationSwitch
			label="Request location for this form"
			checked={chosen}
			active={chosen || all}
			description={
				all
					? `${connect ? "Connect" : "Your app"} requests location for every form. This form’s choice also applies if that changes.`
					: chosen
						? "On Android, opening this form requests the worker’s location."
						: "This form opens without requesting the worker’s location."
			}
			onChange={(next) =>
				inline.updateForm(asUuid(formUuid), {
					captureLocation: next ? true : null,
				})
			}
		/>
	);
}
