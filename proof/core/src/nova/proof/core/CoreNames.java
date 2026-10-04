package nova.proof.core;

import org.javarosa.core.model.Constants;
import org.javarosa.form.api.FormEntryController;

/** Names for Core's integer constants, as the trace and the answer table spell them. */
final class CoreNames {
    private CoreNames() {
    }

    static String dataType(int type) {
        switch (type) {
            case Constants.DATATYPE_UNSUPPORTED:
                return "unsupported";
            case Constants.DATATYPE_NULL:
                return "null";
            case Constants.DATATYPE_TEXT:
                return "text";
            case Constants.DATATYPE_INTEGER:
                return "integer";
            case Constants.DATATYPE_DECIMAL:
                return "decimal";
            case Constants.DATATYPE_DATE:
                return "date";
            case Constants.DATATYPE_TIME:
                return "time";
            case Constants.DATATYPE_DATE_TIME:
                return "dateTime";
            case Constants.DATATYPE_CHOICE:
                return "choice";
            case Constants.DATATYPE_CHOICE_LIST:
                return "choiceList";
            case Constants.DATATYPE_BOOLEAN:
                return "boolean";
            case Constants.DATATYPE_GEOPOINT:
                return "geopoint";
            case Constants.DATATYPE_BARCODE:
                return "barcode";
            case Constants.DATATYPE_BINARY:
                return "binary";
            case Constants.DATATYPE_LONG:
                return "long";
            default:
                return "type-" + type;
        }
    }

    static String control(int control) {
        switch (control) {
            case Constants.CONTROL_UNTYPED:
                return "untyped";
            case Constants.CONTROL_INPUT:
                return "input";
            case Constants.CONTROL_SELECT_ONE:
                return "select1";
            case Constants.CONTROL_SELECT_MULTI:
                return "select";
            case Constants.CONTROL_TEXTAREA:
                return "textarea";
            case Constants.CONTROL_SECRET:
                return "secret";
            case Constants.CONTROL_RANGE:
                return "range";
            case Constants.CONTROL_UPLOAD:
                return "upload";
            case Constants.CONTROL_SUBMIT:
                return "submit";
            case Constants.CONTROL_TRIGGER:
                return "trigger";
            case Constants.CONTROL_IMAGE_CHOOSE:
                return "image";
            case Constants.CONTROL_LABEL:
                return "label";
            case Constants.CONTROL_AUDIO_CAPTURE:
                return "audio";
            case Constants.CONTROL_VIDEO_CAPTURE:
                return "video";
            case Constants.CONTROL_DOCUMENT_UPLOAD:
                return "document";
            default:
                return "control-" + control;
        }
    }

    static String answerResult(int code) {
        switch (code) {
            case FormEntryController.ANSWER_OK:
                return "ok";
            case FormEntryController.ANSWER_REQUIRED_BUT_EMPTY:
                return "required";
            case FormEntryController.ANSWER_CONSTRAINT_VIOLATED:
                return "constraint";
            default:
                return "code-" + code;
        }
    }
}
