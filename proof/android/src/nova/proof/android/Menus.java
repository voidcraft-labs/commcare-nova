package nova.proof.android;

import android.app.Activity;
import android.content.Intent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;

import org.commcare.activities.MenuActivity;
import org.commcare.adapters.MenuAdapter;
import org.commcare.session.SessionFrame;
import org.commcare.suite.model.Entry;
import org.commcare.suite.model.MenuDisplayable;
import org.javarosa.core.reference.ReferenceManager;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowLooper;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * What Android's menu screen shows for the menu home opened (MenuActivity and its MenuAdapter): every item the
 * adapter holds, which is every menu and form whose display condition the app's own loader found true
 * (MenuLoader), each as its own row view shows it, with the image and audio it names and whether the device
 * holds them. An item is chosen as a tap chooses it: the screen's own click listener sets the result home reads.
 */
final class Menus {
    private Menus() {
    }

    private static MenuActivity open(Intent started) {
        MenuActivity activity = Robolectric.buildActivity(MenuActivity.class, started).setup().get();
        ShadowLooper.idleMainLooper();
        return activity;
    }

    private static AdapterView<?> items(View view) {
        if (view instanceof AdapterView && ((AdapterView<?>)view).getAdapter() instanceof MenuAdapter) {
            return (AdapterView<?>)view;
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup)view;
            for (int i = 0; i < group.getChildCount(); i++) {
                AdapterView<?> found = items(group.getChildAt(i));
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    private static String id(Object item) {
        return ((MenuDisplayable)item).getCommandID();
    }

    /** Reads the menu; the ids of the items it offers, in its order. */
    static List<String> read(Intent started, JSONObject step) throws Exception {
        MenuActivity activity = open(started);
        List<String> offered = new ArrayList<>();
        JSONObject menu = new JSONObject();
        step.put("menu", menu);
        menu.put("id", Screens.orNull(started.getStringExtra(SessionFrame.STATE_COMMAND_ID)));
        menu.put("alert", Screens.orNull(Views.alert(activity)));
        AdapterView<?> view = items(((Activity)activity).findViewById(android.R.id.content));
        if (view == null) {
            menu.put("items", JSONObject.NULL);
            return offered;
        }
        menu.put("view", view.getClass().getSimpleName());
        MenuAdapter adapter = (MenuAdapter)view.getAdapter();
        JSONArray items = new JSONArray();
        for (int i = 0; i < adapter.getCount(); i++) {
            Object item = adapter.getItem(i);
            JSONObject shown = new JSONObject();
            shown.put("id", id(item));
            shown.put("kind", item instanceof Entry ? "form" : "menu");
            shown.put("texts", Views.texts(adapter.getView(i, null, view)));
            shown.put("image", media(((MenuDisplayable)item).getImageURI()));
            shown.put("audio", media(((MenuDisplayable)item).getAudioURI()));
            items.put(shown);
            offered.add(id(item));
        }
        menu.put("items", items);
        return offered;
    }

    /** A media reference an item names, and whether the device holds a file for it; null where it names none. */
    static Object media(String uri) throws Exception {
        if (uri == null || uri.isEmpty()) {
            return JSONObject.NULL;
        }
        JSONObject found = new JSONObject();
        found.put("uri", uri);
        try {
            found.put("held", new File(ReferenceManager.instance().DeriveReference(uri).getLocalURI()).exists());
        } catch (Exception raised) {
            found.put("held", "raised " + raised.getClass().getSimpleName());
        }
        return found;
    }

    /** Chooses {@code choice} on the menu, by the screen's own click; false where the menu does not offer it. */
    static boolean choose(Intent started, JSONObject step, ShadowActivity home, String choice) throws Exception {
        MenuActivity activity = open(started);
        step.put("chose", choice);
        AdapterView<?> view = items(((Activity)activity).findViewById(android.R.id.content));
        MenuAdapter adapter = view == null ? null : (MenuAdapter)view.getAdapter();
        for (int i = 0; adapter != null && i < adapter.getCount(); i++) {
            if (choice.equals(id(adapter.getItem(i)))) {
                view.getOnItemClickListener().onItemClick(view, null, i, adapter.getItemId(i));
                ShadowLooper.idleMainLooper();
                ShadowActivity shadow = Shadows.shadowOf((Activity)activity);
                home.receiveResult(started, shadow.getResultCode(), shadow.getResultIntent());
                ShadowLooper.idleMainLooper();
                return true;
            }
        }
        step.put("offered", false);
        return false;
    }
}
