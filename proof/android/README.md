# The Android reader

The Android reader runs commcare-android's own code, at the commit
`proof/pins.json` names, over the archives a device installs: Nova's local
`.ccz` exports and HQ's releases of what Nova publishes. The lane hands it
every state a shard serves, beside HQ's live unit, with the device's network
answered by HQ's own views over that state, and proofs 1, 3 and 4 judge what
it did. `proof/README.md` ("Android in the unit") says how it sits in the
lane; this file says what the reader is.

It runs under Robolectric, the way commcare-android's own unit tests run
(`app/unit-tests`): the project's application class for tests
(`CommCareTestApplication`), its real installers, tasks, activities and views,
on Robolectric's Android runtime, at Android 10 (API 29, at which the project's
own tests run app classes) with Robolectric's native graphics, so a view is
drawn by the platform's own Skia and text layout, as on a phone. Nothing of commcare-android is copied or
rewritten. Where a reader is private, the reader calls it by reflection, so
the method that runs is the app's.

## What it reads

One request is one JVM and one device (`client.py`, `src/.../Runner.java`).
commcare-android keeps state in statics a device's process holds for its whole
life (Core's reference roots, the localizer, the form controller), so a second
device in the same JVM would start with the first one's. A request names its
device (`device`, `Reader.device`): a phone (Robolectric's own 320dp portrait
screen), or a tablet held in landscape (an extra-large 1280 by 800dp screen,
where the app's own resources lay a case list and the chosen case's detail
side by side).

A device installs an archive the way a worker installs one from a file:
`InstallArchiveActivity` unzips it and registers the folder, and a
`ResourceEngineTask` installs the profile that reference names
(`Device.java`).

**The network.** A request given a peer (`client.py`, `peer.py`) is a device
with a network: the app's own HTTP client (Core's
`CommCareNetworkServiceGenerator`, which every request of the app's requester
and data pull goes through) is given a loopback proxy the reader answers, as a
device on a network with a proxy is given one (`Peer.java`). A plain request
is sent to it whole, and an `https` one through a tunnel inside which the
proxy speaks TLS for the host the app named, with a certificate of the
reader's own authority, which the app's client is given to trust; everything
else of the client is the app's (its interceptors, its credentials, its
refusal to send a password in clear). Each request is answered by the peer's
`http`, which in the lane is HQ's own views over the state the device is
served (`hq.py`). The project's test application answers the app's network
from its own mocks; with a network, the app's own requester, data pull and
heartbeat run instead, each CommCareApplication's own method called through
an invokespecial made from the test application, and the test application's
start of a session, which Robolectric allows only on the main thread, runs
there (`ProofApplication.java`). The worker HQ made signs in through the
app's own pipeline (`LoginViewModel`, `LoginController`: the key record
from the profile's key server, the data pull with the worker's own
credentials, the session started with the user the restore brought); a
worker who cannot sign in stays at the sign-in screen, and the device walks
no menu. The
device tells the harness where each walk begins and where it goes back to
sign in again (`Peer.run`, `Peer.base`), and Core's random source is seeded
there, so what the device sends is the same on every run. Without a peer, a
restore is applied by the app's own `DataPullTask` from a file, through the
test application's local requester, and the worker the restore registers
becomes the device's worker (the reader's own checks and the spelling rules'
predicates run so).

