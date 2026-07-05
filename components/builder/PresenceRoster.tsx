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

import { Menu } from "@base-ui/react/menu";
import Image from "next/image";
import { Tooltip } from "@/components/ui/Tooltip";
import { usePresenceRoster } from "@/lib/collab/PresenceProvider";
import type { Peer } from "@/lib/collab/presence";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import { useNavigate } from "@/lib/routing/hooks";
import { recoverLocation } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
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
		case "form":
			return location.selectedUuid !== undefined
				? "editing a field"
				: "in a form";
	}
}

export function PresenceRoster() {
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

	return (
		<div className="flex items-center pr-3 mr-2 border-r border-nova-border">
			<div className="flex items-center -space-x-1.5">
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
		</div>
	);
}

/** The avatar face: photo when the peer has one, initials on their palette
 *  fill otherwise — shared by the roster circles and the overflow rows. */
function AvatarFace({ peer, size }: { peer: Peer; size: "md" | "sm" }) {
	const box = size === "md" ? "w-7 h-7" : "w-5 h-5";
	if (peer.image) {
		return (
			<Image
				src={peer.image}
				alt=""
				width={28}
				height={28}
				referrerPolicy="no-referrer"
				unoptimized
				className={`${box} rounded-full object-cover`}
			/>
		);
	}
	return (
		/* `leading-none` centers the CAPS optically: with the inherited
		 * line-height the line box towers over the glyphs and flex centers
		 * the box, leaving the letters riding high of the circle's midline. */
		<span
			className={`${box} rounded-full flex items-center justify-center ${size === "md" ? "text-[11px]" : "text-[9px]"} font-semibold leading-none text-nova-void ${peer.peerColor.bg}`}
		>
			{getInitials(peer.name)}
		</span>
	);
}

function PeerAvatar({ peer, onFollow }: { peer: Peer; onFollow: () => void }) {
	return (
		<Tooltip
			content={`Follow ${peer.name || "collaborator"} — ${whereLabel(peer.location)}`}
		>
			<button
				type="button"
				onClick={onFollow}
				aria-label={`Follow ${peer.name || "collaborator"}`}
				className={`flex items-center justify-center w-7 h-7 rounded-full ring-2 ${peer.peerColor.ring} ring-offset-1 ring-offset-nova-void cursor-pointer transition-transform hover:scale-110 hover:z-10 focus-visible:outline-none focus-visible:ring-nova-text`}
			>
				<AvatarFace peer={peer} size="md" />
			</button>
		</Tooltip>
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
		<Menu.Root>
			<Menu.Trigger
				aria-label={`${peers.length} more collaborators`}
				className="flex items-center justify-center w-7 h-7 rounded-full ring-2 ring-nova-border ring-offset-1 ring-offset-nova-void bg-nova-surface text-[11px] font-semibold leading-none text-nova-text cursor-pointer transition-transform hover:scale-110 hover:z-10 focus-visible:outline-none focus-visible:ring-nova-text"
			>
				+{peers.length}
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					className={MENU_POSITIONER_CLS}
					sideOffset={8}
					collisionPadding={8}
				>
					<Menu.Popup className={MENU_POPUP_CLS} style={{ minWidth: 220 }}>
						{peers.map((peer) => (
							<Menu.Item
								key={peer.userId}
								className={MENU_ITEM_CLS}
								onClick={() => onFollow(peer)}
							>
								<span className="flex items-center gap-2">
									<AvatarFace peer={peer} size="sm" />
									<span className="min-w-0">
										<span className="block truncate">
											{peer.name || "Collaborator"}
										</span>
										<span className="block text-xs text-nova-text-muted">
											{whereLabel(peer.location)}
										</span>
									</span>
								</span>
							</Menu.Item>
						))}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
