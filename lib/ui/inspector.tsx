/**
 * Inspector rail — shared coordination state for the right-rail
 * properties inspector.
 *
 * The right rail is the chat sidebar. When a builder surface selects an
 * inspectable entity (a case-list column, a search input, a form field),
 * the rail flips to "docked" mode: the inspector panel
 * takes the rail's body and the chat condenses to a composer + signal
 * strip pinned beneath it. This module owns only the coordination
 * state for that flip; the inspector's chrome and content live with the
 * surface that renders them (see `components/builder/inspector/`).
 *
 * ## Claim model
 *
 * A surface claims the rail for as long as it has an active selection.
 * Claims stack — the most recent claim wins — because React 19's
 * `<Activity>` keeps hidden screens mounted: during a screen
 * transition the incoming surface can claim before the outgoing
 * surface's effect cleanup releases. Last-wins means the visible
 * surface's inspector is the one rendered, and the stale claim
 * evaporates a beat later when the hidden tree's effects are
 * destroyed.
 *
 * Claims are established in an effect (not during render) precisely so
 * Activity-hidden surfaces self-release: hiding a screen destroys its
 * effects, which releases its claim, which un-docks the rail.
 *
 * ## Portal target
 *
 * The chat sidebar registers the DOM node the inspector renders into.
 * The inspector content portals INTO the rail rather than the rail
 * rendering content out of shared state, so the content stays a live
 * part of the owning surface's React tree — fresh props, working
 * context, no stale-closure snapshots.
 */
"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";

/** Resting builder-rail width on roomy desktops. Chat and inspector always
 * share the same live width so selecting something never reflows the canvas. */
export const INSPECTOR_RAIL_WIDTH = 360;

/** Keep both sidebars open on a narrow desktop without reducing the workbench
 * to a phone-width sliver. Inspector bodies are container-responsive, and chat
 * remains a comfortable message column at this width. */
export const COMPACT_INSPECTOR_RAIL_WIDTH = 300;
export const COMPACT_BUILDER_RAIL_BREAKPOINT = 1200;

interface InspectorClaim {
	readonly id: number;
	/** Asks the claim's owner to clear its selection. The rail's
	 *  "expand chat" affordance routes through this so closing the
	 *  inspector and clearing the surface's selection stay one state. */
	readonly requestClose: () => void;
}

interface InspectorContextValue {
	/** DOM node the active inspector portals into. `null` until the
	 *  rail's docked layout mounts. */
	readonly portalEl: HTMLElement | null;
	/** Rail-side registration for the portal target. */
	readonly setPortalEl: (el: HTMLElement | null) => void;
	/** `true` when any surface holds a claim — drives the rail's
	 *  docked layout and width. */
	readonly active: boolean;
	/** The claim allowed to render its portal (last claimed). */
	readonly activeClaimId: number | null;
	/** Establish a claim; returns its id. Release via `release(id)`. */
	readonly claim: (requestClose: () => void) => number;
	readonly release: (id: number) => void;
	/** Close the active inspector by asking its owner to deselect. */
	readonly requestClose: () => void;
}

const InspectorContext = createContext<InspectorContextValue | null>(null);

export function InspectorProvider({ children }: { children: ReactNode }) {
	const [claims, setClaims] = useState<readonly InspectorClaim[]>([]);
	const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);
	const nextIdRef = useRef(1);

	const claim = useCallback((requestClose: () => void): number => {
		const id = nextIdRef.current++;
		setClaims((prev) => [...prev, { id, requestClose }]);
		return id;
	}, []);

	const release = useCallback((id: number): void => {
		setClaims((prev) => prev.filter((c) => c.id !== id));
	}, []);

	const activeClaim = claims.length > 0 ? claims[claims.length - 1] : undefined;
	const activeClaimId = activeClaim?.id ?? null;
	/* Ref-read so `requestClose` keeps a stable identity for consumers
	 * (the dock's expand button) while always reaching the current
	 * active claim. */
	const activeClaimRef = useRef(activeClaim);
	activeClaimRef.current = activeClaim;
	const requestClose = useCallback((): void => {
		activeClaimRef.current?.requestClose();
	}, []);

	const value = useMemo<InspectorContextValue>(
		() => ({
			portalEl,
			setPortalEl,
			active: activeClaimId !== null,
			activeClaimId,
			claim,
			release,
			requestClose,
		}),
		[portalEl, activeClaimId, claim, release, requestClose],
	);

	return (
		<InspectorContext.Provider value={value}>
			{children}
		</InspectorContext.Provider>
	);
}

/** Full context access — for `InspectorSurface` (claiming + portal). */
export function useInspectorContext(): InspectorContextValue {
	const ctx = useContext(InspectorContext);
	if (!ctx) {
		throw new Error(
			"Inspector hooks need an <InspectorProvider> above them — it mounts in the builder provider stack.",
		);
	}
	return ctx;
}

/** `true` while any surface holds an inspector claim. Rail layout +
 *  width gate on this. */
export function useInspectorActive(): boolean {
	return useInspectorContext().active;
}
