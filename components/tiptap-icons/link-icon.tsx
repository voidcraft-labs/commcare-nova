import tablerLink from "@iconify-icons/tabler/link";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const LinkIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerLink} className={className} />
));

LinkIcon.displayName = "LinkIcon";
