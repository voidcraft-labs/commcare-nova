"use client";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { LocationSwitch } from "../LocationSwitch";

export function AppLocationSection() {
	const settings = useAppSettings();
	const { setAppSettings } = useBlueprintMutations();
	const connect = Boolean(useConnectTypeOrUndefined());
	const active = connect || settings.captureLocation === true;
	return (
		<LocationSwitch
			label="Request location for every form"
			checked={active}
			disabled={connect}
			active={active}
			description={
				connect
					? "Connect requests the worker’s location on every form."
					: active
						? "On Android, every form requests the worker’s location when it opens."
						: "Each form can request the worker’s location independently."
			}
			onChange={(captureLocation) => setAppSettings({ captureLocation })}
		/>
	);
}
