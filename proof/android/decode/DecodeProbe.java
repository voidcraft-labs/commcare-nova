import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import java.io.File;
import java.nio.ByteBuffer;
import java.util.Arrays;

/**
 * What an Android system image's own decoders make of each media file in a directory: each audio and video file
 * read by MediaExtractor and decoded to the end of its stream by the platform's own MediaCodec decoder, and each
 * image decoded by BitmapFactory. One JSON line per file on standard output.
 *
 * Built against the SDK's android.jar and run on a device with app_process (proof/android/decode/run.sh):
 *
 *   CLASSPATH=/data/local/tmp/decode-probe.dex app_process /system/bin DecodeProbe /data/local/tmp/decode
 */
public final class DecodeProbe {
    private static final long TIMEOUT_US = 10_000;

    public static void main(String[] args) throws Exception {
        File[] files = new File(args[0]).listFiles();
        if (files == null) throw new IllegalArgumentException("No directory " + args[0]);
        Arrays.sort(files);
        for (File file : files) {
            String result;
            try {
                result = file.getName().endsWith(".bmp") ? image(file) : stream(file);
            } catch (Exception refused) {
                result = "\"outcome\":\"refused\",\"reason\":" + quoted(String.valueOf(refused));
            }
            System.out.println("{\"file\":" + quoted(file.getName()) + "," + result + "}");
        }
    }

    private static String image(File file) {
        Bitmap bitmap = BitmapFactory.decodeFile(file.getPath());
        if (bitmap == null) return "\"outcome\":\"refused\",\"reason\":\"BitmapFactory decoded nothing\"";
        return "\"outcome\":\"decoded\",\"decoder\":\"BitmapFactory\",\"width\":" + bitmap.getWidth()
                + ",\"height\":" + bitmap.getHeight();
    }

    /** Decode the file's first video track, or its first audio track where it has none, to the end of its stream. */
    private static String stream(File file) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(file.getPath());
            int chosen = -1;
            for (int kind = 0; kind < 2 && chosen < 0; kind++) {
                String prefix = kind == 0 ? "video/" : "audio/";
                for (int i = 0; i < extractor.getTrackCount(); i++) {
                    String mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
                    if (mime != null && mime.startsWith(prefix)) { chosen = i; break; }
                }
            }
            if (chosen < 0) return "\"outcome\":\"no-track\",\"tracks\":" + extractor.getTrackCount();
            MediaFormat format = extractor.getTrackFormat(chosen);
            String mime = format.getString(MediaFormat.KEY_MIME);
            extractor.selectTrack(chosen);
            MediaCodec codec;
            try {
                codec = MediaCodec.createDecoderByType(mime);
            } catch (Exception none) {
                return "\"outcome\":\"no-decoder\",\"mime\":" + quoted(mime);
            }
            try {
                codec.configure(format, null, null, 0);
                codec.start();
                int frames = decode(extractor, codec);
                return "\"outcome\":\"decoded\",\"mime\":" + quoted(mime) + ",\"decoder\":" + quoted(codec.getName())
                        + ",\"frames\":" + frames;
            } catch (Exception refused) {
                return "\"outcome\":\"refused\",\"mime\":" + quoted(mime) + ",\"decoder\":" + quoted(codec.getName())
                        + ",\"reason\":" + quoted(String.valueOf(refused));
            } finally {
                codec.release();
            }
        } finally {
            extractor.release();
        }
    }

    /** Feed every sample and drain every output buffer until the decoder signals the end of the stream. */
    private static int decode(MediaExtractor extractor, MediaCodec codec) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        boolean inputDone = false;
        int frames = 0;
        for (int idle = 0; idle < 2_000; ) {
            if (!inputDone) {
                int in = codec.dequeueInputBuffer(TIMEOUT_US);
                if (in >= 0) {
                    ByteBuffer buffer = codec.getInputBuffer(in);
                    int size = extractor.readSampleData(buffer, 0);
                    if (size < 0) {
                        codec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                        inputDone = true;
                    } else {
                        codec.queueInputBuffer(in, 0, size, extractor.getSampleTime(), 0);
                        extractor.advance();
                    }
                }
            }
            int out = codec.dequeueOutputBuffer(info, TIMEOUT_US);
            if (out >= 0) {
                if (info.size > 0) frames++;
                codec.releaseOutputBuffer(out, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return frames;
                idle = 0;
            } else {
                idle++;
            }
        }
        throw new IllegalStateException("The decoder never reached the end of the stream after " + frames + " frames");
    }

    private static String quoted(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }
}
