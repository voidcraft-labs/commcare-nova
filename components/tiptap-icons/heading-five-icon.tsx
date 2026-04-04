import tablerH5 from "@iconify-icons/tabler/h-5";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const HeadingFiveIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerH5} className={className} />
));

HeadingFiveIcon.displayName = "HeadingFiveIcon";
