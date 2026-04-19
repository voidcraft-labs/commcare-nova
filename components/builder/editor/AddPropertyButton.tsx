import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";

interface AddPropertyButtonProps {
	label: string;
	onClick: () => void;
	className?: string;
}

/** Small pill button with a "+" icon, used to add optional properties/fields. */
export function AddPropertyButton({
	label,
	onClick,
	className = "",
}: AddPropertyButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`inline-flex items-center gap-1 px-2 py-1 text-xs text-nova-text-muted hover:text-nova-text-secondary bg-nova-deep/50 hover:bg-nova-surface/60 border border-white/[0.06] hover:border-nova-violet/20 rounded-md transition-colors cursor-pointer ${className}`}
		>
			<Icon icon={tablerPlus} width="10" height="10" />
			{label}
		</button>
	);
}
