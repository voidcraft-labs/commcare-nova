/**
 * PresenceRoster — the who-else-is-here avatars in the BuilderHeader.
 *
 * One avatar per peer (self excluded, one per user even with two tabs — the
 * roster is deduped upstream by `usePresenceRoster`): the peer's Google
 * profile PHOTO when their account has one, otherwise initials on their
 * palette fill. Either way the avatar wears the peer's stable palette hue as
 * a ring, matching the canvas `PeerBadge` markers and "editing this" ring
 * for the same person, so color stays the cross-surface identity signal.
 *
 * Clicking a peer FOLLOWS them: navigate to
 * `recoverLocation(peer.location, doc)`, so a click lands on their exact
 * screen, or its nearest valid ancestor if the entity they're on was since
 * deleted. Crowds cap at {@link MAX_AVATARS} circles — beyond that the tail
 * collapses into a "+N" chip opening a menu of the remaining peers (name +
 * where they are), each row still followable, so no presence is ever
 * invisible or unreachable.
 *
 * Renders nothing when no peers are present (a solo session), so the header
 * cluster stays clean until someone else joins; with peers it draws its own
 * right-hand divider, delineating the people cluster from the action icons
 * (the Google-Docs arrangement).
 */

"use client";

import Image from "next/image";
import type { ReactElement, RefAttributes } from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/shadcn/tooltip";
import { usePresenceRoster } from "@/lib/collab/PresenceProvider";
import type { Peer } from "@/lib/collab/presence";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import { useNavigate } from "@/lib/routing/hooks";
import { recoverLocation } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";
import { getInitials } from "@/lib/utils";

/** Avatars shown as circles; a larger roster shows one fewer plus a "+N"
 *  chip, so the cluster never grows past `MAX_AVATARS` circles wide. */
const MAX_AVATARS = 4;

/** A short "where they are" phrase for the follow tooltip. */
function whereLabel(location: Location): string {
	switch (location.kind) {
		case "home":
			return "on the app home";
		case "module":
			return "in a module";
		case "cases":
		case "search-config":
		case "detail-config":
			return "in the case list";
		case "set-aside":
			return "reviewing set-aside values";
		case "form":
			return location.selectedUuid !== undefined
				? "editing a field"
				: "in a form";
	}
}

export function PresenceRoster({ compact = false }: { compact?: boolean }) {
	const peers = usePresenceRoster();
	const navigate = useNavigate();
	// Only the entity maps `recoverLocation` reads — a peer moving between
	// screens re-renders the roster (its `location` changed), but an unrelated
	// property edit does not.
	const doc = useBlueprintDocShallow((s) => ({
		modules: s.modules,
		forms: s.forms,
		fields: s.fields,
	}));

	if (peers.length === 0) return null;

	const follow = (peer: Peer) =>
		navigate.push(recoverLocation(peer.location, doc));
	// Cap the circles: a roster past the cap shows MAX-1 avatars + a "+N"
	// chip carrying the rest, so the cluster's width is bounded.
	const capped = peers.length > MAX_AVATARS;
	const shown = capped ? peers.slice(0, MAX_AVATARS - 1) : peers;
	const overflow = capped ? peers.slice(MAX_AVATARS - 1) : [];
	if (compact) {
		return (
			<div className="flex items-center">
				<CompactRosterChip peers={peers} onFollow={follow} />
				<span aria-hidden className="ml-1 h-6 w-px bg-nova-border-bright" />
			</div>
		);
	}

	return (
		<div className="flex items-center">
			<div className="flex items-center gap-0.5">
				{shown.map((peer) => (
					<PeerAvatar
						key={peer.userId}
						peer={peer}
						onFollow={() => follow(peer)}
					/>
				))}
				{overflow.length > 0 && (
					<OverflowChip peers={overflow} onFollow={follow} />
				)}
			</div>
			{/* People/actions divider. `border-bright` matches the app's other
			 *  structural vertical divider (the sidebar edge — the plain token
			 *  reads too faint as a standalone line). The spacing is OPTICAL and
			 *  balances at ~17px per side: left, ml-5 minus the last avatar's
			 *  ~3px ring+offset overhang; right, the header's 4px gap plus a
			 *  13px leading inset EVERY possible neighbor presents — the
			 *  settings glyph's inset inside its 44px hit target, and the
			 *  matching pl/ml on the SaveIndicator and View-only badge. Keep
			 *  those three in step or the line drifts off-center. */}
			<span aria-hidden className="ml-5 h-6 w-px bg-nova-border-bright" />
		</div>
	);
}

