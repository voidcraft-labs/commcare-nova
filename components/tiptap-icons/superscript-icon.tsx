import tablerSuperscript from "@iconify-icons/tabler/superscript";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const SuperscriptIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerSuperscript} className={className} />
));

SuperscriptIcon.displayName = "SuperscriptIcon";
