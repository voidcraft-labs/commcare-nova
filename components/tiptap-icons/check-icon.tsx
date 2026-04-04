import tablerCheck from "@iconify-icons/tabler/check";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const CheckIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerCheck} className={className} />
));

CheckIcon.displayName = "CheckIcon";
