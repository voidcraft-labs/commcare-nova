import tablerH3 from "@iconify-icons/tabler/h-3";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const HeadingThreeIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerH3} className={className} />
));

HeadingThreeIcon.displayName = "HeadingThreeIcon";
