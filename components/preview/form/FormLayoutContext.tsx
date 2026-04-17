/**
 * FormLayoutContext — shared layout state scoped to a single form screen.
 *
 * Houses state that must survive mode/cursor switches within a form (so
 * "flipbook" toggles between edit and live keep their layout intact):
 *
 *   - `collapsed` — uuids of groups/repeats folded by the user. Edit mode
 *     (`VirtualFormList`) and live mode (`InteractiveFormRenderer`) both
 *     read this set so a group collapsed in one mode stays collapsed in
 *     the other.
 *
 * Mounted once per form screen inside `FormScreen`. Unmounted when the
 * user navigates off the form, so collapse state is naturally per-form.
 */

"use client";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import type { Uuid } from "@/lib/doc/types";

interface FormLayoutContextValue {
	/** The live set of collapsed group/repeat uuids. Consumers that need
	 *  to participate in memoization (e.g. the row walker) read this
	 *  reference directly; the set identity changes on every toggle so
	 *  `useMemo` invalidates correctly. */
	readonly collapsed: ReadonlySet<Uuid>;
	/** Toggle a group/repeat's collapsed state. */
	readonly toggleCollapse: (uuid: Uuid) => void;
	/** Read whether a specific group/repeat is currently collapsed. */
	readonly isCollapsed: (uuid: Uuid) => boolean;
}

const FormLayoutContext = createContext<FormLayoutContextValue | null>(null);

export function FormLayoutProvider({ children }: { children: ReactNode }) {
	const [collapsed, setCollapsed] = useState<Set<Uuid>>(() => new Set<Uuid>());

	const toggleCollapse = useCallback((uuid: Uuid) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(uuid)) next.delete(uuid);
			else next.add(uuid);
			return next;
		});
	}, []);

	const isCollapsed = useCallback(
		(uuid: Uuid) => collapsed.has(uuid),
		[collapsed],
	);

	const value = useMemo<FormLayoutContextValue>(
		() => ({ collapsed, toggleCollapse, isCollapsed }),
		[collapsed, toggleCollapse, isCollapsed],
	);

	return (
		<FormLayoutContext.Provider value={value}>
			{children}
		</FormLayoutContext.Provider>
	);
}

export function useFormLayout(): FormLayoutContextValue {
	const ctx = useContext(FormLayoutContext);
	if (!ctx) {
		throw new Error("useFormLayout must be used inside <FormLayoutProvider>");
	}
	return ctx;
}
