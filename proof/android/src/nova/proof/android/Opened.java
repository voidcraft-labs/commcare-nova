package nova.proof.android;

import android.app.Activity;
import android.content.Intent;

import org.commcare.activities.FormEntryActivity;
import org.robolectric.Robolectric;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.shadows.ShadowDialog;
import org.robolectric.shadows.ShadowLooper;
import org.robolectric.shadows.ShadowToast;

import java.util.ArrayList;
import java.util.List;

/**
 * The screens the reader has open, and their end. Android ends a screen the worker has left: it pauses, stops
 * and destroys the activity, and nothing of it stays. Robolectric keeps every activity it built until its
 * controller is closed (its window, and the theme each of its views was made with, a megabyte and more a
 * screen), so a device that walks every path, case and language of an app would hold hundreds of screens no
 * worker has open and spend its time collecting a heap that never empties. Every screen the reader builds is
 * built here, and each walk ends the screens it opened as Android does, the newest first (ActivityController
 * .close: pause, stop and destroy, from wherever the screen stood).
 *
 * A form the walk left unfinished is paused and stopped as one a worker leaves is, which saves it incomplete
 * where the app's own setting says so (FormEntryActivity.onStop, cc-auto-form-save-on-pause as
 * MainConfigurablePreferences.isAutoSaveFormOnPause reads it), so the next walk starts on a device made again.
 */
final class Opened {
    private static final List<ActivityController<? extends Activity>> open = new ArrayList<>();

    private Opened() {
    }

    /** The controller Robolectric builds for the screen {@code intent} starts, kept so the screen is ended. */
    static <T extends Activity> ActivityController<T> build(Class<T> screen, Intent intent) {
        ActivityController<T> controller = Robolectric.buildActivity(screen, intent);
        open.add(controller);
        return controller;
    }

    /** Ends every screen opened since the last call, the newest first. */
    static void end() {
        for (int i = open.size() - 1; i >= 0; i--) {
            ActivityController<? extends Activity> controller = open.get(i);
            Activity screen = controller.get();
            if (screen instanceof FormEntryActivity && !screen.isFinishing()) {
                Device.dirty = true;
            }
            try {
                controller.close();
            } catch (Throwable raised) {
                // What a screen raised as it ended is no screen a worker reads; the device it leaves is made
                // again, and the JVM's log says what was raised.
                Device.dirty = true;
                System.err.println("nova-proof screen " + screen.getClass().getName() + " raised as it ended: "
                        + raised);
            }
        }
        open.clear();
        ShadowLooper.idleMainLooper();
        // Robolectric lists every dialog and toast a test showed, for the test to read back, and a dialog holds
        // its screen: the reader reads a dialog while its screen is open (Forms, Captures), so the lists start
        // empty for the next walk.
        ShadowDialog.reset();
        ShadowToast.reset();
    }
}
