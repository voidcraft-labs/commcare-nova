"""The profile settings Formplayer reads, on Nova's export and on the profile HQ's settings page saves.

Finding 40: a save of HQ's settings page writes HQ's defaults into the
profile Nova leaves empty, and HQ's build then forces them. Two of those are
Formplayer's to read, and each is observed on HQ's builds of
``case-operation-query`` with the setting absent (Nova's export) and written:

- **``cc-autosync-freq``** (``RestoreFactory.getSyncFreqency``,
  ``isRestoreXmlExpired``). Contract: a worker back after eight days is not
  synced again when the setting is absent, nor when it is ``freq-never``, the
  value the settings page writes, so Formplayer reads the two alike.
  Plausible failure: a probe that could not tell, since Formplayer asks HQ
  for no restore in either. The control rules that out: with ``freq-daily``
  the same worker's next request asks HQ for a restore.
- **``cc-fuzzy-search-enabled``** (``FormplayerPropertyManager.
  isFuzzySearchEnabled``). Contract: a case list search one letter off a
  case's name finds nothing when the setting is absent and finds the case
  when it is ``yes``, the value the settings page writes, so this one changes
  what a worker sees.

A worker's absence is not waited for: their last sync, which Formplayer keeps
in Redis (``RestoreFactory.setLastSyncTime``), is moved back eight days
through the same template bean Formplayer writes it with
(``FormplayerRunner.age_sync``).
"""

from __future__ import annotations

from lxml import etree

from proof.formplayer import apps

DOCUMENT = "case-operation-query"
EIGHT_DAYS = 8 * 24 * 3600
# One letter more than "proof", the first word of a case's name in the lane's case database.
NEAR_MISS = "prooof"


def _profile_setting(key, value):
    """The app document as HQ's settings page leaves it for one setting (``views/settings.py::
    edit_commcare_profile`` stores each setting's value under the profile's properties)."""

    def change(doc):
        doc["profile"] = {"features": {}, "properties": {key: value}}

    return change


def _built_setting(files, key):
    """The setting as HQ's build wrote it into the profile Formplayer installs: its value, or None where absent."""
    root = etree.fromstring(files["profile.ccpr"])
    values = [element.get("value") for element in root.iter("property") if element.get("key") == key]
    assert len(values) <= 1, values
    return values[0] if values else None


def _returning_worker(formplayer_runner, session):
    """A worker's first visit, eight days away, and their next request: what Formplayer asked HQ for on return,
    and what the case list shows for a near miss of a case's name."""
    web = apps.web(formplayer_runner, session)
    web.post("/clear_user_data", {"domain": session.unit.domain, "username": session.hq.username, "restoreAs": None})
    web.navigate([])
    first_visit = [what for what, _ in session.hq.asked]
    (key,) = formplayer_runner.sync_times()
    formplayer_runner.age_sync(key, EIGHT_DAYS)
    before = len(session.hq.asked)
    listed = web.navigate(["0"])
    on_return = [what for what, _ in session.hq.asked[before:]]
    searched = web.navigate(["0"], search_text=NEAR_MISS)
    return {
        "firstVisit": first_visit,
        "onReturn": on_return,
        "listed": [entity["id"] for entity in listed["entities"]],
        "nearMiss": [entity["id"] for entity in searched["entities"]],
    }


def test_formplayer_reads_an_absent_sync_frequency_as_never_and_an_absent_fuzzy_search_as_off(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        builds = {
            "nova": published.build.files,
            "never": apps.spelled(published, _profile_setting("cc-autosync-freq", "freq-never")).files,
            "daily": apps.spelled(published, _profile_setting("cc-autosync-freq", "freq-daily")).files,
            "fuzzy": apps.spelled(published, _profile_setting("cc-fuzzy-search-enabled", "yes")).files,
        }
        built = {
            name: {
                "cc-autosync-freq": _built_setting(files, "cc-autosync-freq"),
                "cc-fuzzy-search-enabled": _built_setting(files, "cc-fuzzy-search-enabled"),
            }
            for name, files in builds.items()
        }
        read = {
            name: _returning_worker(formplayer_runner, apps.installed(published, files))
            for name, files in builds.items()
        }
        evidence("settings", {name: {"profile": built[name], **read[name]} for name in builds})

        # The builds are the ones meant: Nova's profile holds neither setting, each other holds its one.
        assert built == {
            "nova": {"cc-autosync-freq": None, "cc-fuzzy-search-enabled": None},
            "never": {"cc-autosync-freq": "freq-never", "cc-fuzzy-search-enabled": None},
            "daily": {"cc-autosync-freq": "freq-daily", "cc-fuzzy-search-enabled": None},
            "fuzzy": {"cc-autosync-freq": None, "cc-fuzzy-search-enabled": "yes"},
        }
        # Every first visit restores once.
        assert all(visit["firstVisit"].count("restore") == 1 for visit in read.values())
        # Absent and freq-never: no restore on return. freq-daily, the control: one.
        assert "restore" not in read["nova"]["onReturn"]
        assert "restore" not in read["never"]["onReturn"]
        assert read["daily"]["onReturn"].count("restore") == 1
        # Every build lists the same cases; only the one with fuzzy search on finds the near miss.
        assert len({tuple(visit["listed"]) for visit in read.values()}) == 1 and read["nova"]["listed"]
        assert read["nova"]["nearMiss"] == read["never"]["nearMiss"] == read["daily"]["nearMiss"] == []
        assert read["fuzzy"]["nearMiss"] == ["patient-1"]
