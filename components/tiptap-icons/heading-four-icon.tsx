import tablerH4 from "@iconify-icons/tabler/h-4";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const HeadingFourIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerH4} className={className} />
));

HeadingFourIcon.displayName = "HeadingFourIcon";
