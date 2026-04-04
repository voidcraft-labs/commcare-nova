import tablerTable from "@iconify-icons/tabler/table";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const TableIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerTable} className={className} />
));

TableIcon.displayName = "TableIcon";
