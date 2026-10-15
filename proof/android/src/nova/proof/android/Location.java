package nova.proof.android;

import android.content.Context;
import android.location.LocationManager;

import androidx.test.core.app.ApplicationProvider;

import org.commcare.activities.CommCareActivity;
import org.commcare.activities.FormEntryActivity;
import org.commcare.android.javarosa.PollSensorController;
import org.commcare.engine.resource.AppInstallStatus;
import org.commcare.utils.RobolectricUtil;
import org.javarosa.core.model.data.IAnswerData;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.model.xform.XPathReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowLooper;

import java.lang.reflect.Field;
import java.util.List;

/**
 * The {@code location} request: what a form's poll of the location sensor does with each fix a device's GPS
 * gives it, which a walk does not show (a walk gives a form one fix, finer than any accuracy a profile names, and
 * records nothing of the poll after it).
 *
 * The request installs {@code archive}, signs a worker in and opens the form of {@code command} as home opens it
 * (Screens.walk). The form asks the device for the location permission as its poll finds none
 * (PollSensorController.missingPermissions), and the worker allows it at the prompt (Sensors.answer), so the app
 * starts the poll again. Then Android's own location listener is handed each fix of {@code fixes} in turn
 * ({@code [latitude, longitude, altitude, accuracy]}, through Robolectric's location service, as Sensors gives a
 * walk its fix), and after each the answer records whether the form's poll is still running
 * (PollSensorController's pending actions, read by reflection, since the class keeps them private) and what the
 * node the request names ({@code node}, an absolute path in the form's main instance) holds: what
 * PollSensorAction.updateReference wrote there.
 *
 * {@code {"install": <status>, "loaded": <whether the form opened>, "deviceAsked": [...], "fixes": [{"accuracy":
 * <the fix's>, "polling": <bool>, "node": <its value, or null>}]}}.
 */
final class Location {
    private Location() {
    }

    static JSONObject read(JSONObject request) throws Exception {
        JSONObject found = new JSONObject();
        AppInstallStatus status = Device.install(request.getString("archive"));
        found.put("install", String.valueOf(status));
        if (status != AppInstallStatus.Installed) {
            return found;
        }
        Device.login();
        String node = request.getString("node");
        JSONArray fixes = request.getJSONArray("fixes");
        Screens.walk(request.getString("command"), (started, step, home) -> {
            FormEntryActivity activity = Forms.open(started);
            found.put("loaded", FormEntryActivity.mFormController != null);
            if (FormEntryActivity.mFormController == null) {
                return false;
            }
            Screens.deviceAsks(home, found);
            if (Screens.permissionRequest != null) {
                Sensors.answer(activity, Screens.permissionRequest);
                settle(activity);
            }
            JSONArray readings = new JSONArray();
            for (int i = 0; i < fixes.length(); i++) {
                JSONArray fix = fixes.getJSONArray(i);
                give(fix);
                settle(activity);
                JSONObject reading = new JSONObject();
                reading.put("accuracy", fix.getDouble(3));
                reading.put("polling", polling());
                reading.put("node", Screens.orNull(value(node)));
                readings.put(reading);
            }
            found.put("fixes", readings);
            return false;
        });
        return found;
    }

    /** One fix from the device's GPS, as Sensors gives a walk its own, taken at the lane's instant. */
    private static void give(JSONArray fix) throws Exception {
        android.location.Location location = new android.location.Location(LocationManager.GPS_PROVIDER);
        location.setLatitude(fix.getDouble(0));
        location.setLongitude(fix.getDouble(1));
        location.setAltitude(fix.getDouble(2));
        location.setAccuracy((float)fix.getDouble(3));
        location.setTime(ProofClock.instant());
        location.setElapsedRealtimeNanos(android.os.SystemClock.elapsedRealtimeNanos());
        LocationManager manager = (LocationManager)ApplicationProvider.getApplicationContext()
                .getSystemService(Context.LOCATION_SERVICE);
        Shadows.shadowOf(manager).simulateLocation(location);
    }

    /** Whether the form's poll is still running: PollSensorController holds an action it writes fixes for. */
    private static boolean polling() throws Exception {
        Field actions = PollSensorController.class.getDeclaredField("actions");
        actions.setAccessible(true);
        List<?> held = (List<?>)actions.get(PollSensorController.INSTANCE);
        synchronized (held) {
            return !held.isEmpty();
        }
    }

    /** What the form's main instance holds at {@code path}, as its answer's text; null where it holds none. */
    private static String value(String path) {
        TreeElement element = FormEntryActivity.mFormController.getFormDef().getMainInstance()
                .resolveReference(XPathReference.getPathExpr(path).getReference());
        IAnswerData answer = element == null ? null : element.getValue();
        return answer == null ? null : answer.getDisplayText();
    }

    private static void settle(FormEntryActivity activity) {
        for (int turn = 0; turn < 4; turn++) {
            RobolectricUtil.flushBackgroundThread((CommCareActivity)activity);
            ShadowLooper.idleMainLooper();
        }
    }
}
