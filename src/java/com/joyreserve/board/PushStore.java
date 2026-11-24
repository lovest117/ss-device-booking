package com.joyreserve.board;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/** 推送用的本地存储与订单解析。 */
public class PushStore {

    static final String PREF = "jr_push";
    static final String K_ORDERS = "orders_json";
    static final String K_SIGN = "sign_on";
    static final String K_CODES = "sign_codes";
    static final String K_LAST = "last_sync";

    public static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    public static boolean signOn(Context c) {
        return sp(c).getBoolean(K_SIGN, true);
    }

    public static void setSignOn(Context c, boolean on) {
        sp(c).edit().putBoolean(K_SIGN, on).apply();
    }

    public static String ordersJson(Context c) {
        return sp(c).getString(K_ORDERS, "[]");
    }

    public static void saveOrders(Context c, String raw) {
        if (raw == null || raw.isEmpty()) return;
        sp(c).edit().putString(K_ORDERS, raw)
                .putLong(K_LAST, System.currentTimeMillis()).apply();
    }

    public static long lastSync(Context c) {
        return sp(c).getLong(K_LAST, 0);
    }

    public static void saveCodes(Context c, String csv) {
        sp(c).edit().putString(K_CODES, csv).apply();
    }

    public static int[] codes(Context c) {
        String s = sp(c).getString(K_CODES, "");
        if (s == null || s.isEmpty()) return new int[0];
        String[] parts = s.split(",");
        int[] out = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            try {
                out[i] = Integer.parseInt(parts[i].trim());
            } catch (Throwable ignore) {
                out[i] = -1;
            }
        }
        return out;
    }

    /** 一条实际占用记录（一台设备的一个时段）。 */
    public static class Booking {
        public String orderId = "";
        public String name = "";
        public String date = "";
        public String lesson = "";
        public long start = 0;
        public long end = 0;
    }

    private static final TimeZone TZ = TimeZone.getTimeZone("Asia/Shanghai");

    public static List<Booking> bookings(String ordersJson) {
        List<Booking> out = new ArrayList<Booking>();
        try {
            JSONArray arr = new JSONArray(ordersJson == null || ordersJson.isEmpty() ? "[]" : ordersJson);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                // 只保留有效单；取消/结束的不排提醒
                String state = o.optString("state", "0");
                if (!"0".equals(state)) continue;
                String id = o.optString("id", "");
                String name = o.optString("classroom_name", "");
                JSONArray rt = o.optJSONArray("reserve_times");
                if (rt == null) continue;
                for (int k = 0; k < rt.length(); k++) {
                    JSONObject r = rt.optJSONObject(k);
                    if (r == null) continue;
                    JSONObject t = r.optJSONObject("time");
                    if (t == null) continue;
                    String date = t.optString("date", "");
                    String lesson = t.optString("lesson", "");
                    long start = t.optLong("start_timestamp", 0);
                    if (start > 0) {
                        if (start < 100000000000L) start *= 1000L; // 秒转毫秒
                    } else {
                        start = parseStart(date, lesson);
                    }
                    if (start <= 0) continue;
                    long end = parseEnd(date, lesson, start);
                    Booking b = new Booking();
                    b.orderId = id;
                    b.name = name;
                    b.date = date;
                    b.lesson = lesson;
                    b.start = start;
                    b.end = end > start ? end : start + 3600000L;
                    out.add(b);
                }
            }
        } catch (Throwable ignored) {
        }
        return out;
    }

    /**
     * 把同一订单、同一设备、首尾相接的连续时段合并成「一段」。
     * 例：09:00-10:00 + 10:00-11:00 + 11:00-12:00 + 12:00-13:00 → 09:00-13:00。
     * 签到提醒按这个块只发一次，不会每小时响一次。
     */
    public static List<Booking> blocks(String ordersJson) {
        List<Booking> flat = bookings(ordersJson);
        List<Booking> sorted = new ArrayList<Booking>(flat);
        Collections.sort(sorted, new Comparator<Booking>() {
            @Override
            public int compare(Booking a, Booking b) {
                if (a.start < b.start) return -1;
                if (a.start > b.start) return 1;
                return 0;
            }
        });
        List<Booking> out = new ArrayList<Booking>();
        Booking cur = null;
        for (Booking b : sorted) {
            if (cur != null && cur.orderId.equals(b.orderId) && cur.name.equals(b.name)
                    && b.start <= cur.end + 5L * 60L * 1000L) {
                if (b.end > cur.end) cur.end = b.end;
                continue;
            }
            Booking c = new Booking();
            c.orderId = b.orderId;
            c.name = b.name;
            c.date = b.date;
            c.start = b.start;
            c.end = b.end;
            out.add(c);
            cur = c;
        }
        for (Booking c : out) {
            c.lesson = hhmm(c.start) + "-" + hhmm(c.end);
        }
        return out;
    }

    private static long parseStart(String date, String lesson) {
        try {
            String[] p = lesson.split("-");
            String hm = p[0].trim();
            if (hm.length() == 4) hm = "0" + hm;
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA);
            f.setTimeZone(TZ);
            Date d = f.parse(date + " " + hm);
            return d == null ? 0 : d.getTime();
        } catch (Throwable t) {
            return 0;
        }
    }

    private static long parseEnd(String date, String lesson, long start) {
        try {
            String[] p = lesson.split("-");
            String hm = p[1].trim();
            if (hm.length() == 4) hm = "0" + hm;
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA);
            f.setTimeZone(TZ);
            Date d = f.parse(date + " " + hm);
            long end = d == null ? 0 : d.getTime();
            if (end <= start) end += 24 * 3600000L;
            return end;
        } catch (Throwable t) {
            return start + 3600000L;
        }
    }

    public static boolean isToday(long ts) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd", Locale.CHINA);
        f.setTimeZone(TZ);
        return f.format(new Date(ts)).equals(f.format(new Date()));
    }

    public static String hhmm(long ts) {
        SimpleDateFormat f = new SimpleDateFormat("HH:mm", Locale.CHINA);
        f.setTimeZone(TZ);
        return f.format(new Date(ts));
    }
}
