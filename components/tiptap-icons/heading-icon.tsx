import tablerHeading from "@iconify-icons/tabler/heading";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const HeadingIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerHeading} className={className} />
));

HeadingIcon.displayName = "HeadingIcon";
