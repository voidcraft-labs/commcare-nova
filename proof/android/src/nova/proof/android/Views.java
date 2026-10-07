package nova.proof.android;

import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.TextView;

import org.commcare.activities.CommCareActivity;
import org.commcare.views.dialogs.AlertDialogFragment;
import org.commcare.views.dialogs.CommCareAlertDialog;
import org.commcare.views.dialogs.DialogChoiceItem;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.lang.reflect.Field;

/** Android's own views and dialogs, written as what a worker is shown and how it is laid out. */
final class Views {
    private Views() {
    }

    /**
     * A view as Android built it: its class, and for a text view its text, gravity and text size, for an image
     * view its scale type, with the width its layout gives it and its children the same way.
     */
    static JSONObject describe(View view) throws JSONException {
        JSONObject found = new JSONObject();
        found.put("class", view.getClass().getSimpleName());
        if (view.getVisibility() != View.VISIBLE) {
            found.put("visibility", view.getVisibility() == View.GONE ? "gone" : "invisible");
        }
        ViewGroup.LayoutParams params = view.getLayoutParams();
        if (params != null) {
            found.put("layoutWidth", params.width);
        }
        if (view instanceof TextView) {
            TextView text = (TextView)view;
            found.put("text", String.valueOf(text.getText()));
            found.put("gravity", gravity(text.getGravity()));
            found.put("textSize", (double)text.getTextSize());
        }
        if (view instanceof ImageView) {
            found.put("scaleType", String.valueOf(((ImageView)view).getScaleType()));
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup)view;
            JSONArray children = new JSONArray();
            for (int i = 0; i < group.getChildCount(); i++) {
                children.put(describe(group.getChildAt(i)));
            }
            if (children.length() > 0) {
                found.put("children", children);
            }
        }
        return found;
    }

    /** Android's gravity bits by name, horizontal then vertical, so two layouts compare by what they mean. */
    static String gravity(int gravity) {
        StringBuilder found = new StringBuilder();
        int horizontal = gravity & Gravity.RELATIVE_HORIZONTAL_GRAVITY_MASK;
        int vertical = gravity & Gravity.VERTICAL_GRAVITY_MASK;
        if ((horizontal & Gravity.RELATIVE_LAYOUT_DIRECTION) != 0) {
            horizontal &= ~Gravity.RELATIVE_LAYOUT_DIRECTION;
            found.append(horizontal == Gravity.LEFT ? "start" : horizontal == Gravity.RIGHT ? "end" : "h" + horizontal);
        } else if (horizontal == Gravity.LEFT) {
            found.append("left");
        } else if (horizontal == Gravity.RIGHT) {
            found.append("right");
        } else if (horizontal == Gravity.CENTER_HORIZONTAL) {
            found.append("center_horizontal");
        } else if (horizontal == Gravity.FILL_HORIZONTAL) {
            found.append("fill_horizontal");
        } else {
            found.append(horizontal == 0 ? "none" : "h" + horizontal);
        }
        found.append("|");
        if (vertical == Gravity.TOP) {
            found.append("top");
        } else if (vertical == Gravity.BOTTOM) {
            found.append("bottom");
        } else if (vertical == Gravity.CENTER_VERTICAL) {
            found.append("center_vertical");
        } else if (vertical == Gravity.FILL_VERTICAL) {
            found.append("fill_vertical");
        } else {
            found.append(vertical == 0 ? "none" : "v" + vertical);
        }
        return found.toString();
    }

    /**
     * The alert the activity is showing, or will show when it returns to the front, or null: its class and every text it was built with (its title, its
     * message, each choice it offers), read from the dialog object the activity handed to showAlertDialog.
     */
    static JSONObject alert(CommCareActivity<?> activity) throws Exception {
        activity.getSupportFragmentManager().executePendingTransactions();
        AlertDialogFragment fragment = activity.getCurrentAlertDialog();
        boolean pending = false;
        if (fragment == null) {
            // An activity that is not in front keeps the alert it was asked to show and shows it when it
            // returns to the front (CommCareActivity.showAlertDialog, showPendingAlertDialog).
            fragment = (AlertDialogFragment)Screens.field(activity, "alertDialogToShowOnResume");
            pending = true;
        }
        if (fragment == null) {
            return null;
        }
        Field held = AlertDialogFragment.class.getDeclaredField("underlyingDialog");
        held.setAccessible(true);
        CommCareAlertDialog dialog = (CommCareAlertDialog)held.get(fragment);
        if (dialog == null) {
            return null;
        }
        JSONObject found = new JSONObject();
        found.put("class", dialog.getClass().getSimpleName());
        found.put("shownWhenTheActivityReturns", pending);
        for (Class<?> owner = dialog.getClass(); owner != null && owner != Object.class; owner = owner.getSuperclass()) {
            for (Field field : owner.getDeclaredFields()) {
                field.setAccessible(true);
                Object value = field.get(dialog);
                if (value instanceof CharSequence) {
                    found.put(field.getName(), String.valueOf(value));
                } else if (value instanceof DialogChoiceItem[]) {
                    found.put(field.getName(), choices((DialogChoiceItem[])value));
                }
            }
        }
        return found;
    }

    static JSONArray choices(DialogChoiceItem[] items) {
        JSONArray found = new JSONArray();
        for (DialogChoiceItem item : items) {
            found.put(item.text);
        }
        return found;
    }

    /** Every text a view shows, in the order its tree holds them: each visible text view's, where not empty. */
    static JSONArray texts(View view) {
        JSONArray found = new JSONArray();
        texts(view, found);
        return found;
    }

    private static void texts(View view, JSONArray found) {
        if (view == null || view.getVisibility() != View.VISIBLE) {
            return;
        }
        if (view instanceof TextView) {
            String text = String.valueOf(((TextView)view).getText());
            if (!text.isEmpty()) {
                found.put(text);
            }
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup)view;
            for (int i = 0; i < group.getChildCount(); i++) {
                texts(group.getChildAt(i), found);
            }
        }
    }

    /** How many visible image views a view holds that show a picture. */
    static int images(View view) {
        if (view == null || view.getVisibility() != View.VISIBLE) {
            return 0;
        }
        int found = view instanceof ImageView && ((ImageView)view).getDrawable() != null ? 1 : 0;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup)view;
            for (int i = 0; i < group.getChildCount(); i++) {
                found += images(group.getChildAt(i));
            }
        }
        return found;
    }
}
