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

If the proxy cannot write an answer while the device is running, the request
fails with `PeerFailed`, retaining the JVM log and the original socket error.
Its diagnostic names the bounded method and path, HTTP status, response byte
count and elapsed time answering the request. It includes no query, host,
headers or content. The proxy stops and reaps the device before the reader
removes the request's temporary files.

The requests (`Reader.java`):

- **`app`**: the install's status; each of Android's profile readers on the
  installed app (`Profile.java`: `HiddenPreferences`,
  `MainConfigurablePreferences`, `CommCareApp.areMMResourcesValidated`,
  `UpdateHelper`, `PendingCalcs`, `PurgeStaleArchivedFormsTask`,
  `SyncDetailCalculations`, where a completed form is posted
  (`FormSubmissionHelper.getFormPostURL`), the current locale and what the language picker
  offers, and which of the recorded settings Android's own settings screen
  lets a worker change); the home screen's hidden buttons
  (`StandardHomeActivityUIController.getHiddenButtons`, `Home.java`, read
  on the app the device seated, whose platform holds its profile and
  suites: the test application's own `getCurrentApp` hands out a new app
  whose platform holds neither, `ProofApplication.getCurrentApp`); and
  every walk (`Screens.java`).

  A walk is one session from the app's first menu, driven as the project's
  own tests drive one (`HomeScreenBaseActivity` and its `SessionNavigator`,
  each next activity built from the intent home started). Every item a menu
  offers is a walk of its own, so every path the app's own menus offer is
  walked and no other: an item a display condition hides is reached by no
  walk. Every case a list shows is a walk of its own too, as every reader's
  walk opens them (`proof/observe/walks.py`, `cases_opened`): a walk that
  reaches a list with nothing left to choose reads it and ends there, and
  each case it lists, in its order, is a walk named by the case
  (`<path>/@case:<the value a tap on its row hands the session>`) that opens
  it. A list that can name none of its rows' cases has no case to name a
  walk by, and the walk opens its first row. Then the app is walked again in
  each other language it holds (the request's `languages`, `walks.chosen`:
  every one but the one the app starts in), each walk named by its language
  (`@language:<code>/<path>`): the worker first chooses the language as a
  worker does, on home's own Change Language dialog (`Languages.java`: the
  options menu Android makes and prepares, its item tapped, and the dialog's
  own row listener given the language's row), which sets it for every screen
  after, a form's among them (each form records the language it opened in);
  a language the installed app does not offer is that walk's end. Each
  language's walks are its own, down what its menus and lists offer in it.
  Once they have run, the language and the worker's setting for it are put
  back as the app started (the picker cannot always: an app whose profile
  names no locale starts in `default`, which the picker does not offer), for
  what the request reads after its walks. All of it is one device, one JVM.

  A screen is read once where the device is the same. The walk that ends at
  a menu or a list reads it; each walk that goes on from there opens the
  same screen on the same device and records only what it chooses (`chose`
  for a menu's item or a list's case, `took` for a list's action). The walk
  that ends its choices with a case reads the case's detail, and a walk that
  goes on from the case opens the detail and presses its confirm button
  without reading its tabs again. A list a form leads to is read in full
  where the walk reaches it, since the form changed the device. So one
  difference of a list or a detail is reported at the walk that read it,
  not again at every walk that passed it.

  Each walk's screens end with it, as Android ends a screen the worker has
  left (`Opened.java`: every screen the reader builds is built there, and
  the walk's end closes each, the newest first, through pause, stop and
  destroy). Robolectric holds an activity it built, its window and every
  theme its views were made with until its controller is closed, and lists
  every dialog a test showed, so a device that left them open would hold
  hundreds of screens no worker has open. A form the walk left unfinished
  is paused and stopped as one a worker leaves is, which saves it
  incomplete where the app's setting says so
  (`cc-auto-form-save-on-pause`), so the next walk starts on a device made
  again.
  On the way:

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
    text it shows), once a list in each language. A filter that has not
    finished within two minutes fails the request. The walk's case is opened
    as a tap on its row opens it (a walk whose case the list does not show
    ends there, `unlisted`; a list a form leads to opens the walk's own case
    where it shows it, else its first), and the case the list hands home is
    recorded; where the list has a case
    detail the detail screen's tabs and fields are read by the walk that
    ends with the case (`Details.java`; a
    tab that lists a row a node is the app's own fragment for it, made by the
    screen's own pager adapter, shown, and its header and rows read and
    drawn) and its own button confirms; on a tablet the detail is the list
    screen's own right pane and its own button there. Each action the list
    offers (a search behind the list) is a walk of its own;
  - a **search** (`QueryRequestActivity`, `Queries.java`): its prompts, the
    items each prompt that lists choices shows (a spinner's, or a group of
    check boxes'), in the screen's order, which is the order Core gives the
    prompt's itemset (sorted where it holds a sort), what
    it sends, and what it sends and shows for an answer holding both quote
    marks when the server answers 400, or, where the request asks for it
    (`queryFindsNothing`), when the server answers 200 with no case: the
    toast and what each prompt then holds; and, on a screen of its own, what it
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
    `FormEntryActivityUIController.showNextView` moves to, to the form's own
    end or to where Android holds the worker. One hold is a cycle
    (`ended: "cycle"`): a form that brings the worker back to a repeat's
    dialog they declined, with its data as it was, is recorded to that
    dialog's second showing and no further. The corpus's one such form, in
    `fuzz-xform-20260930-10`, has a repeat followed by field lists that hold
    only repeats (defect 27's shape, which the manifest check reports there):
    declining another row reaches the form's end with no screen left, and
    Android shows the question before the dialog again
    (`showNextView`, `refreshCurrentView`), so no worker leaves it, on HQ's
    build and Nova's alike. The reader's own bound is no end: a form that
    shows four hundred screens (`Forms.MAX_SCREENS`, Formplayer's count)
    with neither fails the request by name, so no record holds a form cut
    short; each question
    answered from the lane's answer table (`proof/core/answers.json`, as the
    Core runner reads it), or from the request's own `questions` map where it
    names the question, through the form's own controller and read back by
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
    choices (where an alert holds the repeat's screen instead, as a save
    the form refused when the worker left its last repeat does, the form
    ends at the alert); then the worker's finish button and the app's own save, which
    applies the form's case blocks to the device's case database as it
    saves (`FormRecord.updateAndProcessRecord`), and home handed the result.
    Each form record is written with the location its saved instance holds
    in its meta block (`metaLocation`, what `PollSensorAction` wrote from the
    fix). The cases the device then holds are recorded, each one it made itself
    named by its place among them, ordered by what each holds; where the
    device does not save the form, so are its cases then, and whether they
    are the ones it held as the form opened. With a network, home then sends
    the form as it sends any form it was handed complete (its
    `FormAndDataSyncer`), to the address the profile names, and what the send
    did to the records is recorded (`afterSend`: each status it changed, or
    `gone` where the device dropped the record). A form's records are the
    ones its own save made or changed: a form sent before it is that form's
    own, under its own `afterSend`. What home
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

  A request may narrow and steer the walk. `commands` walks the named forms
  alone, each from home (`m<menu>-f<form>`, as HQ's suite names a form's
  command), a case list before one answered with its first case. `views`
  records each screen's views as Android laid them out, and `typeRefused`
  types a value the form refused into the question's own box, so Android
  shows its own message for it. `questions` is a map the answer table
  carries: the values for a question are those under its reference as the
  walk records it (`/data/items[1]/item[2]/choice[1]`), else under its
  generic reference (`/data/items/item/choice`, one entry for every row),
  read before the table's `controls` and `dataTypes` (`Answers.java::valuesFor`);
  the lane's own table holds none, so no walk of the lane reads one.
  `saveIncomplete` names a form whose first screen is answered and saved as
  the quit dialog's Save saves it (`Updates.saveIncomplete`), and with
  `reopen` that record is reopened from home's incomplete forms, as
  `Updates.reopen` reopens one, walked to its end with the request's
  answers, finished, saved and sent where the device is served; the answer
  holds it as `savedIncomplete.reopened`, with the form under `form` as a
  walk's step holds one.
- **`installs`**: several archives installed in turn on one device, each
  status (`ProfileAndroidInstaller.checkDuplicate` among them) and the apps
  the device then holds.
- **`update`**: a device on one archive updated to another by the app's own
  `UpdateTask` and `InstallStagedUpdateTask` (`Updates.java`), over a worker's
  own settings: the profile before and after, and, for every form of the
  suite (or the one a request names), a form saved incomplete before the
  update, the session Android stored for it
  (`SessionStateDescriptor.getSessionDescriptor`), and what home does when
  the worker reopens it after. Proof 1 reads an update between two exports
  of one revision, which Android answers `UpToDate` since it compares
  versions alone, by the archives it was given, so the answer names each
  archive's profile `uniqueid` and `version` (`archives`, which
  `observe.py::update` adds from the archives' own profiles).
- **`location`**: a device on an archive opens a command's form, allows the
  location permission its poll asks for, and is handed each of the
  request's fixes in turn through Android's own location listener
  (`Location.java`); after each, whether the form's poll of the location
  sensor still runs (`PollSensorController`'s pending actions) and what the
  node the request names holds. A walk gives a form one fix, finer than any
  accuracy a profile names, so the auto-capture accuracy a profile states
  is read here (`predicates.py::test_automatic_capture_stops_at_the_accuracy_the_profile_names`).
- **`nav`**: where Android takes a worker (`Nav.java`, sent by
  `navigation.py::nav`), each navigation one session read with the walk's own
  loop (`Screens.follow`). For each of `commands`, the walk from the
  command: its form completed, home handed the result, and each screen home
  then starts. For each of `paths` (lists of menu item ids), the items chosen
  from the app's first menu as a worker taps them, a list on the way
  answered with its first case, and the screen reached read as a command's
  is. For each of `endpoints` (`{id, arguments?, complete?}`), the intent
  CommCare's own launcher sends (`CommCareLauncher.launchCommCareForAppId`:
  the action `org.commcare.dalvik.action.CommCareSession`, the installed
  app's id, the entry point's id, its arguments as a list) handed to
  `DispatchActivity`, each activity it starts followed until it starts
  `StandardHomeActivity`, the media check a first open asks for
  (`CommCareVerificationActivity`) run and its result handed back; home is
  built from the intent the dispatcher handed it, which runs the entry
  point's stack as it is created, and what home then starts is read: a case
  list answered and the screen after it read, a form opened and left, or
  completed where the entry point carries `"complete": true`. A menu's
  entry point on a case menu takes the case that menu selects as its
  argument, since HQ's entry point declares it
  (`suite_xml/post_process/endpoints.py::_make_session_endpoint`) and Android
  runs no stack for one launched without it. The answer holds one record a
  navigation under `navs`, keyed `command:<id>`, `path:<ids joined by />` or
  `endpoint:<id>`: a command's and a path's `steps`, each with its `screen`
  (`home`, `MenuActivity`, `EntitySelectActivity` or `FormEntryActivity`),
  the session frame (`session.command`, and `session.needed` where home
  starts no screen), a menu's `menu.id` and `menu.items[*].id`, and a form's
  `form` with `FormEntryActivity.getHeaderString`; an endpoint's
  `dispatched` (the dispatcher's chain), `handedHome.endpoint` and
  `landed.steps`. `test_navigation.py` holds what the device does with each
  after-submit destination, with an item off the menu, and with a link to a
  target its menu hides.

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
  forms the suite names; a request the reader cannot answer raises; a form
  that brings the worker back to a repeat they declined ends there as a
  cycle, and a form of five hundred screens fails the request by name
  (both built from the labelled-repeat control's form). A
  detail tab that lists a row a node shows a row for each node the
  nodeset gives in the chosen case's context (`basic_tests.ccz`, an archive
  HQ built that the project's instrumentation tests install, over a restore
  of one case and its two children). Each case a list shows is a walk of
  its own that opens that case, the list read by the walk that ends there
  and the detail by the walk that ends with the case (the same archive over
  two cases); a walk in another language chooses it on home's own dialog
  and its form opens in it (`localization-optional`'s archive, which starts
  in Spanish, walked again in English). And it holds proof 3's judge on the
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
  text, and where the suite writes `match-none()` for it, as Nova writes it now,
  the screen sends that, shows "Query response had no results" and keeps the
  answer (finding 48); a fuzzy search matches a column's sort key (finding 51);
  a question's hint, a group's label and a validation message that name an
  image lay out the same screen as without it (the message typed into
  breaking its constraint, and shown as its text), while a question label's
  image is laid out (defect 16's media slots).

`test_peer.py`, `test_screens.py` and `proof/checks/test_android.py` run in
the lane: the proxy's transport (a request through it, plain or tunnelled,
reaches the harness as the client wrote it, its answer the client, a request
the harness cannot answer ends the request, and a device past its deadline
is stopped and reported as a request left unanswered, with how far it had
walked), that every screen the reader builds is built where its end is kept
(`Opened.java`), and the judges over planted differences and the records a
shard keeps.

`test_form_reads.py` reads the corpus: each test reads HQ's build of a
document as the pull request's own emitter wrote it, published as the corpus
captured it (`proof.rules.conftest.published`), released and served by HQ's
own views (`proof.formplayer.hq.serve`), and installed from HQ's download of
the release (`observe.release_archive`), with the device's network HQ's views
over that state. Its documents are `conftest.py::DOCUMENTS`, handed to the
tests by the session fixture `android_documents`. A registration form's read
of its own new case id holds the id its create block writes, on a form
completed in one go and on one saved incomplete, reopened and completed; a
form's title and a completed save's name are the form's name in the app's
default language, under a header that is the same text as before; and a
validation that counts the rows whose answer reads its own node accepts the
dependent answer where the count matches and refuses it with Android's own
message where it does not.

`test_case_blocks.py` reads the corpus the same way, on the follow-up form
"Edit" (`m0-f0`) of six documents whose case operations Nova writes inside
`nova_operations` and `nova_condition_<operation>` groups, with guards as
update-only blocks and a keyed root create inside a one-row repeat. With the
condition true the instance the device sends holds every block in the order
the form lists its operations, and with it false an empty create and no case
the device made; a failing guard ends in "Error Saving your Form", a
quarantined record, the device's cases as the form opened them and nothing
sent; a keyed root create writes its keyed id, also on a form saved incomplete
at its first screen, reopened from home and completed; and no generated
group, repeat or row is a screen or a question.

`test_case_name_guard.py` reads the corpus the same way, on the
registration form "Register" (`m0-f1`) of `navigation-base`, whose case name
is a Hidden Value trimming the question's answer and whose question carries
the name's guard. A whitespace-only name typed into the question's box is
held with "Sorry, this response is required!", a 256-character one with
"Sorry, this response is invalid!", each with nothing saved or sent; and a
name with surrounding spaces is accepted, sent as the trimmed name in the
case block, and held under it in the case the device made.

`test_case_lists.py` reads the corpus the same way, serving the cases each
document's own restore fixes (`proof.observe.casedata.database_of_restore`),
and installs both HQ's download of the release and the document's local
archive naming the app HQ holds (`proof.observe.served.local_archive`). Each
list the walk opens is also searched for the test's own terms (`observe.app`'s
`searches`), with fuzzy search as installed, on and off. On both archives a
search of `targeted-hidden-column` for a value only its hidden column holds
finds that case alone; and `targeted-tile-hidden-order`, its ranks set by
hand, lists its tiles in the first hidden order rule's order, lays out each
tile's placed cells and no other, offers those columns alone in its Sort
menu, and finds a case by a value only the hidden order column holds.

`test_navigation.py` reads the corpus the same way, through the `nav`
request. On `targeted-multi-select-destinations` home starts no screen at a
menu that selects several cases, from its forms' commands or by taps, so a
device opens neither `module` form of `m0` and `m3`; the `firstMenu` form,
started from its command, lands on the menu listing Batches and Samples;
the second follow-up of "Samples" lands on the menu's case list; and
`parentMenu` and `previous` land on the parent menu listing its forms and
child menus, from the command and by taps. On `targeted-hidden-from-menu` a
link to a form off the menu and a link into a menu off the menu each open
their form, and every entry point opens its form with no alert, those that
do not ignore display conditions as those that do. On
`targeted-form-link-hidden-target` the links to the shown form and to the
form a condition hides open them, and the link to the hidden menu opens it
with nothing in it (finding 58).

Each test carries `@pytest.mark.reader("android")` and takes the `hq` fixture,
so the pull request lane deselects it and the nightly runs it.

`proof/checks/test_device_archive.py` runs in the lane too: the archive a
state keeps is HQ's own download with the media its suite names, and a
document without media keeps exactly its index files.

## What the reader does not show

- **A case a form leads to past its first list.** A walk opens each case of
  the list it reaches before any form, each in a walk of its own; a list a
  form leads to (its end of form's navigation) opens the walk's own case
  where it shows it, else its first, so the cases of such a list are not
  each walked. Formplayer's and the Web Apps client's walks end at the
  form's submission, so no reader walks them.