The requests (`Reader.java`):

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
    every row as `EntityView` or `EntityViewTile` lay them out (each cell's
    class, text, gravity, text size, image scale type and the width a
    1000-pixel row gives it), the header and every row drawn as a worker sees
    them at the screen's width, or a grid cell's (each text's lines and
    whether its layout cut it short with an ellipsis, and the picture, whose
    PNG the record keeps), which case each row is (the value a tap on it
    hands the session, `DatumUtil.getReturnValueFromSelection`), its Sort
    menu (`getSortOptionsList`) and the order each choice gives, and what a
    search finds (`EntityListAdapter.filterByString`) for every word any row
    shows, in the words' own order, each also misspelled, with fuzzy search
    as installed, on and off (a sort's or a search's rows each by the first
    text it shows). A filter that has not finished within two minutes fails
    the request. The first case is opened as a tap opens it, and
    the case the list hands home is recorded; where the list has a case
    detail the detail screen's tabs and fields are read (`Details.java`; a
    tab that lists a row a node is the app's own fragment for it, made by the
    screen's own pager adapter, shown, and its header and rows read and
    drawn) and its own button confirms; on a tablet the detail is the list
    screen's own right pane and its own button there. Each action the list
    offers (a search behind the list) is a walk of its own;
  - a **search** (`QueryRequestActivity`, `Queries.java`): its prompts, what
    it sends, and what it sends and shows for an answer holding both quote
    marks when the server answers 400; and, on a screen of its own, what it
    would send once a worker has typed the answer table's search answers
    (`searchPrompts` of `proof/core/answers.json`) into its prompts through
    the screen's own views (a text box typed into, a spinner set, a check box
    ticked; a date range is chosen on a picker the walk does not open), with
    the errors Core's query manager then holds: the strings a search builds
    from a typed answer, CSQL among them, which the screen's own button then
    sends. With a network every search goes to the server the suite names
    (HQ's search view, which compiles it and queries HQ's Elasticsearch);
    without one the test requester answers with every case of the asked
    types the device holds;
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
    `FormEntryActivityUIController.showNextView` moves to (up to eighty,
    `ended: "screens"` past them: the corpus's one form that reaches them,
    in `fuzz-xform-20260930-10`, goes back from a repeat's dialog to the
    question before it, beside a repeat inside a field list, defect 27, which
    the manifest check reports there), each question
    answered from the lane's answer table (`proof/core/answers.json`, as the
    Core runner reads it) through the form's own controller and read back by
    its own widget (a question the form holds no answer for is recorded
    unanswered, whatever its widget shows: a date widget shows today); each
    capture question given a file through its own screen (`Captures.java`):
    an image, video or document question's button opens Android's file
    picker, which is handed a real small file of the lane's own
    (`proof/core/captures`, the file the answer table names for the
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
    are the ones it held as the form opened. With a network, home then sends
    the form as it sends any form it was handed complete (its
    `FormAndDataSyncer`), to the address the profile names, and the records
    the send changed are recorded (`afterSend`). A form's records are the
    ones its save and its send made or changed: a form sent before it is
    that form's own, under its own `afterSend`. What home
    starts next is part of the same walk, so a walk shows where a worker
    lands after a form.

  A walk ends where home starts nothing (with the alert home holds for the
  worker), at a menu after a form, at a screen it cannot leave, which it
  names with what the screen shows, or, once it has followed three forms, at
  a form it has already opened (`walkEnded: "forms"`: home starting the same
  form again after it, which is every walk of the corpus that gets that far).
  A form it has not opened yet is followed whatever the count, and a walk
  that has taken two hundred steps without ending fails the request. A walk that saved a form or claimed a
  case leaves the next a device made again: the worker's sandbox wiped by
  the app's own call and the worker signed in again (or the restore applied
  again, without a network).
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
- Robolectric's Android runtime for the device's SDK level (Android 10, API
  29, which the project's own tests run app classes at), by its sha256, so
  the reader runs offline;
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
(`toolchain.py key`), so it is built once a pin, and the proof shards mount it
into the harness's container with its JDK, at the paths it was built at.

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

The reader runs on linux/amd64 and on macOS, and not on linux/arm64, which
is why the lane's shards run on amd64. Run there, a device does not start: Robolectric loads Conscrypt as it builds the
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

Three sets of tests hold the reader, each where it can run.

`selfcheck.py` and `predicates.py` run commcare-android's own code, so they
run where the runtime is built or restored (the job before the shards, on
every CI run, on the runner's own Python); neither is a `test_*.py`.

- `selfcheck.py` holds the reader to itself: every capture question of a
  form is given its file through its own screen and the form saves, written
  alike on two readings; a form that polls the location sensor is given the
  device's fix and saves it in its meta, and one that does not asks for
  nothing; one setting added to a profile
  moves exactly the reader that reads it; an archive Android cannot install
  is refused and the one it was made from installs; one device refuses the
  same app twice and each request is a device of its own; a walk opens the
  forms the suite names; a request the reader cannot answer raises; an
  A detail tab that lists a row a node shows a row for each node the
  nodeset gives in the chosen case's context (`basic_tests.ccz`, an archive
  HQ built that the project's instrumentation tests install, over a restore
  of one case and its two children). And it holds proof 3's judge on the
  real reader with a planted difference: two readings of one archive differ in nothing, and with one
  setting planted in the profile the judge reports that setting's reader and
  the home screen's button, nothing else.
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

`test_peer.py` and `proof/checks/test_android.py` run in the lane: the
proxy's transport (a request through it, plain or tunnelled, reaches the
harness as the client wrote it, its answer the client, and a request the
harness cannot answer ends the request), and the judges over planted
differences and the records a shard keeps.

`proof/checks/test_device_archive.py` runs in the lane too: the archive a
state keeps is HQ's own download with the media its suite names, and a
document without media keeps exactly its index files.

## What the reader does not show

- **A language other than the one the app starts in.**
