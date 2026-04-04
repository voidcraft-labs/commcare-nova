/**
 * Shared formatting utilities for dates, currency, and app display.
 *
 * Used by the builds page, admin dashboard, and admin user profile.
 */

/**
 * Format a date as a human-readable relative string.
 *
 * Returns "Just now" for <1 minute, "Xm ago" for minutes, "Xh ago" for hours,
 * "Yesterday" for 1 day, "Xd ago" for 2-29 days, and locale date string beyond that.
 */
export function formatRelativeDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);

	if (diffMins < 1) return "Just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays === 1) return "Yesterday";
	if (diffDays < 30) return `${diffDays}d ago`;
	return date.toLocaleDateString();
}

/** Format a number as USD with 2 decimal places (e.g. "$12.34"). */
export function formatCurrency(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

/** Format a large token count in a compact form (e.g. 45000 → "45K"). */
export function formatTokenCount(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
	return String(count);
}

/**
 * Format a usage period string (e.g. "2026-04") as a human-readable label
 * (e.g. "April 2026").
 */
export function formatPeriodLabel(period: string): string {
	const [year, month] = period.split("-");
	const date = new Date(Number(year), Number(month) - 1);
	return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** Status badge colors and labels for app cards. */
export const STATUS_STYLES: Record<
	"complete" | "generating" | "error",
	{ bg: string; text: string; label: string }
> = {
	complete: {
		bg: "bg-nova-emerald/15",
		text: "text-nova-emerald",
		label: "Complete",
	},
	generating: {
		bg: "bg-nova-violet/15",
		text: "text-violet-400",
		label: "Generating",
	},
	error: { bg: "bg-nova-rose/15", text: "text-nova-rose", label: "Error" },
};
