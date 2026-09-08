import Link from "next/link";
import type { AnatomyRoleId } from "@/lib/agent/anatomy/types";
import { selectableSegmentCls } from "@/lib/styles";

/** Every role as a segment, so a reader moves between roles without going
 * back to the map. Scrolls sideways at compact widths. */
export function RoleSwitcher({
	roles,
	current,
}: {
	roles: readonly { id: AnatomyRoleId; title: string }[];
	current: AnatomyRoleId;
}) {
	return (
		<nav
			aria-label="Roles"
			className="-mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6 [scrollbar-width:none] md:mx-0 md:overflow-visible md:px-0"
		>
			<div className="flex w-max gap-1 pb-1 md:w-auto md:flex-wrap">
				{roles.map((role) => (
					<Link
						key={role.id}
						href={`/agents/${role.id}`}
						aria-current={role.id === current ? "page" : undefined}
						className={selectableSegmentCls(role.id === current)}
					>
						{role.title}
					</Link>
				))}
			</div>
		</nav>
	);
}
