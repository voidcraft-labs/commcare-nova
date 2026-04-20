/**
 * Domain-owned form-type icon registry.
 *
 * Maps each `FormType` to its canonical `IconifyIcon` data object. Mirrors
 * the `fieldRegistry[kind].icon` pattern but for the four form types
 * (registration / followup / close / survey), giving every surface a
 * single source of truth for form-type iconography.
 *
 * Lives in `lib/domain/` because form types are a domain concept — see
 * `lib/domain/forms.ts` for the `FORM_TYPES` tuple and `FormType` union.
 * No consumer outside the domain layer should hardcode its own map.
 *
 * Icons are imported as data objects (not iconify ID strings) per the
 * synchronous-icon convention documented in the root CLAUDE.md — this
 * avoids the empty-span hydration frame the default `@iconify/react`
 * export produces.
 */
import type { IconifyIcon } from "@iconify/react/offline";
import tablerFile from "@iconify-icons/tabler/file";
import tablerFilePencil from "@iconify-icons/tabler/file-pencil";
import tablerFilePlus from "@iconify-icons/tabler/file-plus";
import tablerFileX from "@iconify-icons/tabler/file-x";
import type { FormType } from "./forms";

export const formTypeIcons: Record<FormType, IconifyIcon> = {
	registration: tablerFilePlus,
	followup: tablerFilePencil,
	close: tablerFileX,
	survey: tablerFile,
};
