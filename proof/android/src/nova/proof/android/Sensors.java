package nova.proof.android;

import android.Manifest;
import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;

import androidx.test.core.app.ApplicationProvider;

import org.commcare.activities.FormEntryActivity;
import org.commcare.utils.RobolectricUtil;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowApplication;
import org.robolectric.shadows.ShadowLocationManager;
import org.robolectric.shadows.ShadowLooper;

import java.util.Arrays;
import java.util.List;

/**
 * The device's location, as a worker's phone gives it: location switched on, the permission a form asks for
 * granted at the prompt, and a fix from the GPS.
 *
 * Android's form entry asks for the location permission when a form's poll of the location sensor finds none
 * (PollSensorController.missingPermissions, FormEntryDialogs.handleNoGpsBroadcast); the worker allows it, and the
 * app's own result handler starts the poll again (FormEntryActivity.onRequestPermissionsResult). The app then asks
 * the device's location service for updates (CommCareProviderLocationController, the controller a device
 * without Google Play services uses, which Robolectric's device is); Robolectric's location service hands it the
 * fix below, as a phone's GPS would, and PollSensorAction writes it where the form polls into
 * (PollSensorAction.updateReference). The fix is the one the lane's Connect proofs give a visit, taken at the
 * lane's instant (ProofClock), and finer than any auto-capture accuracy a profile asks for, so the poll stops at
 * it.
 */
final class Sensors {
    static final double LATITUDE = 12.9716;
    static final double LONGITUDE = 77.5946;
    static final double ALTITUDE = 920.0;
    static final float ACCURACY = 5.0f;
    private static final List<String> LOCATION =
            Arrays.asList(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION);

    /** The permission request's names, and the answer's results, as the framework passes them. */
    static final String REQUESTED = "android.content.pm.extra.REQUEST_PERMISSIONS_NAMES";
    static final String RESULTS = "android.content.pm.extra.REQUEST_PERMISSIONS_RESULTS";

    private Sensors() {
    }

    /**
     * The worker allows every permission a request asks for, as the system's permission dialog answers: the
     * permissions granted, and the dialog's result handed back to the activity that asked
     * (Activity.dispatchRequestPermissionsResult, which also ends the request, so the activity may ask again).
     */
    static void answer(Activity activity, Intent request) {
        String[] asked = request.getStringArrayExtra(REQUESTED);
        Shadows.shadowOf((Application)ApplicationProvider.getApplicationContext()).grantPermissions(asked);
        int[] granted = new int[asked.length];
        Arrays.fill(granted, PackageManager.PERMISSION_GRANTED);
        Intent result = new Intent();
        result.putExtra(REQUESTED, asked);
        result.putExtra(RESULTS, granted);
        Shadows.shadowOf(activity).receiveResult(request, Activity.RESULT_OK, result);
    }

    /** The device's location switched on, as a worker's phone has it before any form asks. */
    static void switchOn() {
        LocationManager manager = locationManager();
        ShadowLocationManager shadow = Shadows.shadowOf(manager);
        shadow.setProviderEnabled(LocationManager.GPS_PROVIDER, true);
        shadow.setProviderEnabled(LocationManager.NETWORK_PROVIDER, true);
    }

    /**
     * The location and microphone permissions taken back, so each walk starts on a device no form has asked yet,
     * whatever walks came before it on the reader's device.
     */
    static void forget() {
        ShadowApplication application = Shadows.shadowOf((Application)ApplicationProvider.getApplicationContext());
        application.denyPermissions(LOCATION.toArray(new String[0]));
        application.denyPermissions(Manifest.permission.RECORD_AUDIO);
    }

    /**
     * Where a screen asked the device for the location permission ({@code asked}, as Screens.deviceAsks recorded
     * it), allows it as the worker does at the prompt and lets the GPS give its fix; writes what the device gave
     * into {@code holder}'s {@code deviceGave}.
     */
    static void allow(FormEntryActivity activity, JSONObject holder) throws Exception {
        JSONArray asked = holder.optJSONArray("deviceAsked");
        if (asked == null || !asksLocation(asked)) {
            return;
        }
        answer(activity, Screens.permissionRequest);
        settle(activity);
        Location fix = new Location(LocationManager.GPS_PROVIDER);
        fix.setLatitude(LATITUDE);
        fix.setLongitude(LONGITUDE);
        fix.setAltitude(ALTITUDE);
        fix.setAccuracy(ACCURACY);
        fix.setTime(ProofClock.INSTANT);
        fix.setElapsedRealtimeNanos(android.os.SystemClock.elapsedRealtimeNanos());
        Shadows.shadowOf(locationManager()).simulateLocation(fix);
        settle(activity);
        JSONObject gave = new JSONObject();
        gave.put("permissions", new JSONArray(LOCATION));
        gave.put("location", LATITUDE + " " + LONGITUDE + " " + ALTITUDE + " " + ACCURACY);
        holder.put("deviceGave", gave);
    }

    private static boolean asksLocation(JSONArray asked) throws Exception {
        for (int i = 0; i < asked.length(); i++) {
            JSONArray permissions = asked.getJSONObject(i).optJSONArray("permissions");
            for (int j = 0; permissions != null && j < permissions.length(); j++) {
                if (Manifest.permission.ACCESS_FINE_LOCATION.equals(permissions.getString(j))) {
                    return true;
                }
            }
        }
        return false;
    }

    private static LocationManager locationManager() {
        return (LocationManager)ApplicationProvider.getApplicationContext()
                .getSystemService(Context.LOCATION_SERVICE);
    }

    private static void settle(Activity activity) {
        for (int turn = 0; turn < 4; turn++) {
            if (activity instanceof org.commcare.activities.CommCareActivity) {
                RobolectricUtil.flushBackgroundThread((org.commcare.activities.CommCareActivity)activity);
            }
            ShadowLooper.idleMainLooper();
        }
    }
}
