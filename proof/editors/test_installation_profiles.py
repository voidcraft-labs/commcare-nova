"""The exact three-language order can be made in HQ’s own Releases editor."""

from proof.editors.hq import HQAnswers, editor_build
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import nova_shaped_upload
from proof.hq.test_installation_profiles import bilingual_app, profile_payload


def test_saved_defaults_reorder_secondary_languages(hq, editor_driver):
    editor_build()
    with hq_check(Configuration(privileges={"BUILD_PROFILES", "CLOUDCARE"})) as (state, _):
        source = bilingual_app()
        source["langs"] = ["en", "fra", "es"]
        source["build_profiles"] = {"visits": profile_payload("Field team", ["en", "fra"])}
        app_id, _ = operations.publish(state, [nova_shaped_upload(source, "Field team")])
        path = f"/a/{state.domain}/apps/view/{app_id}/releases/"
        bar = "#profiles-tab [data-bind='saveButton: saveButton'] > .savebtn-bar"
        selector = "#profiles-tab select[data-bind*='defaultLang']"
        for default, expected in [("es", ["es", "en", "fra"]), ("en", ["en", "es", "fra"])]:
            steps = [
                {"goto": path},
                {"until": "pages/ready", "arg": {"bar": bar}},
                {"click": "a[href='#profiles-tab']"},
            ]
            if default == "es":
                steps.append({"waitFor": """() => {
                    const select = document.querySelector("#profile-0");
                    if (!select || select.options.length !== 3) return false;
                    for (const option of select.options) option.selected = true;
                    select.dispatchEvent(new Event("change", {bubbles: true}));
                    return true;
                }"""})
            steps.extend([
                {"until": "pages/choose", "arg": {"selector": selector, "value": default}},
                {"click": f"{bar} > .btn:not(.disabled)"},
                {"awaitRequest": {"method": "POST", "pathname": path + "profiles/"}},
                {"until": "pages/saved", "arg": bar},
                {"settle": True},
            ])
            answers = HQAnswers(state)
            editor_driver.run(steps, answer=answers)
            answers.check()
            assert [(p.name, list(p.langs), key) for key, p in
                    operations.held_app(state, app_id).build_profiles.items()] == [("Field team", expected, "visits")]