/** One stable header target for compact layouts. The first collaborator keeps
 * the cross-surface color/face signal; a count badge communicates the crowd,
 * and the menu keeps every person individually followable. */
function CompactRosterChip({
	peers,
	onFollow,
}: {
	peers: readonly Peer[];
	onFollow: (peer: Peer) => void;
}) {
	const first = peers[0];
	if (first === undefined) return null;
	const label = `${peers.length} ${peers.length === 1 ? "collaborator" : "collaborators"} here`;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={label}
				className="group/button relative flex size-11 items-center justify-center rounded-full bg-transparent p-0 outline-none transition-all focus-visible:ring-3 focus-visible:ring-ring/50"
			>
				<span
					className={`flex size-7 items-center justify-center rounded-full ring-2 ${first.peerColor.ring} ring-offset-1 ring-offset-nova-void transition-transform group-hover/button:scale-110`}
				>
					<AvatarFace peer={first} size="md" />
				</span>
				{peers.length > 1 && (
					<span className="absolute right-0.5 bottom-0.5 flex min-w-4 items-center justify-center rounded-full border border-nova-void bg-nova-surface px-1 text-[9px] font-semibold leading-4 text-nova-text">
						+{peers.length - 1}
					</span>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent sideOffset={8} preferredMinWidth={220}>
				{peers.map((peer) => (
					<DropdownMenuItem key={peer.userId} onClick={() => onFollow(peer)}>
						<span className="flex min-w-0 items-center gap-2">
							<AvatarFace peer={peer} size="sm" />
							<span className="min-w-0">
								<span className="block truncate">
									{peer.name || "Collaborator"}
								</span>
								<span className="block truncate text-xs text-nova-text-muted first-letter:uppercase">
									{whereLabel(peer.location)}
								</span>
							</span>
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The avatar face: photo when the peer has one, initials on their palette
 *  fill otherwise — shared by the roster circles, the profile card, and the
 *  overflow rows. */
function AvatarFace({ peer, size }: { peer: Peer; size: "lg" | "md" | "sm" }) {
	const box = size === "lg" ? "w-9 h-9" : size === "md" ? "w-7 h-7" : "w-5 h-5";
	if (peer.image) {
		return (
			<Image
				src={peer.image}
				alt=""
				width={36}
				height={36}
				referrerPolicy="no-referrer"
				unoptimized
				className={`${box} rounded-full object-cover shrink-0`}
			/>
		);
	}
	return (
		/* `leading-none` centers the CAPS optically: with the inherited
		 * line-height the line box towers over the glyphs and flex centers
		 * the box, leaving the letters riding high of the circle's midline. */
		<span
			className={`${box} shrink-0 rounded-full flex items-center justify-center ${size === "sm" ? "text-[9px]" : size === "md" ? "text-[11px]" : "text-xs"} font-semibold leading-none text-nova-void ${peer.peerColor.bg}`}
		>
			{getInitials(peer.name)}
		</span>
	);
}

/**
 * The hover profile card — a two-zone glass surface whose ONE accent is the
 * peer's own palette hue, echoed exactly twice so the person's color reads
 * as their identity across the card: the avatar ring and the live-status
 * pulse dot. No "click to follow" caption — the affordance speaks through
 * the button semantics (cursor, aria-label, hover lift), Docs-style.
 *
 *   ┌──────────────────────────────┐
 *   │ ◉  Ada Lovelace              │  identity: face + name + email
 *   │    ada@dimagi.com            │  (email in the app's identifier mono)
 *   ├──────────────────────────────┤
 *   │ ● Editing a field            │  live status (heartbeat-true pulse)
 *   └──────────────────────────────┘
 *
 * Built on the Tooltip primitives directly (hover/focus semantics, a
 * non-interactive surface — the AVATAR is the control) rather than the
 * shared text `Tooltip`, because the card owns its container: glass on the
 * POSITIONER (the repo-wide floating-surface constraint) and a zero-padding
 * popup the zones fill edge-to-edge.
 */
function PeerHoverCard({
	peer,
	children,
}: {
	peer: Peer;
	children: ReactElement<RefAttributes<HTMLElement>>;
}) {
	return (
		<Tooltip>
			<TooltipTrigger delay={300} render={children} />
			<TooltipContent
				side="bottom"
				sideOffset={8}
				className="pointer-events-none w-60 max-w-[min(15rem,var(--available-width))] overflow-hidden rounded-xl p-0"
			>
				<div className="flex items-center gap-3 p-3">
					<AvatarFace peer={peer} size="lg" />
					<div className="min-w-0">
						<div className="truncate text-sm font-semibold text-nova-text">
							{peer.name || "Collaborator"}
						</div>
						{peer.email && (
							<div className="mt-0.5 truncate font-mono text-[11px] text-nova-text-muted">
								{peer.email}
							</div>
						)}
					</div>
				</div>
				<div className="flex items-center gap-1.5 border-t border-white/[0.06] bg-white/[0.03] px-3 py-2 text-[11px] text-nova-text-secondary">
					{/* Heartbeat-true: presence IS a live signal, so the dot
					 *  breathes (and holds still under reduced motion). */}
					<span
						className={`h-1.5 w-1.5 shrink-0 rounded-full ${peer.peerColor.bg} animate-pulse motion-reduce:animate-none`}
					/>
					<span className="min-w-0 truncate first-letter:uppercase">
						{whereLabel(peer.location)}
					</span>
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

function PeerAvatar({ peer, onFollow }: { peer: Peer; onFollow: () => void }) {
	return (
		<PeerHoverCard peer={peer}>
			<Button
				type="button"
				variant="ghost"
				size="xl"
				onClick={onFollow}
				aria-label={`Follow ${peer.name || "collaborator"}`}
				className="size-11 rounded-full bg-transparent p-0 not-disabled:hover:bg-transparent"
			>
				<span
					className={`flex size-7 items-center justify-center rounded-full ring-2 ${peer.peerColor.ring} ring-offset-1 ring-offset-nova-void transition-transform group-hover/button:scale-110`}
				>
					<AvatarFace peer={peer} size="md" />
				</span>
			</Button>
		</PeerHoverCard>
	);
}

/** The "+N" tail of a crowded roster — a menu of the remaining peers, each
 *  row followable, so every presence stays reachable however many join. */
function OverflowChip({
	peers,
	onFollow,
}: {
	peers: readonly Peer[];
	onFollow: (peer: Peer) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`${peers.length} more collaborators`}
				className="group/button flex size-11 items-center justify-center rounded-full bg-transparent p-0 text-[11px] font-semibold leading-none text-nova-text outline-none transition-all focus-visible:ring-3 focus-visible:ring-ring/50"
			>
				<span className="flex size-7 items-center justify-center rounded-full bg-nova-surface ring-2 ring-nova-border ring-offset-1 ring-offset-nova-void transition-transform group-hover/button:scale-110">
					+{peers.length}
				</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent sideOffset={8} preferredMinWidth={220}>
				{peers.map((peer) => (
					<DropdownMenuItem key={peer.userId} onClick={() => onFollow(peer)}>
						<span className="flex items-center gap-2">
							<AvatarFace peer={peer} size="sm" />
							<span className="min-w-0">
								<span className="block truncate">
									{peer.name || "Collaborator"}
								</span>
								{peer.email && (
									<span className="block truncate text-xs text-nova-text-muted">
										{peer.email}
									</span>
								)}
								<span className="block text-xs text-nova-text-muted">
									{whereLabel(peer.location)}
								</span>
							</span>
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
