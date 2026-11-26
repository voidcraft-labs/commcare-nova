"""The captured source pair can reconcile only the same native query and unchanged wording."""

from dataclasses import replace

from proof.checks import changes, formplayer_places, served
from proof.checks.differences import Difference


OLD, NEW, TITLE = "g", "group_header_0", "Find a client"
OLD_LOCALE, NEW_LOCALE = (f"search_property.m0.{key}" for key in (OLD, NEW))
PLACES = {
    changes.LEGACY_SEARCH_GROUP_WORDING: (
        "/menu/0/search_config/properties/0/group_key",
        f"/app/translations/en/{OLD_LOCALE}",
        f"/app/translations/en/{NEW_LOCALE}",
    ),
}


def _held(rows, sites, places=PLACES):
    register = changes.load()
    return [row for row in rows if changes.holders(row, register, places, sites=sites, siblings=rows)]


def test_build_move_needs_the_right_group_prompt_and_equal_locale_strings():
    request = "/suite/remote-request[1]/session[1]/query[1]"
    family = "/suite/remote-request[*]/session[*]/query[*]"
    suite = "suite.xml"
    rows = [
        Difference("proof2", "search", suite, f"{family}/group[*]/@key", f"{request}/group[1]/@key", "changed", OLD, NEW),
        Difference(
            "proof2", "search", suite, f"{family}/group[*]/display[*]/text[*]/locale[*]/@id",
            f"{request}/group[1]/display[1]/text[1]/locale[1]/@id", "changed", OLD_LOCALE, NEW_LOCALE,
        ),
        Difference(
            "proof2", "search", suite, f"{family}/prompt[*]/@group_key", f"{request}/prompt[1]/@group_key",
            "changed", OLD, NEW,
        ),
        Difference("proof2", "search", "app_strings:en", "/search_property.m*.*", f"/{OLD_LOCALE}", "removed", TITLE, None),
        Difference("proof2", "search", "app_strings:en", "/search_property.m*.*", f"/{NEW_LOCALE}", "added", None, TITLE),
        Difference("proof2", "search", "app_strings:en", "/search_property.m*.*.hint", f"/{OLD_LOCALE}.hint", "removed", "", None),
        Difference("proof2", "search", "app_strings:en", "/search_property.m*.*.hint", f"/{NEW_LOCALE}.hint", "added", None, ""),
    ]
    anchor = (suite, "remote-request[1]")
    prompt = (*anchor, "session[1]", "query[1]", "prompt[1]")
    sites = changes.Sites(builds={
        anchor: ("menu", "0"), prompt: ("menu", "0", "search_config", "properties", "1", "validations", "name"),
    })
    assert _held(rows, sites) == rows
    assert not _held(rows, changes.Sites(builds={**sites.builds, anchor: ("menu", "1")}))
    assert not _held(rows[1:], sites)
    assert not _held(rows[:2] + rows[3:], sites)
    assert _held([*rows[:4], replace(rows[4], after="Different words"), *rows[5:]], sites) == rows[:3]
    alternate_hint = replace(rows[5], before="Real instructions"), replace(rows[6], after="Real instructions")
    assert _held([*rows[:5], *alternate_hint], sites) == rows[:5]
    assert _held(rows[:4] + rows[5:], sites) == rows[:3]
    assert not _held(rows, sites, {changes.LEGACY_SEARCH_GROUP_WORDING: ("",)})


def _query(group, title, *, command="search_command.m0", nested=False):
    answer = {
        "type": "query", "queryKey": command + "_results",
        "displays": [{"key": "name", "groupKey": group}],
        "groupHeaders": {group: title},
    }
    response = {"type": "entities", "queryResponse": answer} if nested else answer
    return {"runs": [{"steps": [{"response": response}]}]}


def _compared(before, after):
    rows = served.formplayer_differences(before, after, check="proof3", document="search", artifact="formplayer@B")
    sites = changes.merged_sites(
        changes.Sites(served=formplayer_places.locations(
            [row for row in rows if row.kind != "added"], before, {}, before=True,
        )),
        changes.Sites(served=formplayer_places.locations(
            [row for row in rows if row.kind != "removed"], after, {},
        )),
    )
    return rows, sites


def test_formplayer_move_needs_the_same_query_id_heading_text_and_prompt_membership():
    for nested in (False, True):
        before, after = (_query(group, TITLE, nested=nested) for group in (OLD, NEW))
        rows, sites = _compared(before, after)
        assert len(rows) == 3 and _held(rows, sites) == rows
        assert not _held([row for row in rows if row.kind != "removed"], sites)
        assert not _held([row for row in rows if row.kind != "changed"], sites)
        assert not _held(*_compared(before, _query(NEW, "Different words", nested=nested)))
        assert not _held(*_compared(before, _query(NEW, TITLE, command="search_command.m1", nested=nested)))
        assert not _held(*_compared(
            _query(OLD, TITLE, command="search_command.m1", nested=nested),
            _query(NEW, TITLE, command="search_command.m1", nested=nested),
        ))
