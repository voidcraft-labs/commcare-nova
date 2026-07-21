import { Badge } from "@/components/shadcn/badge";

/**
 * An authored name — a case property, a case type — rendered as a data
 * chip rather than inline prose. Wrap-enabled so a long authored name
 * stays legible instead of truncating or stretching its row.
 */
export function NameChip({ label }: { readonly label: string }) {
	return (
		<Badge
			variant="outline"
			className="h-auto min-h-5 align-middle whitespace-normal [overflow-wrap:anywhere]"
		>
			{label}
		</Badge>
	);
}
