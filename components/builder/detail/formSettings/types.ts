import type { Uuid } from "@/lib/doc/types";

/** Props shared by every section mounted inside the form-settings panel. */
export interface FormSettingsSectionProps {
	moduleUuid: Uuid;
	formUuid: Uuid;
}
