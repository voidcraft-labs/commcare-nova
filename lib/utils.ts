import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Up to two initials from a display name, uppercased — the account-menu avatar,
 * the presence roster, and the canvas peer markers all label an avatar with it,
 * so a name-rendering tweak lands in one place. Falls back to "?" for an
 * empty / whitespace-only name.
 */
export function getInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
	return parts[0]?.[0]?.toUpperCase() ?? "?";
}
