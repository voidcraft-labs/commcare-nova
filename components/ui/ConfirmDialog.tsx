"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef } from "react";
import { createPortal } from "react-dom";

interface ConfirmDialogProps {
	open: boolean;
	title: string;
	message: string;
	confirmLabel?: string;
	confirmVariant?: "danger" | "default";
	onConfirm: () => void;
	onCancel: () => void;
}

export function ConfirmDialog({
	open,
	title,
	message,
	confirmLabel = "Confirm",
	confirmVariant = "default",
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;

	const dialogRef = useCallback((el: HTMLDivElement | null) => {
		if (!el) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCancelRef.current();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, []);

	if (typeof document === "undefined") return null;

	return createPortal(
		<AnimatePresence>
			{open && (
				<motion.div
					ref={dialogRef}
					className="fixed inset-0 z-modal flex items-center justify-center"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.15 }}
				>
					{/* Backdrop — button element so keyboard and pointer dismiss
              both work natively. tabIndex={-1} keeps it out of tab order
              since Escape (handled above) is the keyboard dismiss path. */}
					<button
						type="button"
						className="absolute inset-0 bg-black/60 cursor-default appearance-none border-none p-0"
						onClick={onCancel}
						tabIndex={-1}
						aria-label="Close dialog"
					/>

					{/* Dialog */}
					<motion.div
						className="relative z-10 w-80 rounded-xl bg-nova-deep border border-nova-border p-5 shadow-xl"
						initial={{ scale: 0.95, opacity: 0 }}
						animate={{ scale: 1, opacity: 1 }}
						exit={{ scale: 0.95, opacity: 0 }}
						transition={{ duration: 0.15 }}
					>
						<h3 className="text-sm font-semibold text-nova-text mb-2">
							{title}
						</h3>
						<p className="text-sm text-nova-text-secondary mb-4">{message}</p>
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={onCancel}
								className="px-3 py-1.5 text-xs font-medium rounded-lg border border-nova-border text-nova-text-secondary hover:text-nova-text transition-colors cursor-pointer"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={onConfirm}
								className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
									confirmVariant === "danger"
										? "bg-nova-rose text-white hover:brightness-110"
										: "bg-nova-violet text-white hover:brightness-110"
								}`}
							>
								{confirmLabel}
							</button>
						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>,
		document.body,
	);
}
