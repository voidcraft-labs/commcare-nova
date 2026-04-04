import tablerList from "@iconify-icons/tabler/list";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const ListIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerList} className={className} />
));

ListIcon.displayName = "ListIcon";
