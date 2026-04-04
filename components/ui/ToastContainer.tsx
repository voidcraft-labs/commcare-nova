"use client";
import { Icon } from "@iconify/react/offline";
import tablerX from "@iconify-icons/tabler/x";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useToasts } from "@/hooks/useToasts";
import type { Toast, ToastSeverity } from "@/lib/services/toastStore";

const AUTO_DISMISS_MS: Record<ToastSeverity, number> = {
	error: 0, // persistent by default
	warning: 8000,
	info: 5000,
};

const ACCENT_COLORS: Record<ToastSeverity, string> = {
	error: "bg-nova-rose",
	warning: "bg-nova-amber",
	info: "bg-nova-violet",
};

const BORDER_COLORS: Record<ToastSeverity, string> = {
	error: "border-nova-rose/30",
	warning: "border-nova-amber/30",
	info: "border-nova-violet/30",
};

function ToastItem({
	toast,
	onDismiss,
}: {
	toast: Toast;
	onDismiss: (id: string) => void;
}) {
	const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const hovering = useRef(false);

	const startTimer = useCallback(() => {
		if (toast.persistent) return;
		const ms = AUTO_DISMISS_MS[toast.severity];
		if (ms <= 0) return;
		timerRef.current = setTimeout(() => onDismiss(toast.id), ms);
	}, [toast, onDismiss]);

	const clearTimer = useCallback(() => {
		if (timerRef.current) clearTimeout(timerRef.current);
	}, []);

	useEffect(() => {
		if (!hovering.current) startTimer();
		return clearTimer;
	}, [startTimer, clearTimer]);

	return (
		<motion.div
			layout
			initial={{ opacity: 0, x: 80, scale: 0.95 }}
			animate={{ opacity: 1, x: 0, scale: 1 }}
			exit={{ opacity: 0, x: 80, scale: 0.95 }}
			transition={{ type: "spring", stiffness: 400, damping: 30 }}
			onPointerEnter={() => {
				hovering.current = true;
				clearTimer();
			}}
			onPointerLeave={() => {
				hovering.current = false;
				startTimer();
			}}
			className={`relative flex gap-2.5 w-80 rounded-lg bg-nova-deep/95 backdrop-blur-xl border ${BORDER_COLORS[toast.severity]} p-3 pr-8 shadow-lg`}
		>
			{/* Left accent bar */}
			<div
				className={`shrink-0 w-1 rounded-full self-stretch ${ACCENT_COLORS[toast.severity]}`}
			/>

			{/* Content */}
			<div className="min-w-0">
				<p className="text-sm font-medium text-nova-text leading-tight">
					{toast.title}
				</p>
				{toast.message && (
					<p className="mt-0.5 text-xs text-nova-text-secondary leading-snug">
						{toast.message}
					</p>
				)}
			</div>

			{/* Close button */}
			<button
				type="button"
				onClick={() => onDismiss(toast.id)}
				className="absolute top-2 right-2 p-0.5 rounded text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
			>
				<Icon icon={tablerX} width={14} height={14} />
			</button>
		</motion.div>
	);
}

export function ToastContainer() {
	const store = useToasts();

	if (typeof document === "undefined") return null;

	return createPortal(
		<div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
			<AnimatePresence mode="popLayout">
				{store.toasts.map((toast) => (
					<div key={toast.id} className="pointer-events-auto">
						<ToastItem toast={toast} onDismiss={(id) => store.dismiss(id)} />
					</div>
				))}
			</AnimatePresence>
		</div>,
		document.body,
	);
}
