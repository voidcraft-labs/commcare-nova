import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const Undo2Icon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerArrowBackUp} className={className} />
));

Undo2Icon.displayName = "Undo2Icon";
