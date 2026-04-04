import tablerStrikethrough from "@iconify-icons/tabler/strikethrough";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const StrikeIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerStrikethrough} className={className} />
));

StrikeIcon.displayName = "StrikeIcon";
