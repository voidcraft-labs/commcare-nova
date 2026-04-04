import tablerBlockquote from "@iconify-icons/tabler/blockquote";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const BlockquoteIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerBlockquote} className={className} />
));

BlockquoteIcon.displayName = "BlockquoteIcon";
