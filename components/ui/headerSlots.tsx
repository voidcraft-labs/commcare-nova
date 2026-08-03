/**
 * How a surface fills the one header band it does not own.
 *
 * The band is mounted once, in `(app)/layout.tsx`, above both route groups —
 * that is the whole point, because a header rendered inside a route group is
 * torn down and rebuilt every time you cross between groups, and no amount of
 * matching geometry makes a rebuild feel like staying put.
 *
 * But the builder's controls can only be rendered from INSIDE the builder:
 * Preview, undo/redo, the save indicator, and Publish all read the doc and
 * session stores, which live under `BuilderProvider`, far below the header.
 * So they stay in the builder's React tree (where the stores reach them) and
 * are portaled into the band's DOM. Context flows down to hand the builder the
 * target nodes; the elements themselves never leave the tree that can feed
 * them.
 *
 * The claim is the other half: a surface says what the band should BE while it
 * is on screen, and the band's own menus leave for the duration.
 */

"use client";

import { createContext, useContext } from "react";

/** What a surface tells the band about itself. Absent means the ordinary site
 *  band: the mark, the nav, the Project switcher, Help, and the account. */
export interface HeaderClaim {
	/** The mark's accessible name and hover text on this surface. */
	readonly homeLabel: string;
	/** Hand the wordmark back and keep the sphere. */
	readonly markOnly: boolean;
	/** Give the claimed tools their own row under the band. */
	readonly stacked: boolean;
	/** Whether the account control may be on screen at all. The builder says
	 *  no while app access is unresolved: a control whose popup is deliberately
	 *  quarantined must not be left visible. */
	readonly showAccount: boolean;
	/** Whether the account's file manager may write. The builder says no,
	 *  which is what it has always done. */
	readonly canManageFiles: boolean;
}

export interface HeaderSlots {
	/** Portal targets inside the band. Null until the band has mounted, which
	 *  is also why nothing claimed renders on the server. */
	readonly center: HTMLElement | null;
	readonly actions: HTMLElement | null;
	/** Take the band, or hand it back with `null`. Stable across renders, so a
	 *  claiming effect can depend on it. */
	readonly claim: (claim: HeaderClaim | null) => void;
}

const HeaderSlotsContext = createContext<HeaderSlots | null>(null);

export const HeaderSlotsProvider = HeaderSlotsContext.Provider;

/** Null outside the app shell — the docs site and the landing page have no
 *  band to fill. A caller that gets null renders nothing rather than
 *  inventing a second header. */
export function useHeaderSlots(): HeaderSlots | null {
	return useContext(HeaderSlotsContext);
}

/** Claims are rebuilt every render, so the band compares them by value: a new
 *  object with the same answers is not a change, and treating it as one would
 *  put the header in a render loop with whatever is claiming it. */
export function sameHeaderClaim(
	a: HeaderClaim | null,
	b: HeaderClaim | null,
): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	return (
		a.homeLabel === b.homeLabel &&
		a.markOnly === b.markOnly &&
		a.stacked === b.stacked &&
		a.showAccount === b.showAccount &&
		a.canManageFiles === b.canManageFiles
	);
}
