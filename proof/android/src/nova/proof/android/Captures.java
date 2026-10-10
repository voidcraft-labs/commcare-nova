package nova.proof.android;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.view.MotionEvent;
import android.view.View;
import android.widget.Button;

import org.commcare.activities.DrawActivity;
import org.commcare.activities.FormEntryActivity;
import org.commcare.activities.components.FormEntryConstants;
import org.commcare.dalvik.R;
import org.commcare.utils.RobolectricUtil;
import org.commcare.views.widgets.AudioWidget;
import org.commcare.views.widgets.CommCareAudioWidget;
import org.commcare.views.widgets.DocumentWidget;
import org.commcare.views.widgets.ImageWidget;
import org.commcare.views.widgets.QuestionWidget;
import org.commcare.views.widgets.SignatureWidget;
import org.commcare.views.widgets.VideoWidget;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowLooper;

import java.io.File;
import java.util.HashMap;
import java.util.Map;

/**
 * Files given to a form's capture questions as a worker gives them: through the question's own button and the
 * screen Android opens for it.
 *
 * An image, video or document question (and an audio question whose appearance offers a file) opens Android's
 * file picker for a result (ImageWidget's choose button, VideoWidget's, DocumentWidget's, the audio widgets'); the
 * worker picks a real small file, here the one the lane's answer table names for the question's kind
 * (proof/core/answers.json, novaKinds), from the lane's own files (proof/core/captures, whose directory the
 * client names in the system property {@link #DIRECTORY}), and Android's form entry takes the picked file as it
 * takes any (FormEntryActivity.onActivityResultSessionSafe: ImageCaptureProcessing.processImageChooserResponse,
 * processChooserResponse), copying it into the form's own folder. A signature question opens Android's own
 * drawing screen (DrawActivity); the worker draws a stroke on it and presses its save button, and the drawing
 * screen writes the picture the form then takes.
 *
 * Android names a file it keeps for a form by the moment it took it (MediaWidget.encryptRecordedFileToDestination,
 * ImageCaptureProcessing.moveAndScaleImage), which no record may hold: the name is written in a record as
 * {@code @capture:} and the file the worker gave ({@link #recorded}).
 */
final class Captures {
    static final String DIRECTORY = "nova.proof.android.captures";
    /** Each name Android gave a file it kept for a question, with what a record writes in its place. */
    private static final Map<String, String> kept = new HashMap<>();

    /** How long each of the reader's sound and video files plays, as a device's decoder would read them. */
    private static final Map<String, Integer> PLAYS = new HashMap<>();

    static {
        PLAYS.put("proof-audio.mp3", 648);
        PLAYS.put("proof-video.mp4", 500);
    }

    private static boolean playing;

    private Captures() {
    }

    /**
     * Robolectric's media player opens a file only where it is told what the file holds, and Android's audio
     * question opens what it recorded to show its length (CommCareAudioWidget.initAudioPlayer): the player is
     * told each of the reader's own files' lengths, by their bytes, wherever the device copied them.
     */
    private static void playable() throws Exception {
        if (playing) {
            return;
        }
        playing = true;
        final Map<String, Integer> byContent = new HashMap<>();
        for (Map.Entry<String, Integer> plays : PLAYS.entrySet()) {
            byContent.put(digest(new File(System.getProperty(DIRECTORY), plays.getKey())), plays.getValue());
        }
        final java.lang.reflect.Field source =
                org.robolectric.shadows.util.DataSource.class.getDeclaredField("dataSource");
        source.setAccessible(true);
        org.robolectric.shadows.ShadowMediaPlayer.setMediaInfoProvider(dataSource -> {
            try {
                File file = new File(Uri.parse(String.valueOf(source.get(dataSource))).getPath());
                Integer length = file.isFile() ? byContent.get(digest(file)) : null;
                return length == null ? null : new org.robolectric.shadows.ShadowMediaPlayer.MediaInfo(length, 0);
            } catch (Exception unread) {
                return null;
            }
        });
    }

    private static String digest(File file) throws Exception {
        java.security.MessageDigest sha = java.security.MessageDigest.getInstance("SHA-256");
        return new java.math.BigInteger(1, sha.digest(java.nio.file.Files.readAllBytes(file.toPath()))).toString(16);
    }

    /** What the lane's answer table calls the kind of capture a widget asks for, or null for no capture. */
    static String kind(QuestionWidget widget) {
        if (widget instanceof SignatureWidget) {
            return "signature";
        }
        if (widget instanceof ImageWidget) {
            return "image";
        }
        if (widget instanceof VideoWidget) {
            return "video";
        }
        if (widget instanceof DocumentWidget) {
            return "file";
        }
        if (widget instanceof AudioWidget || widget instanceof CommCareAudioWidget) {
            return "audio";
        }
        return null;
    }

