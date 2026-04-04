import tablerItalic from "@iconify-icons/tabler/italic";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const ItalicIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerItalic} className={className} />
));

ItalicIcon.displayName = "ItalicIcon";
