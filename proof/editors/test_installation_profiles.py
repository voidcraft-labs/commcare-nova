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

def test_blank_and_repeated_names_can_be_distinguished_without_replacing_profiles(hq, editor_driver):
    from proof.hq import redis as hq_redis
    editor_build()
    with hq_check(Configuration(privileges={"BUILD_PROFILES", "CLOUDCARE", "PRACTICE_MOBILE_WORKERS"})) as (state, _):
        with hq_redis.shared(None), state.committing():
            worker = operations.practice_worker(state, "editor-profile-practice")
        source = bilingual_app()
        source["build_profiles"] = {
            "north": profile_payload("Team", ["fra"], worker),
            "south": profile_payload("Team", ["en"]),
            "office": profile_payload("", ["en", "fra"]),
        }
        app_id, _ = operations.publish(state, [nova_shaped_upload(source, "Teams")])
        path = f"/a/{state.domain}/apps/view/{app_id}/releases/"
        bar = "#profiles-tab [data-bind='saveButton: saveButton'] > .savebtn-bar"
        def definitions():
            return {key: (list(p.langs), p.practice_mobile_worker_id)
                    for key, p in operations.held_app(state, app_id).build_profiles.items()}
        before = definitions()
        assert before["north"][1] == worker
        answers = HQAnswers(state)
        editor_driver.run([
            {"goto": path},
            {"until": "pages/ready", "arg": {"bar": bar}},
            {"click": "a[href='#profiles-tab']"},
            {"waitFor": """() => {
                const inputs = Array.from(document.querySelectorAll("#profiles-tab tbody tr input"));
                if (inputs.length !== 3) return false;
                inputs.forEach((input, index) => {
                    input.value = ["Outreach", "District", "Office"][index];
                    input.dispatchEvent(new Event("change", {bubbles:true}));
                });
                return true;
            }"""},
            {"click": f"{bar} > .btn:not(.disabled)"},
            {"awaitRequest": {"method": "POST", "pathname": path + "profiles/"}},
            {"until": "pages/saved", "arg": bar},
        ], answer=answers)
        answers.check()
        assert definitions() == before
        assert {p.name for p in operations.held_app(state, app_id).build_profiles.values()} == {"Outreach","District","Office"}


def test_native_default_and_matching_profile_label_select_distinct_installations(hq, editor_driver):
    from proof.hq import redis as hq_redis
    from proof.hq.seams import build_seams
    from proof.webapps import hq as webapps_hq

    editor_build()
    with hq_check(Configuration(privileges={"BUILD_PROFILES", "CLOUDCARE", "PRACTICE_MOBILE_WORKERS"})) as (state, _):
        with hq_redis.shared(None), state.committing():
            worker = operations.practice_worker(state, "practice-default-label")
        source = bilingual_app()
        source["build_profiles"] = {"visits": profile_payload("(Default)", ["fra"], worker)}
        app_id, _ = operations.publish(state, [nova_shaped_upload(source, "Training")])
        with build_seams():
            build = webapps_hq._make_build(state, operations.held_app(state, app_id))
        webapps_hq._release(state, app_id, build._id)
        path = f"/a/{state.domain}/apps/view/{app_id}/releases/"
        selector = "#offline-build-profile-select"
        answers = HQAnswers(state)
        editor_driver.run([
            {"goto": path},
            {"click": "a[data-bind*='deploy-build-modal-template']"},
            {"click": "a[href='#offline-install-tab']"},
            {"waitFor": """() => {
                const choices = document.querySelector("#offline-build-profile-select");
                return choices && choices.options.length === 2 && choices.value === "" &&
                    choices.options[0].text === choices.options[1].text && choices.options[1].value === "visits";
            }"""},
            {"until": "pages/choose", "arg": {"selector": selector, "value": "visits"}},
            {"waitFor": """() => document.querySelector("#offline-build-profile-select").selectedIndex === 1"""},
        ], answer=answers)
        answers.check()
        prepared = operations.held_app(state, build._id)
        assert prepared.get_practice_user_id("visits") == worker
        assert prepared.build_profiles["visits"].langs == ["fra"]
        assert list(prepared.langs) == ["en", "fra"]
