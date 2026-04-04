import tablerBold from "@iconify-icons/tabler/bold";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const BoldIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerBold} className={className} />
));

BoldIcon.displayName = "BoldIcon";
