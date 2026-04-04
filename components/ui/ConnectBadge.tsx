import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import type { ConnectType } from "@/lib/schemas/blueprint";

interface ConnectBadgeProps {
	type: ConnectType;
}

/**
 * Read-only badge showing the Connect logomark and capitalized type label
 * in the standard violet treatment. Matches the app-level connect toggle appearance.
 */
export function ConnectBadge({ type }: ConnectBadgeProps) {
	return (
		<span className="inline-flex items-center gap-1 text-nova-violet-bright">
			<ConnectLogomark size={14} />
			<span className="text-xs font-medium capitalize">{type}</span>
		</span>
	);
}
