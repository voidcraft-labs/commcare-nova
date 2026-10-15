"""The profile settings Formplayer reads, on Nova's export and on the profile HQ's settings page saves.

Finding 40: every Nova app states the settings a device reads where a
profile names none (``lib/commcare/appProfileSettings.ts``), so a save of HQ's
settings page that changes nothing keeps each of them, where it used to write
HQ's own defaults into a profile Nova left empty. Two of those are
Formplayer's to read, and each is observed on HQ's releases of
``case-operation-query``, served to Formplayer by HQ's own views
(``proof.formplayer.hq``), in four arms:

- ``absent``: the app with ``cc-autosync-freq`` and ``cc-fuzzy-search-enabled``
  taken out of its stored profile before the release (``apps.served``'s
  ``change``), which is what an app published before step 2 holds;
- ``nova``: the document as Nova publishes it, whose built profile holds
  ``freq-never`` and ``no``;
- ``saved``: the app after HQ's own App Settings page saved it without a
  change, in Chromium, whose built profile holds the same two;
- ``changed``, the control for both settings: the app after HQ's own
  settings view took a person's change of the sync frequency to daily and of
  fuzzy search to on.

- **``cc-autosync-freq``** (``RestoreFactory.getSyncFreqency``,
  ``isRestoreXmlExpired``). Contract: a worker back after eight days is not
  synced again when the setting is absent, nor when it is ``freq-never``, so
  Formplayer reads the two alike. Plausible failure: a probe that could not
  tell, since Formplayer asks HQ for no restore in either. The control rules
  that out: with ``freq-daily`` the same worker's next request asks HQ for a
  restore.
- **``cc-fuzzy-search-enabled``** (``FormplayerPropertyManager.
  isFuzzySearchEnabled``). Contract: a case list search one letter off a
  case's name finds nothing when the setting is absent and when it is ``no``,
  and finds the case where a person turned it on. Plausible failure: a page
  save that turns fuzzy search on, as HQ's own defaults did, which changes
  what a worker sees.

A worker's absence is not waited for: their last sync, which Formplayer keeps
in Redis (``RestoreFactory.setLastSyncTime``), is moved back eight days
through the same template bean Formplayer writes it with
(``FormplayerRunner.age_sync``).
"""

from __future__ import annotations

import io
import zipfile

from lxml import etree

from proof.formplayer import apps
from proof.formplayer.hq import RESTORE

DOCUMENT = "case-operation-query"
EIGHT_DAYS = 8 * 24 * 3600
# One letter more than "proof", the first word of a case's name in the lane's case database.
NEAR_MISS = "prooof"
SETTINGS = ("cc-autosync-freq", "cc-fuzzy-search-enabled")


def _built_setting(served, key):
    """The setting as HQ's release wrote it into the profile Formplayer installs: its value, or None where absent."""
    with zipfile.ZipFile(io.BytesIO(served.archive())) as archive:
        root = etree.fromstring(archive.read("profile.ccpr"))
    values = [element.get("value") for element in root.iter("property") if element.get("key") == key]
    assert len(values) <= 1, values
    return values[0] if values else None


def _returning_worker(formplayer_runner, served):
    """A worker's first visit, eight days away, and their next request: what Formplayer asked HQ for on return,
    and what the case list shows for a near miss of a case's name."""
    with served.run("returning"):
        web = apps.web(formplayer_runner, served)
        first = len(served.hq.asked)
        web.navigate([])
        first_visit = [what for what, _ in served.hq.asked[first:]]
        # The session's Formplayer keeps every worker it served: this worker's own record is the one it wrote
        # for this visit (``RestoreFactory.lastSyncKey``, by the project space and the worker's name), the latest.
        times = formplayer_runner.sync_times()
        key = max((key for key in times if key.startswith(f"last-sync-time:{served.domain}:")), key=times.get)
        formplayer_runner.age_sync(key, EIGHT_DAYS)
        before = len(served.hq.asked)
        listed = web.navigate(["0"])
        on_return = [what for what, _ in served.hq.asked[before:]]
        searched = web.navigate(["0"], search_text=NEAR_MISS)
    return {
        "firstVisit": first_visit,
        "onReturn": on_return,
        "listed": [entity["id"] for entity in listed["entities"]],
        "nearMiss": [entity["id"] for entity in searched["entities"]],
    }


def _without_settings(stored):
    """The stored app as one published before step 2 holds it: neither setting in its profile."""
    properties = (stored.get("profile") or {}).get("properties") or {}
    for key in SETTINGS:
        properties.pop(key, None)


def test_formplayer_reads_an_absent_sync_frequency_as_never_and_an_absent_fuzzy_search_as_off(
    hq, core_runner, formplayer_runner, editor_driver, formplayer_documents, evidence
):
    from proof.editors import pages

    def unchanged(_published):
        pass

    def page_saved(published):
        apps.saved_page(published, editor_driver, pages.APP_SETTINGS)

    def changed(published):
        apps.saved_profile(published, {"cc-autosync-freq": "freq-daily", "cc-fuzzy-search-enabled": "yes"})

    arms = (
        ("absent", unchanged, _without_settings),
        ("nova", unchanged, None),
        ("saved", page_saved, None),
        ("changed", changed, None),
    )
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        built, read = {}, {}
        for name, save, change in arms:
            with published.unit.fork():
                save(published)
                with apps.served(published, formplayer_runner, label=name, change=change) as served:
                    built[name] = {key: _built_setting(served, key) for key in SETTINGS}
                    read[name] = _returning_worker(formplayer_runner, served)
        evidence("settings", {name: {"profile": built[name], **read[name]} for name in built})

        # The releases are the ones meant: the app published before step 2 holds neither setting, Nova's and the
        # page's save hold Nova's values, and the person's change the daily sync and fuzzy search on.
        assert built == {
            "absent": {"cc-autosync-freq": None, "cc-fuzzy-search-enabled": None},
            "nova": {"cc-autosync-freq": "freq-never", "cc-fuzzy-search-enabled": "no"},
            "saved": {"cc-autosync-freq": "freq-never", "cc-fuzzy-search-enabled": "no"},
            "changed": {"cc-autosync-freq": "freq-daily", "cc-fuzzy-search-enabled": "yes"},
        }
        # Every first visit restores once.
        assert all(visit["firstVisit"].count(RESTORE) == 1 for visit in read.values()), read
        # Absent, Nova's and the page's save: no restore on return, and nothing found for the near miss.
        for name in ("absent", "nova", "saved"):
            assert RESTORE not in read[name]["onReturn"], name
            assert read[name]["nearMiss"] == [], name
        # The person's change, the control: one restore on return, and the near miss finds the case.
        assert read["changed"]["onReturn"].count(RESTORE) == 1
        assert read["changed"]["nearMiss"] == ["patient-1"]
        # Every release lists the same cases.
        assert len({tuple(visit["listed"]) for visit in read.values()}) == 1 and read["nova"]["listed"]
