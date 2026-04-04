import tablerExternalLink from "@iconify-icons/tabler/external-link";
import { memo } from "react";
import { TiptapIcon, type TiptapIconProps } from "./TiptapSvg";

export const ExternalLinkIcon = memo(({ className }: TiptapIconProps) => (
	<TiptapIcon icon={tablerExternalLink} className={className} />
));

ExternalLinkIcon.displayName = "ExternalLinkIcon";
