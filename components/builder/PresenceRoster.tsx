/**
 * PresenceRoster: the who-else-is-here avatars in the BuilderHeader.
 *
 * One avatar per peer (self excluded, one per user even with two tabs, the
 * roster is deduped upstream by `usePresenceRoster`): the peer's Google
 * profile PHOTO when their account has one, otherwise initials on their
 * palette fill. Either way the avatar wears the peer's stable palette hue as
 * a ring, matching the canvas `PeerBadge` markers and "editing this" ring
 * for the same person, so color stays the cross-surface identity signal.
 *
 * Clicking a peer FOLLOWS them: navigate to
 * `recoverLocation(peer.location, doc)`, so a click lands on their exact
 * screen, or its nearest valid ancestor if the entity they're on was since
 * deleted. Crowds cap at {@link MAX_AVATARS} circles: beyond that the tail
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
import { usePresenceRoster } from "@/lib/collab/PresenceProvider";
import { useLocationEntities } from "@/lib/doc/hooks/useLocationEntities";
import { useNavigate } from "@/lib/routing/hooks";
import { recoverLocation } from "@/lib/routing/location";
import { PresenceRosterView } from "./PresenceRosterView";

export { PresenceRosterView } from "./PresenceRosterView";

export function PresenceRoster({ compact = false }: { compact?: boolean }) {
	const peers = usePresenceRoster();
	const navigate = useNavigate();
	// Only the entity maps `recoverLocation` reads: a peer moving between
	// screens re-renders the roster (its `location` changed), but an unrelated
	// property edit does not.
	const doc = useLocationEntities();

	return (
		<PresenceRosterView
			peers={peers}
			compact={compact}
			onFollow={(peer) => navigate.push(recoverLocation(peer.location, doc))}
		/>
	);
}
