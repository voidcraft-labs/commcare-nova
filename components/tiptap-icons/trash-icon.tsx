import tablerTrash from "@iconify-icons/tabler/trash";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const TrashIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerTrash} className={className} />
));

TrashIcon.displayName = "TrashIcon";