    /**
     * Gives the widget's question its file as a worker does, and writes into {@code entry} what was given and how
     * Android took it. True where the form then holds an answer for the question.
     */
    static boolean give(FormEntryActivity activity, QuestionWidget widget, JSONObject entry) throws Exception {
        String kind = kind(widget);
        entry.put("capture", kind);
        playable();
        if ("signature".equals(kind)) {
            return sign(activity, widget, entry);
        }
        View choose = chooser(widget);
        if (widget instanceof CommCareAudioWidget && (choose == null || choose.getVisibility() != View.VISIBLE)) {
            // An audio question records from the microphone unless its appearance offers a file.
            return record(activity, (CommCareAudioWidget)widget, entry);
        }
        if (choose == null || choose.getVisibility() != View.VISIBLE) {
            entry.put("given", JSONObject.NULL);
            entry.put("offered", "no file to pick");
            return false;
        }
        String name = file(kind);
        File picked = new File(System.getProperty(DIRECTORY), name);
        if (!picked.isFile()) {
            throw new IllegalStateException("The reader gives a " + kind + " question the file " + picked
                    + ", which is not there; the client names the reader's captures directory.");
        }
        ShadowActivity shadow = Shadows.shadowOf((Activity)activity);
        choose.performClick();
        ShadowLooper.idleMainLooper();
        ShadowActivity.IntentForResult opened = shadow.getNextStartedActivityForResult();
        if (opened == null) {
            entry.put("given", JSONObject.NULL);
            entry.put("offered", "the button opened nothing");
            return false;
        }
        entry.put("opened", String.valueOf(opened.intent.getAction()));
        Intent result = new Intent();
        result.setData(Uri.fromFile(picked));
        int toasts = org.robolectric.shadows.ShadowToast.shownToastCount();
        shadow.receiveResult(opened.intent, Activity.RESULT_OK, result);
        settle(activity);
        told(toasts, entry);
        return took(widget, name, entry);
    }

