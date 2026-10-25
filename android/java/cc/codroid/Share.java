package cc.codroid;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.StatFs;
import android.provider.OpenableColumns;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 往外发文件：会话导出包、日志包，经系统分享面板交给别的应用。
 *
 * 自己写一个最小的 ContentProvider，不引 androidx 的 FileProvider（构建链里没有它）。
 * 不导出，只靠分享时随 Intent 发出的一次性读授权访问；只认三个目录，别的路径一概拒绝。
 */
public final class Share extends ContentProvider {
    static final String AUTH = "cc.codroid.share";

    /** URI 第一段 → 允许的根目录 */
    private static File root(Context c, String name) {
        Env env = new Env(c);
        switch (name) {
            case "logs": return new File(env.files, "cache/share");
            case "exports": return new File(env.home, "exports");
            case "sexports": { File s = env.shared(); return s == null ? null : new File(s, "exports"); }
            case "camera": return Camera.dir(c);          // 拍照：系统相机往这里写（只有这个根可写）
            default: return null;
        }
    }

    /** 绝对路径 → content:// 地址；不在允许的目录里就返回 null */
    static Uri uriFor(Context c, File f) throws IOException {
        String p = f.getCanonicalPath();
        for (String r : new String[]{"logs", "exports", "sexports", "camera"}) {
            File d = root(c, r);
            if (d == null) continue;
            String dp = d.getCanonicalPath() + "/";
            if (p.startsWith(dp)) return new Uri.Builder().scheme("content").authority(AUTH).appendPath(r).appendEncodedPath(Uri.encode(p.substring(dp.length()), "/")).build();
        }
        return null;
    }

    private File fileFor(Uri u) throws FileNotFoundException {
        java.util.List<String> seg = u.getPathSegments();
        if (seg.size() < 2) throw new FileNotFoundException();
        File d = root(getContext(), seg.get(0));
        if (d == null) throw new FileNotFoundException();
        try {
            File f = new File(d, String.join("/", seg.subList(1, seg.size()))).getCanonicalFile();
            if (!f.getPath().startsWith(d.getCanonicalPath() + "/") || !f.isFile()) throw new FileNotFoundException();
            return f;
        } catch (IOException e) { throw new FileNotFoundException(); }
    }

