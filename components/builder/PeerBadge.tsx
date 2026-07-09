/**
 * PeerBadge — the canvas marker for peers occupying a blueprint entity.
 *
 * `PeerBadge` renders a small cluster of colored initials dots on the entity a
 * peer occupies (a module row, a form tile, a field row, the inspector header),
 * one dot per peer with the same palette hue as their roster avatar. It reads
 * the roster grouped by entity uuid (`usePeersAt`) and looks up its own uuid,
 * so it renders nothing when no peer is on that entity — every entity can mount
 * a `PeerBadge` cheaply.
 *
 * `usePeerEditingColor(uuid)` returns the palette hue of a peer whose selection
 * IS that field (a `form` location with `selectedUuid === uuid`), or `null` —
 * the caller applies a live "editing this" ring in that color. The plain marker
 * says "a peer is here"; the ring says "a peer is editing THIS", so a field a
 * peer has selected gets both.
 */

"use client";

import Image from "next/image";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { PeerColor } from "@/lib/collab/presence";
import { usePeersAt } from "@/lib/collab/usePeersAt";
import { getInitials } from "@/lib/utils";

/**
 * The colored marker-dot cluster for peers on entity `uuid` — the peer's
 * photo (ringed in their palette hue) when their account has one, initials
 * on their palette fill otherwise. Renders nothing — no wrapper element at
 * all — when no peer occupies it, so an entity mounting a `PeerBadge` pays
 * no layout cost while solo. Kept compact (a horizontal overlap of small
 * dots) so it rides in a row's trailing gutter or a tile corner without
 * reflow. `className` positions the cluster at the call site.
 */
export function PeerBadge({
	uuid,
	className,
}: {
	uuid: string;
	className?: string;
}) {
	const { byEntity } = usePeersAt();
	const peers = byEntity.get(uuid);
	if (!peers || peers.length === 0) return null;

	return (
		<span
			className={`flex items-center -space-x-1 shrink-0${className ? ` ${className}` : ""}`}
			aria-hidden
		>
			{peers.map((peer) => (
				<SimpleTooltip
					key={peer.userId}
					content={`${peer.name || "A collaborator"} is here`}
				>
					{peer.image ? (
						<Image
							src={peer.image}
							alt=""
							width={16}
							height={16}
							referrerPolicy="no-referrer"
							unoptimized
							className={`w-4 h-4 rounded-full object-cover ring-1 ${peer.peerColor.ring}`}
						/>
					) : (
						<span
							className={`flex items-center justify-center w-4 h-4 rounded-full ring-1 ring-nova-void text-[8px] font-bold leading-none text-nova-void ${peer.peerColor.bg}`}
						>
							{getInitials(peer.name)}
						</span>
					)}
				</SimpleTooltip>
			))}
		</span>
	);
}

/**
 * The palette hue of a peer whose selection IS field `uuid` (the "editing this"
 * signal), or `null` when no peer has it selected. When two peers share a
 * selection the first (stable `userId` order) wins the ring color. The caller
 * applies `color.ring` as a `ring-*` class on the field's host element.
 */
export function usePeerEditingColor(uuid: string): PeerColor | null {
	const { editingByEntity } = usePeersAt();
	const editing = editingByEntity.get(uuid);
	return editing && editing.length > 0 ? editing[0].peerColor : null;
}
