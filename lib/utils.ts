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
	// Take each word's first CODE POINT (the string iterator), never `word[0]`
	// — indexing is by UTF-16 code unit, so a name starting with a non-BMP
	// character (an emoji, astral-plane CJK) would split the surrogate pair
	// and render "�".
	const initials = name
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => [...word][0] ?? "");
	if (initials.length >= 2) {
		return `${initials[0]}${initials[1]}`.toUpperCase();
	}
	return initials[0]?.toUpperCase() || "?";
}
