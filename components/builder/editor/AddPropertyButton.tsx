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
			className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-nova-text-muted hover:text-nova-text bg-nova-deep/40 hover:bg-nova-deep/60 border border-white/[0.06] hover:border-nova-violet/30 rounded-lg transition-colors cursor-pointer ${className}`}
		>
			<Icon icon={tablerPlus} width="11" height="11" />
			{label}
		</button>
	);
}
