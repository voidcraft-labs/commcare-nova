"""HQ's own editors, driven over HQ's state in a browser.

- ``client`` starts the editor driver (``driver/driver.mjs``: node driving
  the image's Chromium) and speaks its JSON-lines protocol; every request a
  page makes to HQ comes back to Python and is answered on Python's thread.
  Everything the driver runs in a page is a step file under
  ``driver/steps``, so the browser's inputs are the driver, its step files,
  the image and a run's spec.
- ``hq`` answers those requests as HQ's server would: HQ's URLconf, HQ's
  decorated views, HQ's templates and context processors, over the check's
  HQ state (``proof.hq``), each inside the HQ unit's request scope when it
  has one, with the bundles and translation catalog a deployment's static
  build serves.
- ``pages`` renders HQ's app-manager views through HQ's page views and saves
  their sections through HQ's save views, the page's JavaScript making each
  request: every section of a view from one load on the driver's reused page
  (``run_view``), or one section from a fresh page (``fresh_section_save``).
- ``vellum`` opens and saves forms in HQ's vendored Vellum, with the options
  HQ's form designer computes, on the driver's warm Vellum host
  (``open_and_save``) or a fresh one (``fresh_open_and_save``).
- ``transcripts`` keeps what a view or Vellum run asked HQ and showed, and
  replays it through HQ, standing for a live run only when HQ answers every
  request as it did.
- ``seeding`` is the browser's fixed clock, the HQ pin's commit time.
- ``units`` gives the HQ unit contract (``request``, ``fork``) over one
  check's state, for the editors' own tests.
- ``compare`` builds what HQ builds and compares builds and Core's reading of
  them, always after parsing.

Importing the package has no side effects. The page JavaScript is bundled at
image build time (``proof/image/editors/build.mjs``) into ``/opt/editors``.
"""
