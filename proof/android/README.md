# The Android reader and the Android stage

The Android reader runs commcare-android's own code, at the commit
`proof/pins.json` names, over the archives a device installs: Nova's local
`.ccz` exports and HQ's builds of what Nova publishes. The Android stage is the
lane's use of it: for every document, every archive is read once, and proofs
1, 3 and 4 are judged over what Android read and held to the known-defect
register by the lane's gate. `proof/README.md` ("The Android stage") says how
the stage sits in the lane; this file says what the reader is.

It runs under Robolectric, the way commcare-android's own unit tests run
(`app/unit-tests`): the project's application class for tests
(`CommCareTestApplication`), its real installers, tasks, activities and views,
on Robolectric's Android runtime. Nothing of commcare-android is copied or
rewritten. Where a reader is private, the reader calls it by reflection, so
the method that runs is the app's.

## What it reads

One request is one JVM and one device (`client.py`, `src/.../Runner.java`).
commcare-android keeps state in statics a device's process holds for its whole
life (Core's reference roots, the localizer, the form controller), so a second
device in the same JVM would start with the first one's.

A device installs an archive the way a worker installs one from a file:
`InstallArchiveActivity` unzips it and registers the folder, and a
`ResourceEngineTask` installs the profile that reference names
(`Device.java`). A restore is applied by the app's own `DataPullTask`, and the
worker the restore registers becomes the device's worker, as the worker who
logs in is on a real device. The requests (`Reader.java`):

- **`app`**: the install's status; each of Android's profile readers on the
  installed app (`Profile.java`: `HiddenPreferences`,
  `MainConfigurablePreferences`, `CommCareApp.areMMResourcesValidated`,
  `UpdateHelper`, `PendingCalcs`, `PurgeStaleArchivedFormsTask`,
  `SyncDetailCalculations`, where a completed form is posted
  (`FormSubmissionHelper.getFormPostURL`), the current locale and what the language picker
  offers, and which of the recorded settings Android's own settings screen
  lets a worker change); the home screen's hidden buttons
  (`StandardHomeActivityUIController.getHiddenButtons`, `Home.java`); and
  every walk (`Screens.java`).

  A walk is one session from the app's first menu, driven as the project's
  own tests drive one (`HomeScreenBaseActivity` and its `SessionNavigator`,
  each next activity built from the intent home started). Every item a menu
  offers is a walk of its own, so every path the app's own menus offer is
  walked and no other: an item a display condition hides is reached by no
  walk. On the way:

  - a **menu** (`MenuActivity`, `Menus.java`): each item its adapter holds,
    as its own row view shows it, with the media it names and whether the
    device holds the file; an item is chosen by the screen's own click;
  - a **case list** (`EntitySelectActivity`, `Lists.java`): its header row and
    first rows as `EntityView` or `EntityViewTile` lay them out (each cell's
    class, text, gravity, text size, image scale type and the width a
    1000-pixel row gives it), which case each row is (the value a tap on it
    hands the session, `DatumUtil.getReturnValueFromSelection`), its Sort
    menu (`getSortOptionsList`) and the order each choice gives, and what a
    search finds (`EntityListAdapter.filterByString`) for each word the
    list's rows show and that word misspelled, with fuzzy search as
    installed, on and off. The first case is opened as a tap opens it, and
    the case the list hands home is recorded; where the list has a case
    detail the detail screen's tabs and fields are read (`Details.java`) and
    its own button confirms. Each action the list offers (a search behind the list)
    is a walk of its own;
  - a **search** (`QueryRequestActivity`, `Queries.java`): its prompts, what
    it sends, and what it sends and shows for an answer holding both quote
    marks when the server answers 400; and, on a screen of its own, what it
    would send once a worker has typed the answer table's search answers
    (`searchPrompts` of `proof/core/answers.json`) into its prompts through
    the screen's own views (a text box typed into, a spinner set, a check box
    ticked; a date range is chosen on a picker the walk does not open), with
    the errors Core's query manager then holds: the strings a search builds
    from a typed answer, CSQL among them. The search is then answered with every
    case of the asked types the device holds, as the Core runner answers one;
  - a **claim** (`PostRequestActivity`, `Posts.java`): what it posts, then
    the sync the screen runs with the app's own data pull;
  - a **form** (`FormEntryActivity`, `Forms.java`): its header, its title and
    the name a completed save carries; what it asks the device for as it
    opens (`deviceAsked`: the location permission, for a form that captures
    one), which the worker allows at the prompt, and the fix the device's GPS
    then gives it (`deviceGave`, `Sensors.java`: location switched on as on a
    worker's phone, the permission granted through the app's own result
    handler, and Robolectric's location service handing the app's own
    location controller the fix the lane's Connect proofs give a visit, at
    the lane's instant); each screen
    `FormEntryActivityUIController.showNextView` moves to, each question
    answered from the lane's answer table (`proof/core/answers.json`, as the
    Core runner reads it) through the form's own controller and read back by
    its own widget (a question the form holds no answer for is recorded
    unanswered, whatever its widget shows: a date widget shows today); each
    capture question given a file through its own screen (`Captures.java`):
    an image, video or document question's button opens Android's file
    picker, which is handed a real small file of the reader's own
    (`proof/android/captures`, the file the answer table names for the
    question's kind), a signature question's button opens Android's drawing
    screen, where a stroke is drawn and saved, and an audio question's
    button records through the app's own recording screen and service, the
    microphone's sound being the table's audio file written where the app's
    recorder writes (Robolectric's recorder writes none). Android names a file
    it keeps by the moment it took it, so a record writes such a name as
    `@capture:` and the file given; a
    repeat's "add another?" dialog answered by its own
    choices; then the worker's finish button and the app's own save, which
    applies the form's case blocks to the device's case database as it
    saves (`FormRecord.updateAndProcessRecord`), and home handed the result.
    Each form record is written with the location its saved instance holds
    in its meta block (`metaLocation`, what `PollSensorAction` wrote from the
    fix). The cases the device then holds are recorded, each one it made itself
    named by its place among them, ordered by what each holds; where the
    device does not save the form, so are its cases then, and whether they
    are the ones it held as the form opened. Nothing is sent. What home starts next is part of the same walk, so a
    walk shows where a worker lands after a form.

  A walk ends where home starts nothing (with the alert home holds for the
  worker), at a menu after a form, or at a screen it cannot leave, which it
  names with what the screen shows. A walk that saved a form or claimed a
  case leaves the next a device made again: the worker's sandbox wiped by
  the app's own call and the restore applied again.
- **`installs`**: several archives installed in turn on one device, each
  status (`ProfileAndroidInstaller.checkDuplicate` among them) and the apps
  the device then holds.
- **`update`**: a device on one archive updated to another by the app's own
  `UpdateTask` and `InstallStagedUpdateTask` (`Updates.java`), over a worker's
  own settings: the profile before and after, and, for every form of the
  suite (or the one a request names), a form saved incomplete before the
  update, the session Android stored for it
  (`SessionStateDescriptor.getSessionDescriptor`), and what home does when
  the worker reopens it after.

An answer holds what Android gave: a status Android reports, a screen's own
alert, what the app itself raised on a walk. A request the reader itself could
not answer (an exception in the reader, a JVM that fails, a deadline) raises,
so no record holds it.

The app's clock is the instant the lane's Core sessions run at: the client
compiles the three Core classes that read the wall clock where an app's logic
reaches (`now()`, `today()` and a suite text's `dow()`) from Core's own source
in the runtime with that one expression reading the reader's clock, as the
Core runner and the Formplayer runner do (`ProofClock.java`). So a form or a
list that shows or stores the day reads the same on every run.

## The stage

`records.py` turns a document's records into the reader's requests: `app` for
Nova's `local.ccz`, for A, B and B-edit of each configuration, and for each
editor save whose build is not the one it was saved over; `installs` for the
two local exports and for A then B; `update` for `local.ccz` to
`local-again.ccz` and for A to B (every form left incomplete, a worker's own
settings), and for B to each save whose profile is not B's. The archives are
the ones the records keep (`proof/observe/build.py::device_archive`: HQ's own
download arrangement with the app's multimedia, each entry a blob; an archive
of a state HQ would not release is not read), and each state's restore is the
one its sessions read.

Each request has a key: the digest of every entry of each archive it reads,
its restore, its options and the reader (`records.fingerprint`: the reader's
files, the commcare-android and commcare-core pins, the answer table, the
toolchain and the platform). `stage.py` reads an answer the evidence store
holds under that key and has the reader make the rest, so an archive read
before is never read again; then `proof/checks/android.py` judges. Requests
of one document often share a key (one build under two configurations'
names), and the stage answers a key once, in a scratch directory of its own
that nothing writes again: two devices given one key's archive at once would
each have it written for them, and a write landing while the other device
unzips it truncates the archive under `UnzipTask`, which then unzips nothing
and leaves `InstallArchiveActivity` open with no result. A local run
over what a lane run observed:

```bash
python3 -m proof.store.queue android --corpus .proof/out/corpus --observed .proof/out \
  --android-platform host --out <queue file>
PROOF_ANDROID_RUNTIME=<runtime> python3 -m proof.android.stage run --queue <queue file> \
  --corpus .proof/out/corpus --out <new directory> --records .proof/out
python3 -m proof.android.stage show --out <that directory>
```

`--records` also writes each document's record, every answer as the judges
read it (`blocks/<id>/android/<kind>-<id>.json`).

## The runtime

The reader runs on what one build of commcare-android's unit tests leaves:

```bash
ANDROID_HOME=<an SDK whose license was accepted> python3 proof/android/toolchain.py prepare-sdk <sdk directory>
ANDROID_HOME=<sdk directory> proof/android/build-runtime.sh <directory> [--android <checkout>] [--core <checkout>]
PROOF_ANDROID_RUNTIME=<directory> python3 -m unittest proof.android.selfcheck proof.android.predicates -v
```

`build-runtime.sh` fetches commcare-android and commcare-core at their pins
(or copies the checkouts it is given, at the pins), runs the project's own
Gradle build of its unit tests with `reader.init.gradle`, which records the
classpath a device is read with (the app's own runtime libraries, then the
unit-test task's classpath), and fetches Robolectric's Android runtime. The
reader's own Java (`src/`) is compiled against that classpath when a reader
starts, in about a second, so a runtime is a function of the pins and the
toolchain alone, and a change to the reader needs no new one.

Everything a build downloads is named exactly (`toolchain.json`):

- the two checkouts, by commit (`proof/pins.json`);
- Gradle's distribution, by its sha256, at the version the project's own
  wrapper names (the build refuses another);
- Robolectric's Android runtime for the SDK level the project's tests name
  (`sdk=23`), by its sha256, so the reader runs offline;
- the Android SDK packages the Android Gradle plugin installs into
  `ANDROID_HOME` (`platforms;android-37.0`, `platforms;android-36`,
  `build-tools;35.0.0`, `platform-tools`), each held, once the build ends, to
  the revision and the bytes the toolchain names (the digest of every file
  the package's archive unpacks to). `prepare-sdk` makes the directory the
  plugin installs into: empty but for the license acceptances of an SDK a
  person or a runner image already accepted. Nothing here accepts a license;
- every dependency Gradle resolves, held to `verification-metadata.xml`
  beside the script (Gradle's own dependency verification: the sha256 of
  each artifact a build on linux/amd64 or on macOS resolves, as the first
  builds on each wrote them). A moved pin that resolves an artifact the file
  does not hold fails the build; `--write-verification <file>` writes the
  file that build needs, to review and commit.

A runtime is kept in CI under the digest of all of that
(`toolchain.py key`), so it is built once a pin.

Four things about the build that are not in commcare-android's own
documentation:

- **The app's libraries come first.** Gradle resolves the unit-test
  classpath to Guava's Android flavour (33.4.8-android), and the app's own
  runtime classpath to the JRE flavour (31.1-jre) Core is compiled against.
  Core calls a method only the second has (`Multimap.forEach`, in
  `StackFrameStep.defineStep`), so on the unit-test classpath alone every
  session that pushes a step with extras (a search, a link to a form that
  takes one) raises `NoSuchMethodError`, on the reader and on no worker's
  device. `reader.init.gradle` lists the app's runtime libraries ahead of
  the unit tests', and the reader refuses to start where the method is
  missing (`Reader.requireShippedLibraries`).

- **The compile SDK.** The app asks for `compileSdk 37`, which the Android
  Gradle plugin at the pin (8.13.2) looks up as the platform `android-37`. The
  SDK repository publishes API 37 as `platforms;android-37.0`; the plugin
  installs it and then cannot find it under the name it asked for.
  `reader.init.gradle` names the same platform by the hash the plugin gives
  it. It decides what the app's code compiles against and nothing the reader
  runs.
- **The zone.** commcare-core's build runs its own tests before it makes the
  jar commcare-android builds against, and one of them
  (`DateRangeUtilsTest`) fails outside UTC, so the build runs in UTC.
- **Absolute paths.** Gradle's classpath is absolute, and the project's test
  application reads the classes it registers for storage from the build
  directories its `BuildConfig` names. A runtime is used at the path it was
  built at.

### Where it runs

The reader runs on linux/amd64 and on macOS, and not on linux/arm64, where
the lane's shards run, which is why the stage is jobs of its own. Run there, a
device does not start: Robolectric loads Conscrypt as it builds the
application, and Conscrypt ships no library for it (`UnsatisfiedLinkError: no
conscrypt_openjdk_jni-linux-aarch_64`). Behind that, Robolectric's own native
runtime (the SQLite every commcare-android database opens through) ships for
Linux on x86-64, macOS and Windows only
(`org.robolectric:nativeruntime-dist-compat`, in every published version up to
1.0.19). The Android Gradle plugin's resource compiler is an x86-64 binary on
Linux too, so the runtime is built on amd64. `client.unavailable()` says so in
words where the reader cannot run.

The runtime holds the SDK's `android.jar`, Google Play services and Firebase
libraries, so it is kept in the repository's Actions cache and is in no
image the lane publishes.

## Checks

Three sets of tests hold the stage, each where it can run.

`selfcheck.py` and `predicates.py` run commcare-android's own code, so they
run where the reader does (the job that builds or restores the runtime runs
both, on every CI run); neither is a `test_*.py`, because the lane's pytest collects all of
`proof/` in an image that holds no reader runtime.

- `selfcheck.py` holds the reader to itself: every capture question of a
  form is given its file through its own screen and the form saves, written
  alike on two readings; a form that polls the location sensor is given the
  device's fix and saves it in its meta, and one that does not asks for
  nothing; one setting added to a profile
  moves exactly the reader that reads it; an archive Android cannot install
  is refused and the one it was made from installs; one device refuses the
  same app twice and each request is a device of its own; a walk opens the
  forms the suite names; a request the reader cannot answer raises; an
  archive written from a store is a function of its entries. And it holds the
  stage end to end on the real reader with a planted difference: with Nova's
  local archive the build's own bytes the stage reports nothing and every
  item passes, and with one setting planted in the local profile it reports
  that setting's reader and the home screen's button, nothing else, and
  proof 3 fails for want of a register entry.
- `predicates.py` runs each Android predicate the register rests on over both
  spellings of its difference: a retained control's archive, and that archive
  with exactly the difference written in. The settings HQ's profile writes
  and Nova's omits move their readers (defects 7 and 40); the ten settings
  HQ's app settings save writes at their readers' defaults read alike; the
  media check is skipped where the profile calls its content valid; a profile
  that names no current locale starts in `default`, with the same language
  picker (finding 39); two exports of one document install as two apps
  (defect 9); a forced setting replaces a worker's own at an update; an
  incomplete form reopens only while its `xmlns` is the app's (defect 1); a
  tile cell's style reaches Android's tile view (defect 14, finding 42); a
  repeat inside a field list never offers a row (defect 27); a hidden sort
  column's header puts it in the Sort menu (finding 36); an image column's
  width is its header's hint (finding 38); an entry that posts a claim is
  refused and the session cleared (defect 20); a form's title names its
  completed save and not its header (finding 46); a search answer holding
  both quote marks is sent and the server's refusal shown as Android's own
  text (finding 48); a fuzzy search matches a column's sort key (finding 51);
  a question's hint, a group's label and a validation message that name an
  image lay out the same screen as without it (the message typed into
  breaking its constraint, and shown as its text), while a question label's
  image is laid out (defect 16's media slots).

`test_stage.py` and `proof/checks/test_android.py` run in the lane, with no
reader: the stage's own logic over a stand-in reader that answers from an
archive's bytes (each archive read once, a changed archive read again and no
other, a planted difference held or failing, a control judged by the checks
that name it, a reader's failure kept as no answer, the gate holding the
Android queue to exactly once and the stage's evidence beside the shards'),
and the judge over planted differences.

`proof/checks/test_device_archive.py` runs in the lane too: the archive a
state keeps is HQ's own download with the media its suite names, and a
document without media keeps exactly its index files.

## What the reader does not show

- **The network.** Nothing is sent: a form is saved and applied to the
  device, and where Android would post it (the address the profile names, or
  Android's own default for a profile that names none) is not run. A search
  is answered with the device's own cases of the asked types, so what a
  search's filter selects is not read, as on the lane's Formplayer.
- **Drawing.** Robolectric lays views out and does not draw them: a cell's
  class, text, gravity, text size, scale type and width are read; a rendered
  picture, a played sound, a font's own metrics are not.
- **A language other than the one the app starts in, and a tablet's
  layout.**
- **A tab of a case detail that lists a row a node** (a detail with a
  nodeset) is named and its rows are not read.
