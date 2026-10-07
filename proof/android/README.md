# The Android reader

The Android reader runs commcare-android's own code, at the commit
`proof/pins.json` names, over the archives a device installs: Nova's local
`.ccz` exports and HQ's builds of what Nova publishes. It answers what the
proof lane used to cite from source: what Android's own classes read of an
app.

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
(`Device.java`). A restore is applied by the app's own `DataPullTask`. The
requests (`Reader.java`):

- **`profile`**: the install's status, and each of Android's profile readers
  on the installed app (`Profile.java`): `HiddenPreferences`
  (`isSavedFormsEnabled`, `isIncompleteFormsEnabled`,
  `getGpsAutoCaptureAccuracy`, `getLoginDuration`, `getResizeMethod`,
  `isSmartInflationEnabled`, `shouldLabelRequiredQuestionsWithAsterisk`,
  `getLogsEnabled`, `getMapsDefaultLayer`), `MainConfigurablePreferences`
  (`isFuzzySearchEnabled`, `isTTSEnabled`),
  `CommCareApp.areMMResourcesValidated`, `UpdateHelper.getAutoUpdateFrequency`,
  `PendingCalcs.getPendingSyncStatus`,
  `PurgeStaleArchivedFormsTask.getArchivedFormsValidityInDays`,
  `SyncDetailCalculations.unsentFormNumberLimitExceeded` and
  `unsentFormTimeLimitExceeded` (each as the smallest count or age it calls
  over the limit), the current locale and what the language picker offers
  (`ChangeLocaleUtil`), and the app record (`AppUtils.getAppById`).
- **`installs`**: several archives installed in turn on one device, each
  status (`ProfileAndroidInstaller.checkDuplicate` among them) and the apps
  the device then holds.
- **`app`**: the screens Android's home activity takes a worker through from
  each command of the installed suite (`Screens.java`), driven as the
  project's own tests drive them (`HomeScreenBaseActivity` and its
  `SessionNavigator`, each next activity built from the intent home started).
  A case list (`EntitySelectActivity`): its Sort menu
  (`getSortOptionsList`), its header row and first rows as `EntityView` or
  `EntityViewTile` lay them out (each cell's class, text, gravity, text size,
  image scale type, and the width a 1000-pixel row gives it), and what each
  search finds (`EntityListAdapter.filterByString`). A search screen
  (`QueryRequestActivity`, `Queries.java`): its prompts, what it sends, and
  what it shows when the server refuses a query; the search is then answered
  with every case of the asked type, as the Core runner answers one, and the
  walk goes on. A form (`FormEntryActivity`, `Forms.java`): its header, its
  title, the name a completed save carries, and each screen
  `FormEntryActivityUIController.showNextView` moves to. Where home starts
  nothing, the session as it stands and the alert home holds for the worker.
- **`update`**: a device on one archive updated to another by the app's own
  `UpdateTask` and `InstallStagedUpdateTask` (`Updates.java`), over a worker's
  own settings where the request names some: the profile before and after,
  and, where the request names a command, a form saved incomplete before the
  update and what home does when the worker reopens it after.

An answer holds what Android gave: a status Android reports, a screen's own
alert. A request the reader itself could not answer (an exception in the
reader, a JVM that fails, a deadline) raises, so no record holds it.

## The archives

`proof.observe` keeps, in every built state's record, the archive a worker
installs of that state (`proof/observe/build.py::device_archive`): HQ's own
download arrangement with the app's multimedia
(`hqmedia/views.py::iter_app_files`), each entry a blob. A device that
installs it has nothing left to fetch. Proof 4 keeps the same for every app an
editor save left whose build is not the one it was saved over.
`archives.py` names every archive of a document from a run's store (Nova's two
local exports and its edit's; A, B and B-edit per configuration; each editor
save) and writes each as the `.ccz` file a device installs.

```bash
python3 -m proof.android.observe --store <run output>/store --corpus <corpus> --out <directory> \
  [--document <id>] [--search <text>] [--query-answer <text>] [--preference name=value]
```

runs `profile` and `app` over every archive of each document, and `installs`
over each pair the checks compare as two installs of one app.

## The runtime

The reader runs on what one build of commcare-android's unit tests leaves:

```bash
ANDROID_HOME=<an Android SDK whose licenses are accepted> \
  proof/android/build-runtime.sh <directory> [--android <checkout>] [--core <checkout>]
PROOF_ANDROID_RUNTIME=<directory> python3 -m unittest proof.android.selfcheck -v
```

`build-runtime.sh` fetches commcare-android and commcare-core at their pins
(or copies the checkouts it is given, at the pins), runs the project's own
Gradle build of its unit tests with `reader.init.gradle`, which records the
unit-test task's classpath, and fetches Robolectric's Android runtime by its
checksum. The reader's own Java (`src/`) is compiled against that classpath
when a reader starts, in about a second, so a runtime is a function of the
pins and `reader.init.gradle` alone.

