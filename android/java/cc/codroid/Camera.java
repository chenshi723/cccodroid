package cc.codroid;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.provider.MediaStore;

import java.io.File;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * ＋ 面板「拍照」：交给系统相机拍，照片写进 cache/camera（经 Share 的 camera 根授权写入），回来后缩小再交给页面。
 *
 * 不声明 CAMERA 权限 —— 清单里一旦声明了又没授权，ACTION_IMAGE_CAPTURE 会直接抛 SecurityException。
 * 手机原图常有 4–12 MB：长边缩到 2048、按 EXIF 转正、存 JPEG 85，发给模型够看清字，也不会超接口的图片上限。
 */
final class Camera {
    static final int MAX = 2048;

    static File dir(Context c) { return new File(new Env(c).files, "cache/camera"); }

    /** 新建一个空文件给相机写；顺手清掉一天前没用上的 */
    static File newFile(Context c) throws Exception {
        File d = dir(c);
        d.mkdirs();
        File[] old = d.listFiles();
        if (old != null) for (File f : old) if (System.currentTimeMillis() - f.lastModified() > 86_400_000L) f.delete();
        File f = new File(d, "IMG_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date()) + ".jpg");
        new FileOutputStream(f).close();
        return f;
    }

    static Intent intent(Context c, File f) throws Exception {
        Uri u = Share.uriFor(c, f);
        Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, u)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        i.setClipData(ClipData.newRawUri(f.getName(), u));
        return i;
    }

    /** 缩小、转正、重存。读不出图（相机没写、写坏了）返回 false */
    static boolean shrink(File f) {
        if (f.length() == 0) return false;
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(f.getPath(), o);
        if (o.outWidth <= 0 || o.outHeight <= 0) return false;
        int deg = 0;
        try {
            switch (new ExifInterface(f.getPath()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                case ExifInterface.ORIENTATION_ROTATE_90: deg = 90; break;
                case ExifInterface.ORIENTATION_ROTATE_180: deg = 180; break;
                case ExifInterface.ORIENTATION_ROTATE_270: deg = 270; break;
            }
        } catch (Exception ignored) {}
        int longSide = Math.max(o.outWidth, o.outHeight);
        if (longSide <= MAX && deg == 0) return true;            // 本来就不大、方向也对：原样用
        BitmapFactory.Options d = new BitmapFactory.Options();
        d.inSampleSize = 1;
        while (longSide / (d.inSampleSize * 2) >= MAX) d.inSampleSize *= 2;   // 先按 2 的幂粗缩，省内存
        Bitmap b = BitmapFactory.decodeFile(f.getPath(), d);
        if (b == null) return false;
        float s = Math.min(1f, (float) MAX / Math.max(b.getWidth(), b.getHeight()));
        Matrix m = new Matrix();
        m.postScale(s, s);
        m.postRotate(deg);
        Bitmap r = Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), m, true);
        if (r != b) b.recycle();
        try (FileOutputStream out = new FileOutputStream(f)) {
            r.compress(Bitmap.CompressFormat.JPEG, 85, out);
        } catch (Exception e) { return false; }
        finally { r.recycle(); }
        return true;
    }
}