    /**
     * Records from the microphone as a worker does: the question's record button, the microphone permission
     * allowed at the prompt, Android's own recording screen (RecordingFragment) and the app's own recording
     * service (AudioRecordingService, built and bound as the system binds it), the screen's stop and save buttons.
     * Robolectric's recorder writes no sound, so what the microphone gives is the answer table's audio file,
     * written where the app's recorder was told to write (the sensor's output, as Sensors gives the GPS's fix).
     */
    private static boolean record(FormEntryActivity activity, CommCareAudioWidget widget, JSONObject entry)
            throws Exception {
        android.content.Context context = androidx.test.core.app.ApplicationProvider.getApplicationContext();
        org.robolectric.shadows.ShadowApplication application =
                Shadows.shadowOf((android.app.Application)context);
        Intent bind = new Intent(context, org.commcare.views.widgets.AudioRecordingService.class);
        org.commcare.views.widgets.AudioRecordingService service =
                Robolectric.buildService(org.commcare.views.widgets.AudioRecordingService.class, bind).create().get();
        application.setComponentNameAndServiceForBindService(
                new android.content.ComponentName(context, org.commcare.views.widgets.AudioRecordingService.class),
                service.onBind(bind));
        // What earlier screens asked the system to start is theirs; this recording's start is the next one.
        while (application.getNextStartedService() != null) {
            // Each start read once.
        }
        View capture = (View)Screens.field(widget, "captureButton");
        capture.performClick();
        ShadowLooper.idleMainLooper();
        // The record button asks for the microphone where the app holds no permission for it; the worker allows it.
        ShadowActivity form = Shadows.shadowOf((Activity)activity);
        Intent next;
        while ((next = form.peekNextStartedActivity()) != null) {
            form.getNextStartedActivity();
            String[] asked = next.getStringArrayExtra(Sensors.REQUESTED);
            if (asked != null) {
                Sensors.answer(activity, next);
                entry.put("allowed", new org.json.JSONArray(java.util.Arrays.asList(asked)));
                ShadowLooper.idleMainLooper();
            }
        }
        Intent started;
        do {
            started = application.getNextStartedService();
        } while (started != null && (started.getComponent() == null || !org.commcare.views.widgets
                .AudioRecordingService.class.getName().equals(started.getComponent().getClassName())));
        if (started == null) {
            entry.put("given", JSONObject.NULL);
            entry.put("offered", "the record button started no recording");
            return false;
        }
        service.onStartCommand(started, 0, 1);
        ShadowLooper.idleMainLooper();
        String output = started.getStringExtra(org.commcare.views.widgets.AudioRecordingService
                .RECORDING_FILENAME_EXTRA_KEY);
        java.nio.file.Files.copy(new File(System.getProperty(DIRECTORY), file("audio")).toPath(),
                new File(output).toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        androidx.fragment.app.Fragment recorder = null;
        for (androidx.fragment.app.Fragment shown : activity.getSupportFragmentManager().getFragments()) {
            if (shown instanceof org.commcare.views.widgets.RecordingFragment) {
                recorder = shown;
            }
        }
        if (recorder == null || recorder.getView() == null) {
            entry.put("given", JSONObject.NULL);
            entry.put("offered", "no recording screen");
            return false;
        }
        int toasts = org.robolectric.shadows.ShadowToast.shownToastCount();
        View stop = recorder.getView().findViewById(R.id.startrecording);
        stop.performClick();
        ShadowLooper.idleMainLooper();
        // Stopping saves the recording where the screen offers no pause; where it does, the screen offers its
        // save button.
        View save = recorder.getView() == null ? null : recorder.getView().findViewById(R.id.positive_action_button);
        if (save != null && save.getVisibility() == View.VISIBLE) {
            save.performClick();
        }
        settle(activity);
        told(toasts, entry);
        return took(widget, file("audio"), entry);
    }

    /** Draws a stroke on Android's own drawing screen and saves it, as a worker signs. */
    private static boolean sign(FormEntryActivity activity, QuestionWidget widget, JSONObject entry) throws Exception {
        View sign = (View)Screens.field(widget, "mSignButton");
        ShadowActivity shadow = Shadows.shadowOf((Activity)activity);
        sign.performClick();
        ShadowLooper.idleMainLooper();
        ShadowActivity.IntentForResult opened = shadow.getNextStartedActivityForResult();
        if (opened == null || opened.requestCode != FormEntryConstants.SIGNATURE_CAPTURE) {
            entry.put("given", JSONObject.NULL);
            entry.put("offered", "the button opened no drawing screen");
            return false;
        }
        DrawActivity draw = Robolectric.buildActivity(DrawActivity.class, opened.intent).setup().get();
        ShadowLooper.idleMainLooper();
        View canvas = (View)Screens.field(draw, "drawView");
        long at = android.os.SystemClock.uptimeMillis();
        float[][] stroke = {{20f, 60f}, {60f, 20f}, {100f, 70f}, {140f, 30f}};
        for (int i = 0; i < stroke.length; i++) {
            int action = i == 0 ? MotionEvent.ACTION_DOWN
                    : i == stroke.length - 1 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE;
            MotionEvent event = MotionEvent.obtain(at, at + i * 10L, action, stroke[i][0], stroke[i][1], 0);
            canvas.dispatchTouchEvent(event);
            event.recycle();
        }
        ShadowLooper.idleMainLooper();
        Button save = (Button)((Activity)draw).findViewById(R.id.btnFinishDraw);
        entry.put("saveEnabled", save.isEnabled());
        save.performClick();
        ShadowLooper.idleMainLooper();
        ShadowActivity drawn = Shadows.shadowOf((Activity)draw);
        entry.put("drawingSaved", drawn.getResultCode() == Activity.RESULT_OK);
        int toasts = org.robolectric.shadows.ShadowToast.shownToastCount();
        shadow.receiveResult(opened.intent, drawn.getResultCode(), drawn.getResultIntent());
        settle(activity);
        told(toasts, entry);
        return took(widget, "drawn", entry);
    }

    /** What Android told the worker as it took the file (its toast), where it told them anything. */
    private static void told(int before, JSONObject entry) throws Exception {
        if (org.robolectric.shadows.ShadowToast.shownToastCount() > before) {
            entry.put("told", String.valueOf(org.robolectric.shadows.ShadowToast.getTextOfLatestToast()));
        }
    }

    /** Whether the form holds an answer for the widget's question, recording the name Android kept it under. */
    private static boolean took(QuestionWidget widget, String given, JSONObject entry) throws Exception {
        entry.put("given", given);
        org.javarosa.core.model.data.IAnswerData answer = widget.getPrompt().getAnswerValue();
        if (answer == null) {
            entry.put("taken", false);
            return false;
        }
        String name = String.valueOf(answer.getValue());
        kept.put(name, "@capture:" + given);
        entry.put("taken", true);
        return true;
    }

    /** The file the answer table gives a question of the kind (its first value for the Nova kind). */
    private static String file(String kind) {
        org.json.JSONArray values = Answers.table == null || Answers.table.optJSONObject("novaKinds") == null ? null
                : Answers.table.optJSONObject("novaKinds").optJSONArray(kind);
        if (values == null || values.length() == 0) {
            throw new IllegalStateException("The lane's answer table names no file for a " + kind + " question.");
        }
        return values.optString(0);
    }

    /** The widget's own button that opens a file picker, or null where it has none. */
    private static View chooser(QuestionWidget widget) throws Exception {
        if (widget instanceof CommCareAudioWidget) {
            return widget.findViewById(R.id.choose_file);
        }
        return (View)Screens.field(widget, "mChooseButton");
    }

    /** A value as a record writes it: a name Android gave a file it kept is written as the file given. */
    static Object recorded(Object value) {
        if (value instanceof String && kept.containsKey(value)) {
            return kept.get(value);
        }
        return value;
    }

    private static void settle(FormEntryActivity activity) {
        for (int turn = 0; turn < 4; turn++) {
            RobolectricUtil.flushBackgroundThread(activity);
            ShadowLooper.idleMainLooper();
        }
    }
}
