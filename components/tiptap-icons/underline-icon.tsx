import tablerUnderline from "@iconify-icons/tabler/underline";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const UnderlineIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerUnderline} className={className} />
));

UnderlineIcon.displayName = "UnderlineIcon";
