"use client";
import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerSettings from "@iconify-icons/tabler/settings";
import { useState } from "react";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";
import { AppSettingsPanel } from "./AppSettingsPanel";

/**
 * App-level settings popover trigger mounted in `BuilderSubheader`. Always
 * available while the builder toolbar shows (the subheader gates the whole
 * control cluster on `isReady && hasData`), so there is no per-entity
 * availability check here. The panel hosts the app-level sections —
 * appearance (logo) and CommCare Connect mode.
 *
 * The trigger uses the toolbar's neutral-state styling (`min-h-[44px]`
 * button, muted text, hover surface) so it reads as a sibling of the other
 * toolbar controls. When the app is in a Connect mode it shows the Connect
 * logomark beside the gear — the app-level twin of the per-form settings
 * button's badge, so "this app uses Connect" reads at a glance. No CodeMirror
 * editor lives in this panel, so plain
 * `open` / `onOpenChange` state suffices — no outside-press dismissal
 * guard. The nested media picker / preview popovers live inside this
 * subtree, so Base UI doesn't treat a click on them as an outside press
 * that would tear the panel down.
 */
export function AppSettingsButton() {
	const [open, setOpen] = useState(false);
	const connectType = useConnectTypeOrUndefined();

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				className="flex items-center justify-center gap-1 min-w-[44px] min-h-[44px] rounded-lg transition-colors cursor-pointer text-nova-text-muted hover:text-nova-text hover:bg-white/5"
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
					sideOffset={8}
					className={POPOVER_POSITIONER_GLASS_CLS}
				>
					<Popover.Popup className={POPOVER_POPUP_CLS}>
						<AppSettingsPanel onClose={() => setOpen(false)} />
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
