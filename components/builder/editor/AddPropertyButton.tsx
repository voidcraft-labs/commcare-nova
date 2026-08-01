import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import { Button } from "@/components/shadcn/button";

interface AddPropertyButtonProps {
	label: string;
	onClick: () => void;
	className?: string;
}

/**
 * "Add this optional property" in the field inspector.
 *
 * It is the same gesture as every other add slot in the builder, so it wears
 * the same flat dashed affordance and inherits the one control height. It was
 * a hand-rolled 30px pill at 11px text, which put a second control size in a
 * rail where everything else is 44px and set its label a step below the type
 * scale's floor.
 */
export function AddPropertyButton({
	label,
	onClick,
	className = "",
}: AddPropertyButtonProps) {
	return (
		<Button
			type="button"
			variant="ghost"
			onClick={onClick}
			className={`nova-add-slot ${className}`}
		>
			<Icon icon={tablerPlus} width="15" height="15" />
			{label}
		</Button>
	);
}
