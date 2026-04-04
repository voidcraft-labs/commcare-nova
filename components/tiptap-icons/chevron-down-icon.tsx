import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const ChevronDownIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerChevronDown} className={className} />
));

ChevronDownIcon.displayName = "ChevronDownIcon";
