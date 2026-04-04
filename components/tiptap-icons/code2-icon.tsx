import tablerCode from "@iconify-icons/tabler/code";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const Code2Icon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerCode} className={className} />
));

Code2Icon.displayName = "Code2Icon";
