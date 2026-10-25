package cc.codroid;

import android.content.Context;
import java.io.File;
import java.util.Map;

/** 目录布局与子进程环境。前缀固定为 /data/data/cc.codroid/files/usr —— devkit 按它等长改写过。 */
final class Env {
    static final int PORT = 8791;

    /** 网关访问令牌（server.mjs 首次启动时生成，0600，存在应用私有目录）。见 server.mjs「访问控制」 */
    private static volatile File tokenFile = new File("/data/data/cc.codroid/files/home/.gateway-token");

    static String token() {
        try { return new String(java.nio.file.Files.readAllBytes(tokenFile.toPath()), "UTF-8").trim(); }
        catch (Exception e) { return ""; }
    }

    /** 连本机网关：自动带上令牌头。网关没生成令牌前会得到 403，调用方照"没就绪"处理即可 */
    static java.net.HttpURLConnection gateway(String path) throws java.io.IOException {
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL("http://127.0.0.1:" + PORT + path).openConnection();
        c.setRequestProperty("X-CC-Token", token());
        return c;
    }

    /** 原生桥（CCApp）的口令：每次进程启动随机生成，只经首页地址交给界面主框架。
     *  addJavascriptInterface 会注入到 WebView 里的每一个 frame（包括 HTML 预览的 iframe），而且分不出是谁在调；
     *  有副作用的方法都要带这个口令，预览页拿不到它（不同源，读不到主框架的地址和 sessionStorage）。10-25 安全审计 H-2 */
    static final String BRIDGE_KEY;
    static {
        byte[] b = new byte[16];
        new java.security.SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        BRIDGE_KEY = sb.toString();
    }
    static boolean bridgeOk(String k) {
        return k != null && java.security.MessageDigest.isEqual(k.getBytes(), BRIDGE_KEY.getBytes());
    }

    /** WebView 首次加载的地址：带 ?t= 让网关种 Cookie，带 k= 把原生桥口令交给界面 */
    static String uiUrl() {
        String t = token();
        return "http://127.0.0.1:" + PORT + "/?" + (t.isEmpty() ? "" : "t=" + t + "&") + "k=" + BRIDGE_KEY;
    }

    final File files, usr, home, app, log;
    /** 「经加载器」执行方式：数据目录里的程序一律经 /system/bin/linker64（bionic）或 APK 里的 glibc ld.so 起 */
    final boolean loader;
    /** APK 原生库目录（libldlinux.so 在这里；targetSdk 36 只能 exec 这里的文件） */
    final String nativeLib;
    final String pkg;
    final int targetSdk;
    static final String LINKER = "/system/bin/linker64";

    Env(Context c) {
        files = c.getFilesDir();
        nativeLib = c.getApplicationInfo().nativeLibraryDir;
        pkg = c.getPackageName();
        targetSdk = c.getApplicationInfo().targetSdkVersion;
        usr = new File(files, "usr");
        home = new File(files, "home");
        app = new File(files, "app");
        log = new File(home, "gateway.log");
        tokenFile = new File(home, ".gateway-token");
        loader = useLoader(c) && (mustLoader(c) || ldsoMatches());   // 放最后：ldsoMatches 要用到 usr
    }

    /**
     * 执行方式。files/.exec-mode 里写 direct / loader，没有就按 targetSdk 定：≥ 29 的包不能直接 exec 数据目录里的文件，只能经加载器。
     * targetSdk ≥ 29 时写了 direct 也不认（那样什么都起不来）。改了要重启网关才生效
     */
    static boolean mustLoader(Context c) { return c.getApplicationInfo().targetSdkVersion >= 29; }
    static String execPref(Context c) {
        try { return new String(java.nio.file.Files.readAllBytes(new File(c.getFilesDir(), ".exec-mode").toPath()), "UTF-8").trim(); }
        catch (Exception e) { return ""; }
    }
    static boolean useLoader(Context c) { return mustLoader(c) || "loader".equals(execPref(c)); }

