import tablerH1 from "@iconify-icons/tabler/h-1";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const HeadingOneIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerH1} className={className} />
));

HeadingOneIcon.displayName = "HeadingOneIcon";
