import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import { CONNECT_TYPE_LABELS, type ConnectType } from "@/lib/domain";

interface ConnectBadgeProps {
	type: ConnectType;
}

/**
 * Read-only badge showing the Connect logomark and mode label in the
 * standard violet treatment. Matches the app-level connect toggle appearance.
 */
export function ConnectBadge({ type }: ConnectBadgeProps) {
	return (
		<span className="inline-flex items-center gap-1 text-nova-violet-bright">
			<ConnectLogomark size={14} />
			<span className="text-xs font-medium">{CONNECT_TYPE_LABELS[type]}</span>
		</span>
	);
}
