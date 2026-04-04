import tablerH2 from "@iconify-icons/tabler/h-2";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const HeadingTwoIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerH2} className={className} />
));

HeadingTwoIcon.displayName = "HeadingTwoIcon";
