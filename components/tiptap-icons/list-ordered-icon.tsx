import tablerListNumbers from "@iconify-icons/tabler/list-numbers";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const ListOrderedIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerListNumbers} className={className} />
));

ListOrderedIcon.displayName = "ListOrderedIcon";
