"use client";
import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerSettings from "@iconify-icons/tabler/settings";
import dynamic from "next/dynamic";
import { useState } from "react";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useBuilderIsReady, useCanEdit } from "@/lib/session/hooks";
import {
	FLOATING_LAYER_CLS,
	POPOVER_POPUP_CLS,
	POPOVER_POSITIONER_GLASS_CLS,
} from "@/lib/styles";

const loadAppSettingsPanel = () => import("./AppSettingsPanel");
const AppSettingsPanel = dynamic(
	() => loadAppSettingsPanel().then((module) => module.AppSettingsPanel),
	{
		loading: () => (
			<div className="min-w-64 p-4 text-sm text-nova-text-muted" role="status">
				Opening app settings
			</div>
		),
	},
);

/**
 * App-level settings popover trigger: the gear in the structure
 * sidebar's app row, beside the app name. Renders only for a ready
 * editor (`isReady && hasData && canEdit`): settings are an edit
 * affordance, so viewers and in-flight generations see the app row
 * without it. The panel hosts the app-level sections: appearance
 * (logo) and CommCare Connect mode.
 *
 * When the app is in a Connect mode the gear carries the Connect
 * logomark: the app-level twin of the per-form settings button's
 * badge, so "this app uses Connect" reads at a glance. No CodeMirror
 * editor lives in this panel, so plain `open` / `onOpenChange` state
 * suffices: no outside-press dismissal guard. The nested media
 * picker / preview popovers live inside this subtree, so Base UI
 * doesn't treat a click on them as an outside press that would tear
 * the panel down.
 */
export function AppSettingsButton() {
	const [open, setOpen] = useState(false);
	const connectType = useConnectTypeOrUndefined();
	const hasData = useDocHasData();
	const isReady = useBuilderIsReady();
	const canEdit = useCanEdit();

	if (!(isReady && hasData && canEdit)) return null;

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				onPointerEnter={() => void loadAppSettingsPanel()}
				onFocus={() => void loadAppSettingsPanel()}
				className="nova-focusable flex items-center justify-center gap-1 min-w-11 min-h-11 rounded-xl transition-colors cursor-pointer text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06] data-[popup-open]:text-nova-text data-[popup-open]:bg-white/[0.06]"
				aria-label="App settings"
			>
				<Icon icon={tablerSettings} width="18" height="18" />
				{connectType && (
					<ConnectLogomark size={12} className="text-nova-violet-bright" />
				)}
			</Popover.Trigger>

			<Popover.Portal>
				<Popover.Positioner
					side="bottom"
					align="end"
					sideOffset={6}
					className={`${FLOATING_LAYER_CLS} ${POPOVER_POSITIONER_GLASS_CLS}`}
				>
					<Popover.Popup className={POPOVER_POPUP_CLS}>
						<AppSettingsPanel onClose={() => setOpen(false)} />
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
