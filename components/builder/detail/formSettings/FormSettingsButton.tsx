"use client";
import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerSettings from "@iconify-icons/tabler/settings";
import { useCallback, useState } from "react";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { useConnectType } from "@/lib/doc/hooks/useConnectType";
import { useForm } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/doc/types";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";
import { FormSettingsPanel } from "./FormSettingsPanel";

/** Trigger prop shape — the same `{ moduleUuid, formUuid }` pair the
 *  panel itself consumes, carried through to `FormSettingsPanel`. */
interface FormSettingsButtonProps {
	moduleUuid: Uuid;
	formUuid: Uuid;
}

/**
 * Popover trigger that mounts the form-settings panel — the public mount
 * point rendered by `FormScreen`'s header. Shows the settings cog plus a
 * small Connect logomark badge when the form has an active ConnectConfig
 * so users can see at a glance which forms have been wired into a
 * deliver / learn app.
 *
 * The `handleOpenChange` wrapper protects against a dismissal race: a
 * CodeMirror autocomplete tooltip is portaled to `document.body` (outside
 * the popover's DOM subtree), so Base UI treats a click on it as an
 * outside-press and closes the popover. We swallow outside-press /
 * escape-key dismissals while a `.cm-tooltip-autocomplete` is in the DOM
 * so XPath completion clicks don't tear the panel down underneath them.
 */
export function FormSettingsButton({
	moduleUuid,
	formUuid,
}: FormSettingsButtonProps) {
	const form = useForm(formUuid);
	const connectType = useConnectType();
	const hasConnect = !!form?.connect && !!connectType;
	const [open, setOpen] = useState(false);

	const handleOpenChange = useCallback(
		(nextOpen: boolean, details: Popover.Root.ChangeEventDetails) => {
			if (
				!nextOpen &&
				(details.reason === "outside-press" ||
					details.reason === "escape-key") &&
				document.querySelector(".cm-tooltip-autocomplete")
			) {
				return;
			}
			setOpen(nextOpen);
		},
		[],
	);

	return (
		<Popover.Root open={open} onOpenChange={handleOpenChange}>
			<Popover.Trigger
				className="ml-auto flex items-center gap-1 p-1.5 rounded-md transition-colors cursor-pointer text-nova-text-muted hover:text-nova-text hover:bg-white/5"
				aria-label="Form settings"
			>
				<Icon icon={tablerSettings} width="18" height="18" />
				{hasConnect && (
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
						<FormSettingsPanel
							moduleUuid={moduleUuid}
							formUuid={formUuid}
							onClose={() => setOpen(false)}
						/>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
