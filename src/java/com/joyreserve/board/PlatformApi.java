package com.joyreserve.board;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 后台推送专用的最小平台客户端：
 * GET/POST + Cookie，复用 JsBridge 写在同一份 SharedPreferences 里的会话。
 * 只做两件事：取我的订单、必要时静默重登。
 */
public class PlatformApi {

    private static final String TAG = "JRBoard";
    private static final String BASE = "http://www.joyreserve.com";
    private static final String HOST = "joyreserve.com";
    private static final String UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) "
            + "AppleWebKit/605.1.15 (KHTML, like Gecko) MicroMessenger/8.0.49";
    private static final String MY_REFERER = BASE + "/index.php/Wechat/Home/my_register";

    private final Context ctx;
    private final SharedPreferences sp;

    public PlatformApi(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.sp = this.ctx.getSharedPreferences("jr_cookies", Context.MODE_PRIVATE);
    }

    /** 取最近订单（原始 data 数组）；会话失效会自动重登一次。 */
    public JSONArray fetchOrders() throws Exception {
        String body = postForm("/index.php/Wechat/Home/my_register_more", "page=1", MY_REFERER, null);
        JSONArray data = parseOrders(body);
        if (data != null) return data;
        login();
        body = postForm("/index.php/Wechat/Home/my_register_more", "page=1", MY_REFERER, null);
        data = parseOrders(body);
        if (data == null) throw new Exception("订单解析失败");
        return data;
    }

    private JSONArray parseOrders(String body) {
        try {
            JSONObject o = new JSONObject(body);
            if (o.has("data")) {
                Object d = o.opt("data");
                if (d instanceof JSONArray) return (JSONArray) d;
            }
        } catch (Throwable ignore) {
        }
        try {
            return new JSONArray(body);
        } catch (Throwable ignore) {
            return null;
        }
    }

    public void login() throws Exception {
        String cfg = readAsset("config.js");
        String phone = pick(cfg, "phone");
        String password = pick(cfg, "password");
        if (phone.isEmpty() || password.isEmpty()) throw new Exception("缺少账号配置");
        JSONObject payload = new JSONObject();
        payload.put("phone", phone);
        payload.put("number", JSONObject.NULL);
        payload.put("password", password);
        payload.put("code", JSONObject.NULL);
        String body = postForm("/index.php/Wechat/User/login_in", payload.toString(), null,
                "XMLHttpRequest");
        try {
            JSONObject r = new JSONObject(body);
            if (r.optInt("code", 0) != 200) throw new Exception("登录失败");
        } catch (org.json.JSONException e) {
            throw new Exception("登录返回异常");
        }
    }

    private String readAsset(String name) {
        try {
            InputStream in = ctx.getAssets().open(name);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            return bo.toString("UTF-8");
        } catch (Throwable t) {
            return "";
        }
    }

    private static String pick(String cfg, String key) {
        Matcher m = Pattern.compile(key + "\\s*:\\s*\"([^\"]*)\"").matcher(cfg == null ? "" : cfg);
        return m.find() ? m.group(1) : "";
    }

    private String postForm(String path, String body, String referer, String xrw) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BASE + path).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(8000);
        c.setReadTimeout(10000);
        c.setUseCaches(false);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
        String cookie = cookieHeader();
        if (cookie != null) c.setRequestProperty("Cookie", cookie);
        if (referer != null) c.setRequestProperty("Referer", referer);
        if (xrw != null) c.setRequestProperty("X-Requested-With", xrw);
        byte[] bytes = body.getBytes("UTF-8");
        c.setFixedLengthStreamingMode(bytes.length);
        OutputStream os = c.getOutputStream();
        os.write(bytes);
        os.flush();
        os.close();
        int code = c.getResponseCode();
        captureCookies(c);
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = readAll(in);
        c.disconnect();
        return text;
    }

    private static String readAll(InputStream in) {
        if (in == null) return "";
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            return bo.toString("UTF-8");
        } catch (Throwable t) {
            return "";
        }
    }

    private String cookieHeader() {
        String s = sp.getString("h_" + HOST, "");
        return s == null || s.isEmpty() ? null : s;
    }

    private void captureCookies(HttpURLConnection c) {
        try {
            Map<String, List<String>> fields = c.getHeaderFields();
            if (fields == null) return;
            Map<String, String> jar = loadJar();
            for (Map.Entry<String, List<String>> e : fields.entrySet()) {
                String key = e.getKey();
                if (key == null || !"set-cookie".equalsIgnoreCase(key)) continue;
                for (String raw : e.getValue()) applySetCookie(jar, raw);
            }
            StringBuilder sb = new StringBuilder();
            for (Map.Entry<String, String> e : jar.entrySet()) {
                if (sb.length() > 0) sb.append("; ");
                sb.append(e.getKey()).append('=').append(e.getValue());
            }
            sp.edit().putString("h_" + HOST, sb.toString()).commit();
        } catch (Throwable t) {
            Log.w(TAG, "cookie capture: " + t);
        }
    }

    private Map<String, String> loadJar() {
        Map<String, String> m = new HashMap<String, String>();
        String s = sp.getString("h_" + HOST, "");
        if (s != null && !s.isEmpty()) {
            for (String kv : s.split("; ")) {
                int eq = kv.indexOf('=');
                if (eq > 0) m.put(kv.substring(0, eq), kv.substring(eq + 1));
            }
        }
        return m;
    }

    private static void applySetCookie(Map<String, String> jar, String raw) {
        if (raw == null || raw.isEmpty()) return;
        String head = raw.split(";", 2)[0];
        int eq = head.indexOf('=');
        if (eq <= 0) return;
        String name = head.substring(0, eq).trim();
        String value = head.substring(eq + 1).trim();
        String low = raw.toLowerCase();
        boolean expired = low.contains("max-age=0") || low.contains("max-age=-")
                || (low.contains("expires=") && low.contains("1970"))
                || (low.contains("expires=") && low.contains("1969"));
        if (expired || value.isEmpty()) jar.remove(name);
        else jar.put(name, value);
    }
}
