/**
 * PresenceRoster — the who-else-is-here avatars in the BuilderHeader.
 *
 * One colored initials avatar per peer (self excluded, one per user even with
 * two tabs — the roster is deduped upstream by `usePresenceRoster`). Clicking a
 * peer FOLLOWS them: navigate to `recoverLocation(peer.location, doc)`, so a
 * click lands on their exact screen, or its nearest valid ancestor if the
 * entity they're on was since deleted. Each avatar's color is the peer's stable
 * palette hue, matching the canvas `PeerBadge` marker for the same person.
 *
 * Renders nothing when no peers are present (a solo session), so the header
 * cluster stays clean until someone else joins.
 */

"use client";

import { Tooltip } from "@/components/ui/Tooltip";
import { usePresenceRoster } from "@/lib/collab/PresenceProvider";
import type { Peer } from "@/lib/collab/presence";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import { useNavigate } from "@/lib/routing/hooks";
import { recoverLocation } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";
import { getInitials } from "@/lib/utils";

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

	return (
		<div className="flex items-center -space-x-1.5">
			{peers.map((peer) => (
				<PeerAvatar
					key={peer.userId}
					peer={peer}
					onFollow={() => navigate.push(recoverLocation(peer.location, doc))}
				/>
			))}
		</div>
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
				className={`flex items-center justify-center w-7 h-7 rounded-full ring-2 ring-nova-void cursor-pointer text-[11px] font-semibold text-nova-void transition-transform hover:scale-110 hover:z-10 focus-visible:outline-none focus-visible:ring-nova-text ${peer.peerColor.bg}`}
			>
				{getInitials(peer.name)}
			</button>
		</Tooltip>
	);
}
