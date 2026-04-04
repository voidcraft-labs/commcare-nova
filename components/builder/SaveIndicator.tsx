/**
 * SaveIndicator — persistent auto-save status in the builder subheader.
 *
 * Renders to the left of the Connect icon in the toolbar's right section.
 * Shows a ticking relative timestamp ("Saved just now", "Saved 2m ago")
 * so the user always has confidence their edits are persisted. The timestamp
 * ticks on a 15-second interval — frequent enough to feel alive, infrequent
 * enough to avoid needless re-renders.
 *
 * AnimatePresence handles only the mount/unmount transition (idle ↔ visible).
 * Status changes within the visible state (saving → saved, timestamp ticks)
 * update text and icon in place — no fade, no flash.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerCloudCheck from "@iconify-icons/tabler/cloud-check";
import tablerCloudOff from "@iconify-icons/tabler/cloud-off";
import tablerCloudUpload from "@iconify-icons/tabler/cloud-upload";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { SaveState } from "@/hooks/useAutoSave";
import { formatRelativeDate } from "@/lib/utils/format";

/** How often to re-render for the relative timestamp (ms). */
const TICK_MS = 15_000;

interface SaveIndicatorProps {
	saveState: SaveState;
}

export function SaveIndicator({ saveState }: SaveIndicatorProps) {
	const { status, savedAt } = saveState;

	/* Tick on a fixed interval to keep the relative timestamp current.
	 * Only active when displaying a "Saved" timestamp — paused during
	 * saving/error states and before the first save. The interval restarts
	 * on each new save (savedAt change) so the tick aligns with the timestamp. */
	const [, setTick] = useState(false);
	useEffect(() => {
		if (status !== "saved" || savedAt === null) return;
		const id = setInterval(() => setTick((t) => !t), TICK_MS);
		return () => clearInterval(id);
	}, [status, savedAt]);

	const visible = status !== "idle";

	const isSaving = status === "saving";
	const isError = status === "error";

	const icon = isError
		? tablerCloudOff
		: isSaving
			? tablerCloudUpload
			: tablerCloudCheck;
	const colorClass = isError ? "text-nova-rose/80" : "text-nova-text-muted";
	const label = isError
		? "Save failed"
		: isSaving
			? "Saving…"
			: `Saved ${formatRelativeDate(new Date(savedAt ?? Date.now())).toLowerCase()}`;

	return (
		<AnimatePresence>
			{visible && (
				<motion.div
					role={isError ? "alert" : undefined}
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.2 }}
					className={`flex items-center gap-1.5 pr-2 text-xs select-none ${colorClass}`}
				>
					<Icon icon={icon} width="14" height="14" />
					<span className="whitespace-nowrap">{label}</span>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
