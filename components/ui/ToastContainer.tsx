"use client";
import type { IconifyIcon } from "@iconify/react/offline";
import { Icon } from "@iconify/react/offline";
import tablerAlertHexagon from "@iconify-icons/tabler/alert-hexagon";
import tablerAlertTriangle from "@iconify-icons/tabler/alert-triangle";
import tablerInfoCircle from "@iconify-icons/tabler/info-circle";
import tablerX from "@iconify-icons/tabler/x";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { useToasts } from "@/lib/ui/hooks/useToasts";
import type { Toast, ToastSeverity } from "@/lib/ui/toastStore";

const AUTO_DISMISS_MS: Record<ToastSeverity, number> = {
	error: 0, // persistent by default
	warning: 8000,
	info: 5000,
};

/* Each severity gets an icon in a soft tinted chip — the icon names the
 * register (guarded / caution / informational) so the title doesn't have
 * to, and the tint keeps the semantic hue an accent rather than a wash.
 * Error uses the alert-hexagon: in this app an error toast almost always
 * means the validity gate kept a change out — the same guardrail icon the
 * contextual rejection surfaces use (`RejectionNotice`), so the semantic
 * reads the same wherever a refused commit surfaces. */
const SEVERITY_CHROME: Record<
	ToastSeverity,
	{ icon: IconifyIcon; chip: string; border: string }
> = {
	error: {
		icon: tablerAlertHexagon,
		chip: "bg-nova-rose/10 text-nova-rose",
		border: "border-nova-rose/20",
	},
	warning: {
		icon: tablerAlertTriangle,
		chip: "bg-nova-amber/10 text-nova-amber",
		border: "border-nova-amber/20",
	},
	info: {
		icon: tablerInfoCircle,
		chip: "bg-nova-violet/10 text-nova-violet-bright",
		border: "border-nova-violet/20",
	},
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

	const chrome = SEVERITY_CHROME[toast.severity];
	const lines = toast.lines ?? [];

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
			className={`relative flex gap-3 w-[22rem] rounded-xl bg-nova-deep/95 backdrop-blur-xl border ${chrome.border} p-3.5 pr-9 shadow-[0_8px_32px_rgba(0,0,0,0.45)]`}
		>
			<div
				className={`shrink-0 flex items-center justify-center size-7 rounded-lg ${chrome.chip}`}
			>
				<Icon icon={chrome.icon} width={16} height={16} />
			</div>

			<div className="min-w-0 pt-0.5">
				<p className="text-sm font-medium text-nova-text leading-tight">
					{toast.title}
				</p>
				{toast.message && (
					/* whitespace-pre-line: legacy multi-line messages render as
					 * separate lines instead of collapsing into one run-on.
					 * Structured multi-row content should ride `lines`. */
					<p className="mt-1 text-xs text-nova-text-secondary leading-relaxed whitespace-pre-line">
						{toast.message}
					</p>
				)}
				{lines.length > 0 && (
					<ul className="mt-1.5 space-y-1.5">
						{lines.map((line, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: static finding list for one render; messages can legitimately repeat across forms
							<li key={i} className="flex gap-2">
								{/* Row marker only when there are rows to tell apart —
								 * a single finding reads as the toast's one sentence. */}
								{lines.length > 1 && (
									<span
										aria-hidden
										className="mt-[7px] size-1 shrink-0 rounded-full bg-nova-text-muted/60"
									/>
								)}
								<span className="text-xs text-nova-text-secondary leading-relaxed break-words">
									{line}
								</span>
							</li>
						))}
					</ul>
				)}
				{toast.action && (
					<button
						type="button"
						onClick={() => {
							toast.action?.onPress();
							onDismiss(toast.id);
						}}
						className="mt-1 -ml-2 min-h-11 cursor-pointer rounded-md px-2 text-xs font-semibold text-nova-violet-bright hover:text-nova-text"
					>
						{toast.action.label}
					</button>
				)}
			</div>

			<button
				type="button"
				onClick={() => onDismiss(toast.id)}
				className="absolute top-2.5 right-2.5 p-1 rounded-md text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer"
			>
				<Icon icon={tablerX} width={14} height={14} />
			</button>
		</motion.div>
	);
}

/**
 * ToastContainer — fixed-position toast stack rendered as a normal component.
 *
 * Placed in the root layout as a client component leaf — `position: fixed`
 * renders at the viewport level regardless of DOM position. No portal needed,
 * which avoids the server/client hydration mismatch that `createPortal` to
 * `document.body` would cause (body doesn't exist during SSR).
 */
export function ToastContainer() {
	const store = useToasts();

	return (
		<div className="fixed top-4 right-4 z-system flex flex-col gap-2 pointer-events-none">
			<AnimatePresence mode="popLayout">
				{store.toasts.map((toast) => (
					<div key={toast.id} className="pointer-events-auto">
						<ToastItem toast={toast} onDismiss={(id) => store.dismiss(id)} />
					</div>
				))}
			</AnimatePresence>
		</div>
	);
}
