import tablerH6 from "@iconify-icons/tabler/h-6";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const HeadingSixIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerH6} className={className} />
));

HeadingSixIcon.displayName = "HeadingSixIcon";
