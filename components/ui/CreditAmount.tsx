import { Icon } from "@iconify/react/offline";
import type { ComponentPropsWithRef } from "react";
import { tablerCredits } from "@/components/icons/tablerExtras";
import { cn } from "@/lib/utils";

interface CreditAmountProps extends ComponentPropsWithRef<"span"> {
	/** The credit figure to show — a cost (e.g. 100) or a remaining balance. */
	value: number;
	/** When set, renders "value / total" — the account-menu balance-gauge form. */
	total?: number;
	/** Append the word "credits" after the number. Off by default: the tightest
	 *  surfaces (the composer cost chip, table cells) have no room for it and the
	 *  glyph already carries the meaning. Turn it on where there's space — the
	 *  account menu, empty states, or a tooltip that should spell it out. */
	showLabel?: boolean;
	/** Visual scale. `sm` matches the composer chip; `md` is body size. */
	size?: "sm" | "md";
}

const SIZES = {
	sm: { text: "text-[11px]", icon: "size-3", gap: "gap-1" },
	md: { text: "text-xs", icon: "size-3.5", gap: "gap-1.5" },
} as const;

/**
 * The canonical "nova credits" display — the credits glyph next to a figure,
 * used everywhere a credit amount appears (the composer cost chip, the
 * account-menu balance gauge, admin controls) so the look never drifts per
 * surface. Pure presentational (no hooks), safe in both server and client
 * trees, and it forwards `ref` + span props so it can serve directly as a
 * floating-element trigger (e.g. a Base UI `Tooltip.Trigger`). Numbers are
 * locale-formatted; the glyph carries the "credits" meaning when `showLabel` is
 * off (the default), so a tight surface needs no extra word. The default tone is
 * muted/informational — pass a `text-*` class to recolor.
 */
export function CreditAmount({
	value,
	total,
	showLabel = false,
	size = "sm",
	className,
	ref,
	...rest
}: CreditAmountProps) {
	const s = SIZES[size];
	return (
		<span
			ref={ref}
			className={cn(
				"inline-flex shrink-0 select-none items-center text-nova-text-muted tabular-nums",
				s.text,
				s.gap,
				className,
			)}
			{...rest}
		>
			<Icon icon={tablerCredits} className={s.icon} />
			<span>
				{value.toLocaleString()}
				{total !== undefined && ` / ${total.toLocaleString()}`}
				{showLabel && " credits"}
			</span>
		</span>
	);
}
