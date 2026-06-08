"use client";
import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerSettings from "@iconify-icons/tabler/settings";
import { useState } from "react";
import type { Uuid } from "@/lib/doc/types";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";
import { ModuleSettingsPanel } from "./ModuleSettingsPanel";

/** Trigger prop shape — the module uuid, carried through to the panel. */
interface ModuleSettingsButtonProps {
	moduleUuid: Uuid;
}

/**
 * Popover trigger that mounts the module-settings panel — the public
 * mount point rendered on the module home screen's header, alongside the
 * module title (the module-level analog of `FormSettingsButton` on the
 * form header). Shows the settings cog and opens the appearance drawer.
 *
 * Unlike `FormSettingsButton`, this panel hosts no CodeMirror editor, so
 * it needs no outside-press dismissal guard — plain `open` /
 * `onOpenChange` state suffices. (The form button swallows outside-press
 * dismissals while a `.cm-tooltip-autocomplete` is portaled to the body;
 * there is no such portal here.) The nested media picker / preview
 * popovers don't tear this panel down — they live inside its subtree, so
 * Base UI doesn't treat a click on them as an outside press.
 */
export function ModuleSettingsButton({
	moduleUuid,
}: ModuleSettingsButtonProps) {
	const [open, setOpen] = useState(false);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				className="ml-auto flex items-center gap-1 p-1.5 rounded-md transition-colors cursor-pointer text-nova-text-muted hover:text-nova-text hover:bg-white/5"
				aria-label="Module settings"
			>
				<Icon icon={tablerSettings} width="18" height="18" />
			</Popover.Trigger>

			<Popover.Portal>
				<Popover.Positioner
					side="bottom"
					align="end"
					sideOffset={8}
					className={POPOVER_POSITIONER_GLASS_CLS}
				>
					<Popover.Popup className={POPOVER_POPUP_CLS}>
						<ModuleSettingsPanel
							moduleUuid={moduleUuid}
							onClose={() => setOpen(false)}
						/>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