    /** 不在允许目录里的文件（工作区、/sdcard 上的）：拷一份到 exports/shared 再分享，别的应用拿到的是这一份的只读授权 */
    static File shareable(Context c, File f) throws Exception {
        if (!f.isFile()) throw new FileNotFoundException(Tr.t("文件不存在：") + f);
        if (uriFor(c, f) != null) return f;
        if (f.length() > 512L << 20) throw new IOException(Tr.t("文件超过 512 MB，不分享"));
        File dir = new File(new Env(c).home, "exports/shared");
        dir.mkdirs();
        File dst = new File(dir, f.getName());
        java.nio.file.Files.copy(f.toPath(), dst.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        return dst;
    }

    /** 按扩展名猜类型；猜不出就当二进制 */
    static String mimeOf(File f) {
        String ext = android.webkit.MimeTypeMap.getFileExtensionFromUrl(Uri.encode(f.getName()));
        String m = ext == null || ext.isEmpty() ? null : android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return m == null ? "application/octet-stream" : m;
    }

    /** 弹系统分享面板 */
    static JSONObject send(Context c, File f, String mime) throws Exception {
        Uri u = uriFor(c, f);
        if (u == null || !f.isFile()) return new JSONObject().put("ok", false).put("message", Tr.t("这个文件不能分享：") + f);
        Intent send = new Intent(Intent.ACTION_SEND).setType(mime)
            .putExtra(Intent.EXTRA_STREAM, u).putExtra(Intent.EXTRA_SUBJECT, f.getName())
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(android.content.ClipData.newRawUri(f.getName(), u));
        c.startActivity(Intent.createChooser(send, f.getName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION));
        return new JSONObject().put("ok", true).put("file", f.getPath());
    }

    // ── 日志包 ──────────────────────────────────────────────────────────
    // 密钥、令牌、邮箱抹掉再打包。提问开头那几十个字网关日志里有，界面上发之前会提醒
    private static final Pattern SECRET = Pattern.compile(
        "(sk-[A-Za-z0-9_\\-]{4,}|sk-ant-[A-Za-z0-9_\\-]+|gh[pousr]_[A-Za-z0-9]{8,}|Bearer\\s+[A-Za-z0-9._\\-]{8,}|cc_t_\\d+=[^;\\s]+|X-CC-Token:?\\s*\\S+)");
    private static final Pattern EMAIL = Pattern.compile("[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}");
    // 网关日志里记着每条提问 / 插话的开头几十个字：那是用户的对话内容，诊断用不着，抹掉
    private static final Pattern ASK = Pattern.compile("(▶ (?:提问|命令) ).*?(  \\((?:续 [0-9a-f]{8}|新会话)\\))", Pattern.DOTALL);
    private static final Pattern INJ = Pattern.compile("(↪ 插话 ).*");
    static String scrub(String s) {
        s = INJ.matcher(ASK.matcher(s).replaceAll("$1«内容已抹去»$2")).replaceAll("$1«内容已抹去»");
        return EMAIL.matcher(SECRET.matcher(s).replaceAll("«已抹去»")).replaceAll("«邮箱»");
    }

    /** 包里有什么、去掉了什么 —— 「我卡住了」打包前给用户看的就是这份（README.txt 也放一份进包里） */
    static String contents() { return
        Tr.t("包里有：\n") +
        Tr.t("· 版本与设备：cccodroid / Android 版本、机型、芯片、剩余空间\n") +
        Tr.t("· 开发工具包：装的是哪一版（校验哈希）、更新与自检状态\n") +
        Tr.t("· 最近的日志：本应用的系统日志、网关日志的最后一段\n") +
        Tr.t("· 修复账本：安装、校验、修复做过哪些、成没成\n") +
        Tr.t("\n已经去掉：\n") +
        Tr.t("· 密钥、令牌、登录凭据、邮箱\n") +
        Tr.t("· 你发给 Claude 的消息内容（日志里只留「提问了一次」）\n") +
        Tr.t("· 会话记录本身不在包里\n"); }

    /** 打包：诊断信息 + 本应用 logcat + 网关日志尾部 + 修复账本 → files/cache/share/cccodroid-logs-*.zip */
    static File bundleLogs(Context c) throws Exception {
        Env env = new Env(c);
        File dir = new File(env.files, "cache/share");
        dir.mkdirs();
        File[] old = dir.listFiles();
        if (old != null) for (File o : old) if (o.getName().startsWith("cccodroid-logs-")) o.delete();
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(new Date());
        File out = new File(dir, "cccodroid-logs-" + stamp + ".zip");
        JSONObject parts = new JSONObject();
        try (ZipOutputStream z = new ZipOutputStream(new FileOutputStream(out))) {
            parts.put("README.txt", put(z, "README.txt", Tr.t("cccodroid 诊断包（「我卡住了」）\n\n") + contents()));
            parts.put("diagnostics.txt", put(z, "diagnostics.txt", diagnostics(c, env)));
            parts.put("logcat.txt", put(z, "logcat.txt", scrub(logcat())));
            if (env.log.isFile()) parts.put("gateway.log", put(z, "gateway.log", scrub(tail(env.log, 1024 * 1024))));
            // 网关进程的标准输出 / 错误：node 崩溃的堆栈只在这里
            File gout = new File(env.home, "gateway.out");
            if (gout.isFile()) parts.put("gateway.out", put(z, "gateway.out", scrub(tail(gout, 512 * 1024))));
            File led = Ledger.file(env);
            if (led.isFile()) parts.put("ledger.jsonl", put(z, "ledger.jsonl", scrub(tail(led, 512 * 1024))));
        }
        Ledger.add(env, "logs", true, Tr.f("打包日志用于分享（压缩后 {0} KB）", out.length() / 1024), parts);
        return out;
    }

    /** @return 写进去的字节数（账本里记一笔，方便核对包里到底有什么） */
    private static int put(ZipOutputStream z, String name, String text) throws IOException {
        byte[] b = text.getBytes(StandardCharsets.UTF_8);
        z.putNextEntry(new ZipEntry(name));
        z.write(b);
        z.closeEntry();
        return b.length;
    }

    private static String diagnostics(Context c, Env env) {
        StringBuilder sb = new StringBuilder();
        try {
            sb.append("cccodroid ").append(c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName).append('\n');
            sb.append("Android ").append(Build.VERSION.RELEASE).append(" (SDK ").append(Build.VERSION.SDK_INT).append(")  ")
              .append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append("  ").append(Build.SUPPORTED_ABIS[0]).append('\n');
            sb.append("user=").append(android.os.Process.myUid() / 100000).append("  files=").append(c.getFilesDir().getAbsolutePath())
              .append(MainActivity.secondaryUser(c) ? "  （非主空间）" : "").append('\n');
            sb.append("SoC ").append(Build.VERSION.SDK_INT >= 31 ? Build.SOC_MODEL : "?").append("  内核 ").append(System.getProperty("os.version")).append('\n');
            StatFs st = new StatFs(env.files.getPath());
            sb.append("私有目录剩余 ").append(st.getAvailableBytes() >> 20).append(" MB\n");
            sb.append("开发工具包就绪 ").append(env.devkitReady()).append("  claude 就绪 ").append(env.claudeReady()).append('\n');
            File ok = new File(env.usr, ".devkit-ok");
            if (ok.isFile()) sb.append(".devkit-ok ").append(new String(java.nio.file.Files.readAllBytes(ok.toPath()), StandardCharsets.UTF_8).trim()).append('\n');
            sb.append("安全模式 ").append(new File(env.home, ".ccapp-safe-mode").exists()).append('\n');
            sb.append("\n更新状态\n").append(Updater.get(c).status().toString(1)).append('\n');
        } catch (Exception e) { sb.append("（诊断信息不全：").append(e).append("）\n"); }
        return scrub(sb.toString());
    }

    /** 本进程能读到的只有自己的日志（安卓 4.1 起），正好 */
    private static String logcat() {
        try {
            Process p = new ProcessBuilder("logcat", "-d", "-v", "time", "-t", "8000").redirectErrorStream(true).start();
            String s = readAll(p.getInputStream());
            p.waitFor();
            return s;
        } catch (Exception e) { return "（读不到 logcat：" + e + "）"; }
    }

    private static String tail(File f, int max) throws IOException {
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) {
            long n = r.length(), from = Math.max(0, n - max);
            byte[] b = new byte[(int) (n - from)];
            r.seek(from); r.readFully(b);
            return (from > 0 ? "…（前面省略 " + from / 1024 + " KB）\n" : "") + new String(b, StandardCharsets.UTF_8);
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] b = new byte[65536];
        for (int k; (k = in.read(b)) > 0; ) o.write(b, 0, k);
        return o.toString("UTF-8");
    }

    // ── ContentProvider ────────────────────────────────────────────────
    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if ("r".equals(mode)) return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
        // 只有拍照目录可写：相机按 EXTRA_OUTPUT 写进我们事先建好的空文件
        if (uri.getPathSegments().size() == 2 && "camera".equals(uri.getPathSegments().get(0)))
            return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.parseMode(mode));
        throw new FileNotFoundException("只读");
    }

    @Override public Cursor query(Uri uri, String[] proj, String sel, String[] args, String sort) {
        File f;
        try { f = fileFor(uri); } catch (FileNotFoundException e) { return null; }
        String[] cols = proj != null ? proj : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        c.addRow(row);
        return c;
    }

    @Override public String getType(Uri uri) {
        String p = uri.getPath();
        return p != null && p.endsWith(".zip") ? "application/zip" : p != null && p.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream";
    }
    @Override public Uri insert(Uri uri, ContentValues v) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String s, String[] a) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues v, String s, String[] a) { throw new UnsupportedOperationException(); }
}
