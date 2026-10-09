"""The profile settings Formplayer reads, on Nova's export and on the profile HQ's settings page saves.

Finding 40: a save of HQ's settings page writes HQ's defaults into the
profile Nova leaves empty, and HQ's build then forces them. Two of those are
Formplayer's to read, and each is observed on HQ's releases of
``case-operation-query``, served to Formplayer by HQ's own views
(``proof.formplayer.hq``): Nova's export, where both are absent; the app
after HQ's own App Settings page saved it without a change, in Chromium
(``cc-autosync-freq: freq-never`` and ``cc-fuzzy-search-enabled: yes``
among what it stores); and, for the control, the app after HQ's own settings
view took a person's change of the sync frequency to daily.

- **``cc-autosync-freq``** (``RestoreFactory.getSyncFreqency``,
  ``isRestoreXmlExpired``). Contract: a worker back after eight days is not
  synced again when the setting is absent, nor when it is ``freq-never``, so
  Formplayer reads the two alike. Plausible failure: a probe that could not
  tell, since Formplayer asks HQ for no restore in either. The control rules
  that out: with ``freq-daily`` the same worker's next request asks HQ for a
  restore.
- **``cc-fuzzy-search-enabled``** (``FormplayerPropertyManager.
  isFuzzySearchEnabled``). Contract: a case list search one letter off a
  case's name finds nothing when the setting is absent and finds the case
  after the save, so this one changes what a worker sees.

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


def test_formplayer_reads_an_absent_sync_frequency_as_never_and_an_absent_fuzzy_search_as_off(
    hq, core_runner, formplayer_runner, editor_driver, formplayer_documents, evidence
):
    from proof.editors import pages

    def nova(_published):
        pass

    def page_saved(published):
        apps.saved_page(published, editor_driver, pages.APP_SETTINGS)

    def daily(published):
        apps.saved_profile(published, {"cc-autosync-freq": "freq-daily"})

    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        built, read = {}, {}
        for name, save in (("nova", nova), ("saved", page_saved), ("daily", daily)):
            with published.unit.fork():
                save(published)
                with apps.served(published, formplayer_runner, label=name) as served:
                    built[name] = {
                        "cc-autosync-freq": _built_setting(served, "cc-autosync-freq"),
                        "cc-fuzzy-search-enabled": _built_setting(served, "cc-fuzzy-search-enabled"),
                    }
                    read[name] = _returning_worker(formplayer_runner, served)
        evidence("settings", {name: {"profile": built[name], **read[name]} for name in built})

        # The releases are the ones meant: Nova's profile holds neither setting, the page's save both at its
        # values, and the person's change the daily sync alone.
        assert built == {
            "nova": {"cc-autosync-freq": None, "cc-fuzzy-search-enabled": None},
            "saved": {"cc-autosync-freq": "freq-never", "cc-fuzzy-search-enabled": "yes"},
            "daily": {"cc-autosync-freq": "freq-daily", "cc-fuzzy-search-enabled": None},
        }
        # Every first visit restores once.
        assert all(visit["firstVisit"].count(RESTORE) == 1 for visit in read.values()), read
        # Absent and freq-never: no restore on return. freq-daily, the control: one.
        assert RESTORE not in read["nova"]["onReturn"]
        assert RESTORE not in read["saved"]["onReturn"]
        assert read["daily"]["onReturn"].count(RESTORE) == 1
        # Every release lists the same cases; only the saved app, with fuzzy search on, finds the near miss.
        assert len({tuple(visit["listed"]) for visit in read.values()}) == 1 and read["nova"]["listed"]
        assert read["nova"]["nearMiss"] == read["daily"]["nearMiss"] == []
        assert read["saved"]["nearMiss"] == ["patient-1"]
