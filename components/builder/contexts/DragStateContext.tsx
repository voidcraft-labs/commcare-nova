/**
 * DragStateContext — scoped drag-active flag for the form editor.
 *
 * Replaces `BuilderEngine._isDragging`. Lives alongside the `<DragDropProvider>`
 * in `FormRenderer.tsx` so the flag's lifetime matches the drag subsystem.
 *
 * Supports two modes:
 * - **Uncontrolled** (no props) — owns its own `useState`. Used when a child
 *   component drives the flag via `useSetDragActive()`.
 * - **Controlled** (`isActive` + `setActive` props) — parent owns the state.
 *   Used by `FormRenderer` where the `onDragStart`/`onDragEnd` callbacks live
 *   in the same component that renders the provider.
 *
 * Consumer hooks:
 * - `useSetDragActive()` — setter, throws outside provider (write without
 *   provider is always a bug).
 * - `useIsDragActive()` — reader, returns `false` outside provider (matches
 *   the engine's previous default, safe for components that render both inside
 *   and outside the drag tree).
 */
"use client";

import {
	createContext,
	type ReactNode,
	useContext,
	useMemo,
	useState,
} from "react";

interface DragStateApi {
	isActive: boolean;
	setActive: (active: boolean) => void;
}

const DragStateContext = createContext<DragStateApi | null>(null);

interface DragStateProviderProps {
	children: ReactNode;
	/** Controlled mode: external active flag. Omit for uncontrolled. */
	isActive?: boolean;
	/** Controlled mode: external setter. Required when `isActive` is provided. */
	setActive?: (active: boolean) => void;
}

/**
 * Provider that manages the boolean drag-active flag.
 *
 * In controlled mode (props provided), the parent owns the state — useful when
 * the parent component defines the drag callbacks and needs direct access to
 * the setter. In uncontrolled mode, the provider manages its own `useState`.
 */
export function DragStateProvider({
	children,
	isActive: controlledActive,
	setActive: controlledSetActive,
}: DragStateProviderProps) {
	const [ownActive, ownSetActive] = useState(false);

	/* Use controlled values when provided, fall back to internal state. */
	const isActive = controlledActive ?? ownActive;
	const setActive = controlledSetActive ?? ownSetActive;

	const api = useMemo<DragStateApi>(
		() => ({ isActive, setActive }),
		[isActive, setActive],
	);
	return <DragStateContext value={api}>{children}</DragStateContext>;
}

/**
 * Returns the `setActive` setter. Throws if called outside `DragStateProvider`
 * because writing drag state without the provider is always a bug.
 */
export function useSetDragActive(): (active: boolean) => void {
	const ctx = useContext(DragStateContext);
	if (!ctx) {
		throw new Error("useSetDragActive must be used within a DragStateProvider");
	}
	return ctx.setActive;
}

/**
 * Returns whether a drag is currently active. Returns `false` when consumed
 * outside the provider — matches the engine's previous default (`_isDragging = false`).
 */
export function useIsDragActive(): boolean {
	const ctx = useContext(DragStateContext);
	return ctx?.isActive ?? false;
}