    /**
     * APK 里的 ld.so 和工具包里现装的是不是同一份。glibc 要求 ld.so 与 libc.so.6 出自同一次构建：
     * APK 先升级、工具包还没跟上时两者会不一致 —— 28 包此时退回直接执行；36 包没得退，网关日志里会报（见 server.mjs 启动自检）
     */
    boolean ldsoMatches() {
        try {
            byte[] a = java.nio.file.Files.readAllBytes(new File(nativeLib, "libldlinux.so").toPath());
            byte[] b = java.nio.file.Files.readAllBytes(new File(usr, "glibc/lib/ld-linux-aarch64.so.1").toPath());
            return java.util.Arrays.equals(a, b);
        } catch (Exception e) { return false; }
    }

    /** 拼要起的命令：经加载器时，数据目录里的 ELF 程序前面加上 linker64 */
    java.util.List<String> cmd(String... argv) {
        java.util.List<String> l = new java.util.ArrayList<>(java.util.Arrays.asList(argv));
        if (loader && isElf(l.get(0)) && !l.get(0).startsWith("/system/")) l.add(0, LINKER);
        return l;
    }

    private static boolean isElf(String p) {
        try (java.io.FileInputStream in = new java.io.FileInputStream(p)) {
            byte[] h = new byte[4];
            return in.read(h) == 4 && h[0] == 0x7f && h[1] == 'E' && h[2] == 'L' && h[3] == 'F';
        } catch (Exception e) { return false; }
    }

    File bin(String name) { return new File(usr, "bin/" + name); }

    // 经加载器时程序不会被直接执行，只看文件在不在（canExecute 走 access(X_OK)，不该拿它判断能不能跑）
    boolean devkitReady() { return new File(usr, ".devkit-ok").isFile() && (loader ? bin("node").isFile() : bin("node").canExecute()); }

    /** 已装工具包的来历（Installer 写的 JSON：base、sha256）。早期版本里只有一行 "ok" → 空对象 */
    org.json.JSONObject devkitInfo() {
        try { return new org.json.JSONObject(new String(java.nio.file.Files.readAllBytes(new File(usr, ".devkit-ok").toPath()), "UTF-8")); }
        catch (Exception e) { return new org.json.JSONObject(); }
    }

    /** 官方 Claude Code：install-claude.sh 装好后写下的版本指针 */
    File claude() { return new File(home, ".local/share/cccodroid/claude/current/claude"); }

    boolean claudeReady() { return loader ? claude().isFile() : claude().canExecute(); }

    /** 用户在设置里卸了 Claude Code：有这个标记就别自动装回去（启动、换渠道都不装），等用户点「安装…」自己选版本 */
    File claudeOffFlag() { return new File(files, ".claude-uninstalled"); }
    boolean claudeOff() { return claudeOffFlag().isFile(); }

    /**
     * 工作区放在私有目录。/sdcard 是 FUSE：不能执行程序、不能建符号链接、git 嫌属主不对、
     * npm install 建不了 .bin —— 实测在那里几乎干不了开发。私有目录里这些都正常，界面的文件浏览器也看得到。
     */
    File workspace() {
        File p = new File(home, "workspace");
        p.mkdirs();
        return p;
    }

    /** 与别的应用交换文件的地方（交付的 APK、截图之类）。拿不到存储权限时为 null */
    File shared() {
        File w = new File("/sdcard/cccodroid");
        if ((w.isDirectory() || w.mkdirs()) && w.canWrite()) return w;
        return null;
    }

