import tablerPhoto from "@iconify-icons/tabler/photo";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const ImageIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerPhoto} className={className} />
));

ImageIcon.displayName = "ImageIcon";
