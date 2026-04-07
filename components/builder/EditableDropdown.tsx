"use client";
import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";

interface EditableDropdownProps {
	label: string;
	value: string;
	options: Array<{ value: string; label: string }>;
	onSave: (value: string) => void;
	renderValue?: (value: string) => React.ReactNode;
}

export function EditableDropdown({
	label,
	value,
	options,
	onSave,
	renderValue,
}: EditableDropdownProps) {
	const [open, setOpen] = useState(false);
	const [saved, setSaved] = useState(false);

	const handleSelect = useCallback(
		(v: string) => {
			setOpen(false);
			onSave(v);
			if (v !== value) {
				setSaved(true);
				setTimeout(() => setSaved(false), 1500);
			}
		},
		[value, onSave],
	);

	const currentLabel = options.find((o) => o.value === value)?.label ?? value;

	return (
		<div>
			<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
				{label}
				<AnimatePresence>
					{saved && (
						<motion.span
							initial={{ opacity: 0, scale: 0.8 }}
							animate={{ opacity: 1, scale: 1 }}
							exit={{ opacity: 0, scale: 0.8 }}
							transition={{ duration: 0.2 }}
						>
							<Icon
								icon={tablerCheck}
								width="12"
								height="12"
								className="text-nova-emerald"
							/>
						</motion.span>
					)}
				</AnimatePresence>
			</span>
			<Popover.Root open={open} onOpenChange={setOpen}>
				<Popover.Trigger className="cursor-pointer hover:opacity-80 transition-opacity text-left">
					{renderValue ? (
						renderValue(value)
					) : (
						<span className="text-sm capitalize">{currentLabel}</span>
					)}
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Positioner
						side="bottom"
						align="start"
						sideOffset={4}
						className={POPOVER_POSITIONER_GLASS_CLS}
					>
						<Popover.Popup className={POPOVER_POPUP_CLS}>
							<div className="min-w-[160px] overflow-hidden">
								{options.map((opt) => (
									<button
										type="button"
										key={opt.value}
										onClick={() => handleSelect(opt.value)}
										className={`w-full text-left px-3 py-1.5 text-sm cursor-pointer hover:bg-nova-elevated/80 transition-colors flex items-center gap-2 ${
											opt.value === value
												? "text-nova-violet-bright"
												: "text-nova-text-secondary"
										}`}
									>
										<span
											className={`w-1.5 h-1.5 rounded-full shrink-0 ${opt.value === value ? "bg-nova-violet" : "bg-transparent"}`}
										/>
										{opt.label}
									</button>
								))}
							</div>
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>
		</div>
	);
}
