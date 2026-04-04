import tablerArrowForwardUp from "@iconify-icons/tabler/arrow-forward-up";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const Redo2Icon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerArrowForwardUp} className={className} />
));

Redo2Icon.displayName = "Redo2Icon";
