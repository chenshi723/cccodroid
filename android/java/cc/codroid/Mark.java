package cc.codroid;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

/**
 * cccodroid 的标识：三道套在一起的 c（c-c-c）和圆心一个点（o），跟首屏欢迎语旁那个同形。
 *
 * 外圈只画 218°、落笔停在正下方，比里面两道短一截 —— 定稿的示意页就是这样，这点不对称是要保留的（网页 04-session-flow.js 的 WL_MARK 同形）。
 * 启动时的动画（照示意页）：三道弧从外往里依次写出来，最后圆心的点淡入；之后一直等着的话，一道亮光从里往外一圈圈扫过去（像信号往外发）。
 * finish() 让三道弧回到全亮、整个标识收一点再淡出，结束后回调 —— 交给网页之前用。
 * 全部在 onDraw 里按时间算，不用 Animator，postInvalidateOnAnimation 驱动；看不见（GONE、窗口在后台）时系统不会调 onDraw，也就不耗电。
 */
final class Mark extends View {
    // 48 单位见方的设计稿：弧心 (24,24)，半径 21 / 13 / 5，都从右上 45° 起笔逆时针写；线宽 2.6
    private static final float[] R = { 21, 13, 5 };              // 从外到里（写的顺序）
    private static final float[] SWEEP = { 218.27f, 270, 270 };  // 外圈短一截
    private final Paint arc = new Paint(Paint.ANTI_ALIAS_FLAG), dot = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF box = new RectF();
    private final int fg;
    private long t0 = -1, fin = -1;
    private Runnable onDone;
    private boolean loop = true;

    Mark(Context c, int fg, int dotColor) {
        super(c);
        this.fg = fg;
        arc.setStyle(Paint.Style.STROKE);
        arc.setStrokeCap(Paint.Cap.ROUND);
        dot.setColor(dotColor);
    }

    /** 当前外观下圆心点的颜色：逐月外观是黑白，点用它那抹蓝；其余外观用主色 */
    static int dotColor(Context c, boolean night) {
        String skin = c.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("skin", "native");
        if ("zhuyue".equals(skin)) return Color.parseColor(night ? "#3a8ef6" : "#2b80f7");
        return BrowserPane.pal(c, night, "accent");
    }

    /** 只画一遍进场就停（不循环扫光） */
    Mark once() { loop = false; return this; }

    /** 收尾：弧回到全亮，收缩淡出，完了调 done（主线程） */
    void finish(Runnable done) {
        if (fin >= 0) return;
        onDone = done;
        fin = now();
        postInvalidateOnAnimation();
    }

    private static long now() { return android.os.SystemClock.uptimeMillis(); }
    private static float clamp(float x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
    private static float ease(float x) { x = clamp(x); float y = 1 - x; return 1 - y * y * y; }

    @Override protected void onDraw(Canvas c) {
        long n = now();
        if (t0 < 0) t0 = n;
        float t = n - t0;
        float s = Math.min(getWidth(), getHeight()) / 48f;
        float cx = getWidth() / 2f, cy = getHeight() / 2f;
        float out = fin < 0 ? 0 : clamp((n - fin) / 260f);
        c.save();
        float sc = 1 - 0.12f * ease(out);
        c.scale(sc, sc, cx, cy);
        int alphaAll = (int) (255 * (1 - out));
        arc.setStrokeWidth(2.6f * s);

        // 圆心的点：三道弧快写完时（550ms 起）用 300ms 淡入
        float d = fin >= 0 ? 1 : ease((t - 550) / 300f);
        if (d > 0) {
            dot.setAlpha((int) (alphaAll * d));
            c.drawCircle(cx, cy, 2.4f * s, dot);
        }

        for (int i = 0; i < 3; i++) {
            // 写出来：从右上角起笔逆时针绕（像手写一个 c）；外圈先写，每道 900ms，错开 120ms。k = 0 时不画（圆头线帽会留下一个点）
            float k = ease((t - i * 120) / 900f);
            if (fin >= 0) k = Math.max(k, ease((n - fin) / 120f));
            if (k <= 0) continue;
            // 扫光：进场写完以后，一道亮光每 1.5 秒从里往外扫一遍；收尾时回到全亮
            float glow = 1;
            if (loop && fin < 0 && t > 1400) {
                float p = ((t - 1400) % 1500) / 1500f - (2 - i) * 0.16f;     // 从里往外扫：里圈（i = 2）先亮
                float b = p < 0 || p > 0.45f ? 0 : (float) Math.sin(p / 0.45f * Math.PI);
                glow = 0.38f + 0.62f * b;
            } else if (loop && fin < 0 && t > 1100) glow = 1 - 0.62f * clamp((t - 1100) / 300f);
            arc.setColor(fg);
            arc.setAlpha((int) (alphaAll * glow));
            float r = R[i] * s;
            box.set(cx - r, cy - r, cx + r, cy + r);
            c.drawArc(box, -45, -SWEEP[i] * k, false, arc);
        }
        c.restore();

        if (fin >= 0 && out >= 1) {
            Runnable r = onDone; onDone = null;
            if (r != null) r.run();
            return;
        }
        if (loop || fin >= 0 || t < 1200) postInvalidateOnAnimation();
    }
}
