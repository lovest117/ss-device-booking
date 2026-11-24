package com.joyreserve.board;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.os.Build;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JS <-> 原生 通用网络桥。
 * 契约：JRBridge.http(reqJson, callbackId)
 * req  = {method, url, headers, form:[[k,v]...], rawBody, followRedirects, timeoutMs}
 * resp = {code, body, finalUrl, error}
 *
 * 关键能力：自定义 Referer / UA、关闭自动重定向拿到 302、同名多值表单、跨请求 cookie 保持。
 */
public class JsBridge {

    static final String BASE = "http://www.joyreserve.com";
    static final String UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) "
            + "AppleWebKit/605.1.15 (KHTML, like Gecko) MicroMessenger/8.0.49";
    private static final int MAX_BODY = 8 * 1024 * 1024;

    private final Context ctx;
    private final WebView web;
    private final SharedPreferences sp;
    /** 单线程串行：避免并发写 cookie 竞态，也顺手给平台限流 */
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    public JsBridge(Context ctx, WebView web) {
        this.ctx = ctx;
        this.web = web;
        this.sp = ctx.getSharedPreferences("jr_cookies", Context.MODE_PRIVATE);
    }

    // ---------------- JS 入口 ----------------

    @JavascriptInterface
    public void http(final String reqJson, final String callbackId) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                String out;
                try {
                    JSONObject req = new JSONObject(reqJson);
                    out = doRequest(req);
                } catch (Throwable t) {
                    out = errJson(String.valueOf(t));
                }
                final String js = "window.JR && JR.__cb && JR.__cb(" + JSONObject.quote(callbackId)
                        + ",JSON.parse(" + JSONObject.quote(out) + "));";
                web.post(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            web.evaluateJavascript(js, null);
                        } catch (Throwable ignore) {
                        }
                    }
                });
            }
        });
    }

    @JavascriptInterface
    public String info() {
        try {
            JSONObject o = new JSONObject();
            o.put("model", Build.MODEL);
            o.put("brand", Build.BRAND);
            o.put("release", Build.VERSION.RELEASE);
            o.put("sdk", Build.VERSION.SDK_INT);
            String pkg = "", ver = "";
            if (Build.VERSION.SDK_INT >= 26) {
                PackageInfo pi = WebView.getCurrentWebViewPackage();
                if (pi != null) {
                    pkg = pi.packageName;
                    ver = pi.versionName;
                }
            }
            o.put("webview", (pkg + " " + ver).trim());
            int mode = ctx.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            o.put("darkMode", mode == Configuration.UI_MODE_NIGHT_YES);
            o.put("cookies", sp.getAll().size());
            o.put("ts", System.currentTimeMillis());
            return o.toString();
        } catch (Throwable t) {
            return "{}";
        }
    }

    @JavascriptInterface
    public void clearCookies() {
        sp.edit().clear().commit();
    }

    /** 复制到系统剪贴板：file:// 页面里 navigator.clipboard 不可用，走原生最稳。 */
    @JavascriptInterface
    public void copy(final String text) {
        if (text == null) return;
        web.post(new Runnable() {
            @Override
            public void run() {
                try {
                    ClipboardManager cm = (ClipboardManager)
                            ctx.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) {
                        cm.setPrimaryClip(ClipData.newPlainText("设备预约", text));
                    }
                } catch (Throwable t) {
                    Log.w("JRBoard", "copy failed: " + t);
                }
            }
        });
    }

    // ---------------- 推送 ----------------

    /** H5 每次拿到订单后回传，原生据此排「开始前 30 分钟」提醒。 */
    @JavascriptInterface
    public void syncOrders(String raw) {
        if (raw == null || raw.isEmpty()) return;
        try {
            PushStore.saveOrders(ctx, raw);
            PushScheduler.scheduleSignIns(ctx, raw);
        } catch (Throwable t) {
            Log.w("JRBoard", "syncOrders failed: " + t);
        }
    }

    @JavascriptInterface
    public String pushState() {
        try {
            JSONObject o = new JSONObject();
            o.put("signOn", PushStore.signOn(ctx));
            o.put("scheduled", PushStore.sp(ctx).getInt("sign_count", 0));
            o.put("exact", PushScheduler.exactAllowed(ctx));
            o.put("notif", Notify.enabled(ctx));
            o.put("lastSync", PushStore.lastSync(ctx));
            return o.toString();
        } catch (Throwable t) {
            return "{}";
        }
    }

    @JavascriptInterface
    public void setSignReminder(boolean on) {
        try {
            PushStore.setSignOn(ctx, on);
            if (on) {
                PushScheduler.scheduleSignIns(ctx, PushStore.ordersJson(ctx));
            } else {
                PushScheduler.cancelSignIns(ctx);
            }
        } catch (Throwable t) {
            Log.w("JRBoard", "setSignReminder: " + t);
        }
    }

    @JavascriptInterface
    public void exactSettings() {
        if (ctx instanceof MainActivity) {
            ((MainActivity) ctx).openExactAlarmSettings();
        }
    }

    @JavascriptInterface
    public void requestNotif() {
        if (ctx instanceof MainActivity) {
            ((MainActivity) ctx).requestNotifPermission();
        }
    }

    // ---------------- HTTP 实现 ----------------

    private String doRequest(JSONObject req) {
        long t0 = System.currentTimeMillis();
        try {
            String method = req.optString("method", "GET").toUpperCase();
            String urlStr = req.optString("url", "");
            if (!urlStr.startsWith("http")) {
                urlStr = BASE + (urlStr.startsWith("/") ? "" : "/") + urlStr;
            }
            boolean follow = req.optBoolean("followRedirects", true);
            int timeout = req.optInt("timeoutMs", 15000);
            JSONObject headers = req.optJSONObject("headers");
            JSONArray form = req.optJSONArray("form");
            String rawBody = req.has("rawBody") && !req.isNull("rawBody")
                    ? req.optString("rawBody", null) : null;

            String body = null;
            if (form != null) {
                body = encodeForm(form);
            } else if (rawBody != null) {
                body = rawBody;
            }

            String finalUrl = urlStr;
            int code = 0;
            String respBody = "";
            int maxHop = follow ? 5 : 0;

            for (int hop = 0; hop <= maxHop; hop++) {
                URL u = new URL(finalUrl);
                HttpURLConnection c = (HttpURLConnection) u.openConnection();
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(timeout);
                c.setReadTimeout(timeout);
                c.setUseCaches(false);
                c.setRequestMethod(method);
                c.setRequestProperty("User-Agent", UA);
                c.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");

                String cookie = cookieHeader(u.getHost());
                if (cookie != null) {
                    c.setRequestProperty("Cookie", cookie);
                }
                boolean hasContentType = false;
                if (headers != null) {
                    Iterator<String> it = headers.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        String v = headers.optString(k, "");
                        if ("Content-Type".equalsIgnoreCase(k)) {
                            hasContentType = true;
                        }
                        c.setRequestProperty(k, v);
                    }
                }

                if (body != null) {
                    c.setDoOutput(true);
                    if (!hasContentType) {
                        c.setRequestProperty("Content-Type",
                                "application/x-www-form-urlencoded; charset=UTF-8");
                    }
                    byte[] bytes = body.getBytes("UTF-8");
                    c.setFixedLengthStreamingMode(bytes.length);
                    OutputStream os = c.getOutputStream();
                    os.write(bytes);
                    os.flush();
                    os.close();
                }

                int rc = c.getResponseCode();
                code = rc;
                captureCookies(c);

                String loc = c.getHeaderField("Location");
                respBody = readBody(c, rc, req.optString("encoding", "UTF-8"));

                if (follow && rc >= 300 && rc < 400 && loc != null && !loc.isEmpty()) {
                    URL next = new URL(u, loc);
                    finalUrl = next.toString();
                    // 302/303 按浏览器语义转 GET；307/308 保留方法与 body
                    if (rc != 307 && rc != 308) {
                        method = "GET";
                        body = null;
                    }
                    continue;
                }
                try {
                    c.disconnect();
                } catch (Throwable ignore) {
                }
                break;
            }

            JSONObject o = new JSONObject();
            o.put("code", code);
            o.put("body", respBody);
            o.put("finalUrl", finalUrl);
            o.put("error", "");
            o.put("ms", System.currentTimeMillis() - t0);
            return o.toString();
        } catch (Throwable t) {
            return errJson(String.valueOf(t));
        }
    }

    private static String errJson(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("code", 0);
            o.put("body", "");
            o.put("finalUrl", "");
            o.put("error", msg == null ? "unknown" : msg);
            return o.toString();
        } catch (Throwable t) {
            return "{\"code\":0,\"body\":\"\",\"error\":\"unknown\"}";
        }
    }

    private static String encodeForm(JSONArray form) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < form.length(); i++) {
            JSONArray pair = form.optJSONArray(i);
            if (pair == null || pair.length() < 2) {
                continue;
            }
            if (sb.length() > 0) {
                sb.append('&');
            }
            sb.append(URLEncoder.encode(String.valueOf(pair.get(0)), "UTF-8"))
                    .append('=')
                    .append(URLEncoder.encode(String.valueOf(pair.get(1)), "UTF-8"));
        }
        return sb.toString();
    }

    private static String readBody(HttpURLConnection c, int code, String enc) {
        InputStream in = null;
        try {
            in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in == null) {
                in = c.getErrorStream();
            }
            if (in == null) {
                return "";
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            int total = 0;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                total += n;
                if (total > MAX_BODY) {
                    break;
                }
            }
            return bos.toString(enc);
        } catch (Throwable t) {
            return "";
        } finally {
            try {
                if (in != null) {
                    in.close();
                }
            } catch (Throwable ignore) {
            }
        }
    }

    // ---------------- Cookie ----------------

    private static String cookieHost(String host) {
        if (host == null) {
            return "";
        }
        return host.startsWith("www.") ? host.substring(4) : host;
    }

    private String cookieHeader(String host) {
        String s = sp.getString("h_" + cookieHost(host), "");
        return s == null || s.isEmpty() ? null : s;
    }

    private void captureCookies(HttpURLConnection c) {
        try {
            Map<String, List<String>> fields = c.getHeaderFields();
            if (fields == null) {
                return;
            }
            String host = cookieHost(new URL(c.getURL().toString()).getHost());
            Map<String, String> jar = loadJar(host);
            for (Map.Entry<String, List<String>> e : fields.entrySet()) {
                String key = e.getKey();
                if (key == null || !"set-cookie".equalsIgnoreCase(key)) {
                    continue;
                }
                for (String raw : e.getValue()) {
                    applySetCookie(jar, raw);
                }
            }
            saveJar(host, jar);
        } catch (Throwable ignore) {
        }
    }

    private static void applySetCookie(Map<String, String> jar, String raw) {
        if (raw == null || raw.isEmpty()) {
            return;
        }
        String head = raw.split(";", 2)[0];
        int eq = head.indexOf('=');
        if (eq <= 0) {
            return;
        }
        String name = head.substring(0, eq).trim();
        String value = head.substring(eq + 1).trim();
        String lower = raw.toLowerCase();
        boolean expired = lower.contains("max-age=0")
                || lower.contains("max-age=-")
                || (lower.contains("expires=") && lower.contains("1970"))
                || (lower.contains("expires=") && lower.contains("1969"));
        if (expired || value.isEmpty()) {
            jar.remove(name);
        } else {
            jar.put(name, value);
        }
    }

    private Map<String, String> loadJar(String host) {
        Map<String, String> m = new HashMap<String, String>();
        String s = sp.getString("h_" + host, "");
        if (s != null && !s.isEmpty()) {
            for (String kv : s.split("; ")) {
                int eq = kv.indexOf('=');
                if (eq > 0) {
                    m.put(kv.substring(0, eq), kv.substring(eq + 1));
                }
            }
        }
        return m;
    }

    private void saveJar(String host, Map<String, String> jar) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : jar.entrySet()) {
            if (sb.length() > 0) {
                sb.append("; ");
            }
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        sp.edit().putString("h_" + host, sb.toString()).commit();
    }
}