    void apply(Map<String, String> e) {
        e.remove("LD_LIBRARY_PATH");
        e.remove("LD_PRELOAD");
        e.put("PREFIX", usr.getPath());
        e.put("HOME", home.getPath());
        e.put("TMPDIR", new File(usr, "tmp").getPath());
        // app/pre 在最前：只放 pkg / apt（压过工具包里同名的旧说明替身）
        e.put("PATH", new File(app, "pre").getPath() + ":" + usr.getPath() + "/bin:" + new File(app, "bin").getPath() + ":/system/bin:/system/xbin");
        e.put("LANG", "en_US.UTF-8");
        e.put("TERM", "xterm-256color");
        // typst 自带的只有拉丁字体，不给它路径中文就渲染成空白方框；安卓的字体都在 /system/fonts
        e.put("TYPST_FONT_PATHS", "/system/fonts");
        e.put("SHELL", bin("bash").getPath());
        // 网关（server.mjs）认的变量
        e.put("CCAPP_PREFIX", usr.getPath());
        e.put("CCAPP_HOME", home.getPath());
        e.put("CCAPP_RUNTIME", files.getPath());
        e.put("CCAPP_WORKSPACE", workspace().getPath());
        File sh = shared();
        if (sh != null) e.put("CCAPP_SHARED", sh.getPath());
        e.put("CCAPP_PORT", String.valueOf(PORT));
        e.put("CCAPP_TOKEN_FILE", new File(home, ".gateway-token").getPath());
        e.put("CCAPP_SHELL", bin("bash").getPath());
        e.put("CCAPP_LOADER", new File(usr, "glibc/lib/ld-linux-aarch64.so.1").getPath());
        e.put("CCAPP_GLIBC_LIB", new File(usr, "glibc/lib").getPath());
        e.put("CCAPP_CLAUDE", claude().getPath());
        // ld-linux --preload 给 claude 挂上：被 seccomp 拦下的调用改回 ENOSYS（Android 14 拦 epoll_pwait2）
        e.put("CCAPP_CLAUDE_PRELOAD", new File(app, "lib/seccomp-enosys.so").getPath());
        e.put("CCAPP_LOG", log.getPath());
        e.put("CCAPP_LEDGER", Ledger.file(this).getPath());   // 修复账本：网关记安全模式、界面能翻
        e.put("CCAPP_SEED", new File(home, "seed.json").getPath());
        e.put("CCAPP_BIN", new File(app, "bin").getPath());   // 应用自带的小工具（priv）
        e.put("CCAPP_TARGET_SDK", String.valueOf(targetSdk));
        e.put("CCAPP_EXEC", loader ? "loader" : "direct");
        e.put("CCAPP_NATIVE_LIB", nativeLib);
        if (loader) applyLoader(e);
    }

    /**
     * 「经加载器」的环境（与直接执行的差别全在这里）：
     *  - bionic：LD_PRELOAD 挂 termux-exec 的 linker 版，exec 数据目录里的程序时自动改成 linker64 起；强制模式，28 包上也照样走（便于验证）
     *  - glibc：claude 经 APK 里的 libldlinux.so 起，--preload 再加 exec-shim.so，Bun 拉子进程时同样改写（见 native/exec-shim.c）
     *  - node：经 linker64 起时 process.execPath 是 linker64，execpath.cjs 改回真实路径
     * glibc 进程不能继承 LD_PRELOAD（bionic 库，ld.so 直接报 invalid ELF header）：网关拉 claude 前会摘掉
     */
    private void applyLoader(Map<String, String> e) {
        String ld = new File(nativeLib, "libldlinux.so").getPath();
        // bionic 进程：先过 exec-shim-bionic（glibc 程序 / glibc ld.so 改走 APK 里的 ld.so），其余交给 termux-exec 的 linker 版
        String tx = new File(app, "lib/exec-shim-bionic.so").getPath() + ":" + new File(usr, "lib/libtermux-exec-linker-ld-preload.so").getPath();
        e.put("CCAPP_LD", ld);
        e.put("CCAPP_LOADER", ld);
        e.put("CCAPP_GLIBC_PRELOAD", new File(app, "lib/seccomp-enosys.so").getPath() + ":" + new File(app, "lib/exec-shim.so").getPath());
        e.put("CCAPP_BIONIC_PRELOAD", tx);
        e.put("LD_PRELOAD", tx);
        e.put("TERMUX_APP__DATA_DIR", files.getParent());
        e.put("TERMUX_APP__LEGACY_DATA_DIR", "/data/data/" + pkg);
        e.put("TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE", "force");
        e.put("NODE_OPTIONS", "--require=" + new File(app, "lib/execpath.cjs").getPath());
    }
}
