"use client";
import { Icon } from "@iconify/react/offline";
import tablerSettings from "@iconify-icons/tabler/settings";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import type { Uuid } from "@/lib/doc/types";
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
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={<Button variant="ghost" size="icon-lg" />}
				className="ml-auto size-11 text-nova-text-muted not-disabled:hover:bg-white/5 not-disabled:hover:text-nova-text"
				aria-label="Module settings"
			>
				<Icon icon={tablerSettings} className="size-5" />
			</PopoverTrigger>

			<PopoverContent
				side="bottom"
				align="end"
				sideOffset={8}
				collisionPadding={8}
				className="max-h-[calc(var(--available-height)-0.5rem)] w-80 max-w-[calc(var(--available-width)-0.5rem)] gap-0 overflow-hidden p-0"
			>
				<ModuleSettingsPanel
					moduleUuid={moduleUuid}
					onClose={() => setOpen(false)}
				/>
			</PopoverContent>
		</Popover>
	);
}
