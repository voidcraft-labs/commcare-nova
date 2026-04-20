/**
 * Keyboard navigation hook for menu/toolbar containers.
 *
 * Installed as a dependency of the TipTap CLI Toolbar primitive.
 * Handles arrow-key navigation between focusable items in a container.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UseMenuNavigationConfig<T extends HTMLElement> {
	containerRef: React.RefObject<T | null>;
	items: HTMLElement[];
	orientation?: "horizontal" | "vertical";
	onSelect?: (el: HTMLElement) => void;
	autoSelectFirstItem?: boolean;
}

export function useMenuNavigation<T extends HTMLElement>({
	containerRef,
	items,
	orientation = "horizontal",
	onSelect,
	autoSelectFirstItem = false,
}: UseMenuNavigationConfig<T>) {
	const [selectedIndex, setSelectedIndex] = useState<number | undefined>(
		autoSelectFirstItem && items.length > 0 ? 0 : undefined,
	);

	/** Ref mirror of selectedIndex — used in the Enter/Space handler so that
	 * `handleKeyDown` doesn't need `selectedIndex` in its dependency array.
	 * Without this, every arrow-key press recreates the callback and re-binds
	 * the DOM listener, which is wasteful for a high-frequency interaction. */
	const selectedIndexRef = useRef(selectedIndex);
	selectedIndexRef.current = selectedIndex;

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (!items.length) return;

			const prevKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
			const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";

			if (e.key === prevKey) {
				e.preventDefault();
				setSelectedIndex((prev) => {
					const idx =
						prev !== undefined
							? (prev - 1 + items.length) % items.length
							: items.length - 1;
					return idx;
				});
			} else if (e.key === nextKey) {
				e.preventDefault();
				setSelectedIndex((prev) => {
					const idx = prev !== undefined ? (prev + 1) % items.length : 0;
					return idx;
				});
			} else if (e.key === "Enter" || e.key === " ") {
				const idx = selectedIndexRef.current;
				if (idx !== undefined && items[idx]) {
					e.preventDefault();
					onSelect?.(items[idx]);
				}
			}
		},
		[items, orientation, onSelect],
	);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		container.addEventListener("keydown", handleKeyDown);
		return () => container.removeEventListener("keydown", handleKeyDown);
	}, [containerRef, handleKeyDown]);

	return { selectedIndex };
}
