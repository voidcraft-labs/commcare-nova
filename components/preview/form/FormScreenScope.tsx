/**
 * The screen the running form shows on Android, when it pages one screen at
 * a time without sections.
 *
 * Android pages an unsectioned form one screen per labeled group and per
 * question outside one (`lib/preview/platform.ts`, `formScreens`). The
 * running renderer keeps walking the whole field tree, so repeat entries,
 * capture slots and every engine path keep their usual identities, and this
 * scope decides what each row draws: the screen's own question or group,
 * every question under a group screen, and the containers on the way to it
 * (which draw no chrome on Android). `null` draws the whole form, which is
 * every other case: Web Apps' one screen, a section's page, edit mode.
 */
"use client";
import { createContext, useContext } from "react";

export const FormScreenScopeContext = createContext<string | null>(null);

export function useFormScreenScope(): string | null {
	return useContext(FormScreenScopeContext);
}

/** Whether the row at concrete `path` belongs on the screen at `screen`:
 *  the screen itself, a row under it, or a container it lies inside. */
export function onFormScreen(screen: string | null, path: string): boolean {
	if (screen === null) return true;
	return (
		path === screen ||
		path.startsWith(`${screen}/`) ||
		screen.startsWith(`${path}/`) ||
		screen.startsWith(`${path}[`)
	);
}
