import tablerMinus from "@iconify-icons/tabler/minus";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const HorizontalRuleIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerMinus} className={className} />
));

HorizontalRuleIcon.displayName = "HorizontalRuleIcon";
