"use client";
import { AnimatePresence, motion } from "motion/react";
import { Toggle } from "@/components/ui/Toggle";
import { useConnectTypeOrUndefined } from "@/lib/doc/hooks/useConnectType";
import { useSwitchConnectMode } from "@/lib/session/hooks";

/**
 * App-level CommCare Connect section in the App Settings panel. Mirrors the
 * form-level `ConnectSection`'s layout (header row with a Toggle, an
 * animated reveal beneath), but owns the APP's connect *type* rather than
 * a per-form config:
 *
 *   - Toggle off dispatches `null`, clearing the app connect type.
 *   - Toggle on dispatches `undefined`, which `switchConnectMode` resolves
 *     to the last-used mode (restoring the stashed app config) rather than
 *     forcing a fresh default.
 *   - The learn / deliver pills switch the active mode while enabled.
 *
 * Connect is meaningless without modules, but the App Settings panel only
 * mounts once the app has data (the subheader gates the whole toolbar on
 * `isReady && hasData`, and `hasData` means ≥1 module exists), so no
 * module-count guard is needed here.
 */
export function AppConnectSection() {
	const connectType = useConnectTypeOrUndefined();
	const switchMode = useSwitchConnectMode();
	const enabled = !!connectType;

	return (
		<div className="border-t border-white/[0.06] pt-3">
			{/* Header row: label + active-mode badge + enable/disable toggle. */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider">
						CommCare Connect
					</span>
					{connectType && (
						<span className="h-[18px] px-1.5 text-[10px] font-medium rounded bg-nova-violet/10 text-nova-violet-bright border border-nova-violet/20 flex items-center capitalize">
							{connectType}
						</span>
					)}
				</div>
				{/* `undefined` re-enables with the last mode (resolved inside
				 * switchConnectMode); `null` disables Connect entirely. */}
				<Toggle
					enabled={enabled}
					onToggle={() => switchMode(enabled ? null : undefined)}
				/>
			</div>

			<AnimatePresence>
				{enabled && (
					<motion.div
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<div
							className="flex items-center gap-1.5 pt-2.5"
							role="radiogroup"
							aria-label="Connect type"
						>
							{(["learn", "deliver"] as const).map((type) => {
								const isActive = connectType === type;
								return (
									<label
										key={type}
										className={`flex items-center h-[22px] px-2 text-[11px] font-medium rounded-full border outline-none transition-all duration-200 cursor-pointer ${
											isActive
												? "bg-nova-violet/10 border-nova-violet/30 text-nova-violet-bright shadow-[0_0_6px_rgba(139,92,246,0.1)]"
												: "bg-nova-surface border-nova-border/60 text-nova-text-muted hover:border-nova-violet/50 hover:text-nova-text-secondary"
										}`}
									>
										<input
											type="radio"
											name="app-connect-type"
											value={type}
											checked={isActive}
											onChange={() => switchMode(type)}
											className="sr-only"
										/>
										{type.charAt(0).toUpperCase() + type.slice(1)}
									</label>
								);
							})}
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
