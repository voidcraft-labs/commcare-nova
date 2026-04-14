"use client";
import { Popover } from "@base-ui/react/popover";
import { useState } from "react";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { Toggle } from "@/components/ui/Toggle";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { ConnectType } from "@/lib/schemas/blueprint";
import { useSwitchConnectMode } from "@/lib/session/hooks";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";

export function AppConnectSettings() {
	const connectType = useBlueprintDoc((s) => s.connectType) as
		| ConnectType
		| undefined;
	const moduleCount = useBlueprintDoc((s) => s.moduleOrder.length);
	const switchMode = useSwitchConnectMode();
	const [open, setOpen] = useState(false);

	if (moduleCount === 0) return null;

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				className={`flex items-center gap-1.5 px-2.5 min-h-[44px] rounded-lg transition-colors cursor-pointer ${
					connectType
						? "text-nova-violet-bright hover:bg-nova-violet/10"
						: "text-nova-text-muted hover:text-nova-text hover:bg-white/5"
				}`}
				aria-label="Connect settings"
			>
				<ConnectLogomark size={16} />
				{connectType && (
					<span className="text-xs font-medium capitalize">{connectType}</span>
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
						<AppConnectPanel
							connectType={connectType}
							setConnectType={switchMode}
						/>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

function AppConnectPanel({
	connectType,
	setConnectType,
}: {
	connectType: ConnectType | undefined;
	setConnectType: (type: ConnectType | null | undefined) => void;
}) {
	const enabled = !!connectType;

	return (
		<div className="w-64">
			<div className="px-3.5 py-3 space-y-3">
				{/* Toggle — undefined signals "re-enable with last mode", resolved inside switchConnectMode */}
				<div className="flex items-center justify-between">
					<span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider">
						CommCare Connect
					</span>
					<Toggle
						enabled={enabled}
						onToggle={() => setConnectType(enabled ? null : undefined)}
					/>
				</div>

				{/* Type pills */}
				{enabled && (
					<div
						className="flex items-center gap-1.5"
						role="radiogroup"
						aria-label="Connect type"
					>
						{(["learn", "deliver"] as const).map((type) => {
							const isActive = connectType === type;
							return (
								<label
									key={type}
									className={`
                    h-[22px] px-2 text-[11px] font-medium rounded-full border outline-none transition-all duration-200 cursor-pointer
                    flex items-center
                    ${
											isActive
												? "bg-nova-violet/10 border-nova-violet/30 text-nova-violet-bright shadow-[0_0_6px_rgba(139,92,246,0.1)]"
												: "bg-nova-surface border-nova-border/60 text-nova-text-muted hover:border-nova-violet/50 hover:text-nova-text-secondary"
										}
                  `}
								>
									<input
										type="radio"
										name="connect-type"
										value={type}
										checked={isActive}
										onChange={() => setConnectType(type)}
										className="sr-only"
									/>
									{type.charAt(0).toUpperCase() + type.slice(1)}
								</label>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
