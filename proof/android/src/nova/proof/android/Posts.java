package nova.proof.android;

import android.app.Activity;
import android.content.Intent;
import android.view.View;
import android.widget.TextView;

import com.google.common.collect.Multimap;

import org.commcare.activities.PostRequestActivity;
import org.commcare.android.mocks.ModernHttpRequesterMock;
import org.commcare.dalvik.R;
import org.commcare.network.CommcareRequestEndpointsMock;
import org.commcare.network.LocalReferencePullResponseFactory;
import org.commcare.utils.RobolectricUtil;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowLooper;

/**
 * What Android's post screen does with the request home opened (PostRequestActivity: a claim of the case a
 * search found): what it posts, and, the server answering that it took the claim, the sync the screen then
 * runs with the app's own data pull, the server's restore being the one the device was restored from (the
 * walk's searches are answered from the cases the device holds, so a claimed case is one it holds already).
 * The screen's result goes back to home.
 */
final class Posts {
    private Posts() {
    }

    static boolean read(Intent started, JSONObject step, ShadowActivity home) throws Exception {
        JSONObject post = new JSONObject();
        step.put("post", post);
        Object url = started.getSerializableExtra(PostRequestActivity.URL_KEY);
        post.put("url", Screens.orNull(url == null ? null : Queries.address(String.valueOf(url))));
        Object params = started.getSerializableExtra(PostRequestActivity.PARAMS_KEY);
        if (params instanceof Multimap) {
            JSONObject sent = new JSONObject();
            Multimap<?, ?> multimap = (Multimap<?, ?>)params;
            for (Object key : new java.util.TreeSet<>(multimap.keySet())) {
                sent.put(String.valueOf(key), new JSONArray(multimap.get(cast(key))));
            }
            post.put("params", sent);
        }
        if (!Device.served()) {
            ModernHttpRequesterMock.setResponseCodes(new Integer[]{200});
            ModernHttpRequesterMock.setExpectedUrls(new String[0]);
            ModernHttpRequesterMock.setRequestPayloads(new String[0]);
        }
        if (!Device.served() && Device.restoreReference() != null) {
            CommcareRequestEndpointsMock.setCaseFetchResponseCodes(new Integer[]{200});
            LocalReferencePullResponseFactory.setRequestPayloads(new String[]{Device.restoreReference()});
        }
        Device.dirty = true;
        PostRequestActivity activity =
                Robolectric.buildActivity(PostRequestActivity.class, started).create().start().resume().get();
        RobolectricUtil.flushBackgroundThread(activity);
        ShadowLooper.idleMainLooper();
        RobolectricUtil.flushBackgroundThread(activity);
        ShadowLooper.idleMainLooper();
        ShadowActivity shadow = Shadows.shadowOf((Activity)activity);
        post.put("finishing", activity.isFinishing());
        post.put("resultCode", shadow.getResultCode());
        TextView error = (TextView)((Activity)activity).findViewById(R.id.error_message);
        if (error != null && error.getVisibility() == View.VISIBLE) {
            post.put("errorText", String.valueOf(error.getText()));
        }
        post.put("alert", Screens.orNull(Views.alert(activity)));
        if (!activity.isFinishing()) {
            return false;
        }
        home.receiveResult(started, shadow.getResultCode(), shadow.getResultIntent());
        ShadowLooper.idleMainLooper();
        return shadow.getResultCode() == Activity.RESULT_OK;
    }

    @SuppressWarnings("unchecked")
    private static <K> K cast(Object key) {
        return (K)key;
    }
}
