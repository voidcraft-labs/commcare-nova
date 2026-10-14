"""The Android reader: commcare-android's own classes, at the pinned checkout, reading the archives a device
installs (proof/android/README.md).

- ``client``: the one way to talk to it, a JVM per request and a device per JVM;
- ``archives``: the archives a lane run recorded for a document, each as the file a worker installs;
- ``observe``: the reader over every archive of a run's documents;
- ``selfcheck``: the reader held to itself, where it runs;
- ``src``: the reader's Java, run under Robolectric as the project's own unit tests are;
- ``reader.init.gradle``, ``build-runtime.sh``: the runtime it runs on, built from the pins.
"""
