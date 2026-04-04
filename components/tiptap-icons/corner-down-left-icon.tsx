import tablerCornerDownLeft from "@iconify-icons/tabler/corner-down-left";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const CornerDownLeftIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerCornerDownLeft} className={className} />
));

CornerDownLeftIcon.displayName = "CornerDownLeftIcon";