What the build needs, all of it recorded by a build into an empty Gradle home
and an empty SDK directory:

- JDK 17, git, curl, python3.
- Gradle 8.14.4 (the project's wrapper downloads it).
- The project's dependencies from Google's Maven repository, Maven Central and
  jitpack (the buildscript's plugins, the app's libraries, Robolectric
  4.16.1): about 1.8 GB of Gradle home once built.
- The Android SDK packages the Android Gradle plugin installs on its own into
  `ANDROID_HOME` once its licenses are accepted: `platforms;android-37.0`
  (150 MB), `platforms;android-36` (for the support library), 
  `build-tools;35.0.0` (190 MB) and `platform-tools`.
- Robolectric's Android runtime for the SDK level the project's tests name
  (`sdk=23`): `android-all-instrumented-6.0.1_r3-robolectric-r1-i7.jar`
  (79 MB), which Robolectric otherwise downloads from Maven Central the first
  time a test runs.

Three things about the build that are not in commcare-android's own
documentation:

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
the lane's shards run today. Run there, a device does not start: Robolectric
loads Conscrypt as it builds the application, and Conscrypt ships no library
for it (`UnsatisfiedLinkError: no conscrypt_openjdk_jni-linux-aarch_64`).
Behind that, Robolectric's own native runtime (the SQLite every
commcare-android database opens through) ships for Linux on x86-64, macOS and
Windows only (`org.robolectric:nativeruntime-dist-compat`, in every published
version up to 1.0.19). The Android Gradle plugin's resource compiler is an
x86-64 binary on Linux too, so the runtime is built on amd64.
`client.unavailable()` says so in words where the reader cannot run.

Built and self-checked on linux/amd64 from an empty directory, the runtime is
2.7 GB (Gradle home 1.9 GB, the two built checkouts 0.7 GB, Robolectric's
Android runtime 76 MB) beside a 0.5 GB SDK that only the build reads.

## Checks

`selfcheck.py` holds the reader to itself, with the standard library alone,
where the reader runs: one setting added to a profile moves exactly the reader
that reads it; an archive Android cannot install is refused and the one it was
made from installs; one device refuses the same app twice and each request is
a device of its own; a walk opens the forms the suite names; a request the
reader cannot answer raises. It is not a `test_*.py`, because the lane's
pytest collects all of `proof/` in an image that holds no reader runtime.

`predicates.py` runs each Android predicate the known-defect register names
over both spellings of its entry's difference, where one archive edit gives
both: the spelling Nova exports is a retained control's archive, and the other
is that archive with exactly the difference written in.

```bash
PROOF_ANDROID_RUNTIME=<directory> python3 -m unittest proof.android.predicates -v
```

It holds: the settings HQ's profile writes and Nova's omits move their readers
(defects 7 and 40); the ten settings HQ's app settings save writes at their
readers' defaults read alike (defect 40's equivalences); the media check is
skipped where the profile calls its content valid; a profile that names no
current locale starts in `default`, with the same language picker (finding
39); two exports of one document install as two apps, and one twice is a
duplicate (defect 9); a setting the next profile forces replaces a worker's
own at an update, and one it does not force leaves it (defect 40); an
incomplete form reopens only while its `xmlns` is the app's (defect 1); a tile
cell's vertical `start` lays out as none does, `left` moves a text cell's
gravity and an image cell's scale type, and `medium` changes a text cell's
size (defect 14 and finding 42); a repeat inside a field list never offers a
row (defect 27). The predicates whose other side only HQ's build gives (the
Sort menu's hidden column, an image-map column's width, the form entry a
sync-on-form-entry build refuses, a refused search, a fuzzy search's matches)
are read over the lane's own archives by `observe.py`.

`proof/checks/test_device_archive.py` runs in the lane: the archive a state
keeps is HQ's own download with the media its suite names, and a document
without media keeps exactly its index files.

## What is not built yet

The reader is not yet a step of the lane: no check judges its answers, and no
register entry rests on them. The parts that remain, in order:

1. A job on amd64 that builds the runtime once per pin (cached by the pins and
   `reader.init.gradle`), runs `selfcheck.py`, and runs the reader over each
   document's archives from the shards' store. The archives are
   content-addressed, so an Android answer is a function of an archive, a
   restore and the request, and is kept under their digests.
2. The Android answers as records the judges read: proof 3 across the two
   paths (`android@local.ccz` against `android@A`), proof 4 across each editor
   save, and proof 1's two installs.
3. Register entries that name what Android read in place of an `android`
   field, and the `equivalence` entries Android alone reads retired where its
   answers are equal.
