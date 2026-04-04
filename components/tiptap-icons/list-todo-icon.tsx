import tablerListCheck from "@iconify-icons/tabler/list-check";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const ListTodoIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerListCheck} className={className} />
));

ListTodoIcon.displayName = "ListTodoIcon";
