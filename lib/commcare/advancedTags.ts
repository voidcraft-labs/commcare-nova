/**
 * The case tags of an advanced form's actions.
 *
 * Every load and open action of an HQ advanced form carries a `case_tag`,
 * the name the form's other actions and HQ's build use for it: an index
 * names its parent by tag, and HQ writes an action's case block at the
 * data-root element `case_<tag>`
 * (`corehq/apps/app_manager/models/form_actions.py::AdvancedAction.form_element_name`).
 *
 * A derived tag is the one a person adding the action on HQ's case
 * configuration page gets
 * (`static/app_manager/js/forms/advanced/case_config_ui.js::addFormAction`):
 * a load `load_<case type><n>`, the worker's load `autoload_commcare-user<n>`
 * (the page's auto-select prefix `auto` on the worker's case type), and an
 * open action `open_<case type>_<n>`. The page uses the module's case type
 * for every new action; Nova uses the action's own, which names what the tag
 * holds and passes the same check. Nova spells a case type's `-` as `_`
 * (the worker's load is `autoload_commcare_user<n>`), since the tag names
 * the element `case_<tag>` and Nova's XForm element names hold no `-`; the
 * page's check accepts either. `n` starts at the action's position among
 * the form's loads or open actions and steps up past any tag already taken,
 * and past any tag whose `case_<tag>` element an existing name holds where
 * HQ's build appends it (the data root, or an open action's repeat row), so
 * a case block never lands beside a question of its name: HQ appends it by
 * name without looking (`xform.py::get_action_path`), and the question's
 * bind and every read of its path would then reach the block too.
 *
 * A held tag (where a published app keeps the action) is kept as held, and
 * taken before any tag is derived.
 *
 * The allocation is the domain's (`lib/domain/advancedTags.ts`), because an
 * entry's first datum is `case_id_<tag>` of its first load, which decides
 * whether a menu asks for its case first (`lib/domain/menuScreens.ts`).
 */

export {
	type AdvancedTagLoad,
	type AdvancedTagOpen,
	advancedCaseBlockName,
	allocateAdvancedTags,
} from "@/lib/domain/advancedTags";

/**
 * The tag check of HQ's case configuration page
 * (`static/app_manager/js/forms/advanced/actions.js::actionBase.validate`).
 */
export const HQ_CASE_TAG_PATTERN = /^[a-zA-Z][\w_-]*(\/[a-zA-Z][\w_-]*)*$/;
