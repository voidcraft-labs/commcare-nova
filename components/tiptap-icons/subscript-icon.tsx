import tablerSubscript from "@iconify-icons/tabler/subscript";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const SubscriptIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerSubscript} className={className} />
));

SubscriptIcon.displayName = "SubscriptIcon";
