package com.joyreserve.board;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 闹钟落地：8:00 汇总当天设备；开始前 30 分钟提醒签到。 */
public class PushReceiver extends BroadcastReceiver {

    private static final String TAG = "JRBoard";

    @Override
    public void onReceive(final Context ctx, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        if (PushScheduler.ACTION_SIGN.equals(action)) {
            if (!PushStore.signOn(ctx)) return;
            String name = intent.getStringExtra("name");
            String lesson = intent.getStringExtra("lesson");
            int id = intent.getIntExtra("nid", 8801);
            Notify.sign(ctx, name == null ? "设备" : name, lesson == null ? "" : lesson, id);
            return;
        }
        if (!PushScheduler.ACTION_DAILY.equals(action)) return;

        final PendingResult pr = goAsync();
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    String json = null;
                    try {
                        PlatformApi api = new PlatformApi(ctx);
                        JSONArray data = api.fetchOrders();
                        json = data.toString();
                        PushStore.saveOrders(ctx, json);
                    } catch (Throwable t) {
                        Log.w(TAG, "daily fetch failed: " + t);
                        json = PushStore.ordersJson(ctx);
                    }
                    if (json != null) PushScheduler.scheduleSignIns(ctx, json);
                    summarizeToday(ctx, json);
                } catch (Throwable t) {
                    Log.w(TAG, "daily push: " + t);
                } finally {
                    PushScheduler.scheduleDailyNext(ctx);
                    try {
                        pr.finish();
                    } catch (Throwable ignored) {
                    }
                }
            }
        }).start();
    }

    private void summarizeToday(Context ctx, String json) {
        List<PushStore.Booking> all = PushStore.blocks(json);
        long now = System.currentTimeMillis();
        Map<String, List<PushStore.Booking>> byOrder = new LinkedHashMap<String, List<PushStore.Booking>>();
        for (PushStore.Booking b : all) {
            if (!PushStore.isToday(b.start)) continue;
            if (b.end <= now) continue; // 已经结束的不推
            String key = b.orderId + "|" + b.name;
            List<PushStore.Booking> l = byOrder.get(key);
            if (l == null) {
                l = new ArrayList<PushStore.Booking>();
                byOrder.put(key, l);
            }
            l.add(b);
        }
        if (byOrder.isEmpty()) return;
        StringBuilder sb = new StringBuilder();
        int i = 0;
        for (Map.Entry<String, List<PushStore.Booking>> e : byOrder.entrySet()) {
            if (i >= 6) {
                sb.append("等 ").append(byOrder.size()).append(" 台");
                break;
            }
            List<PushStore.Booking> l = e.getValue();
            String name = l.get(0).name;
            StringBuilder times = new StringBuilder();
            for (PushStore.Booking b : l) {
                if (times.length() > 0) times.append("、");
                times.append(b.lesson);
            }
            sb.append(i > 0 ? "\n" : "")
                    .append(name).append(" · ").append(times);
            i++;
        }
        String title = "今天 " + byOrder.size() + " 台设备要开始";
        Notify.daily(ctx, title, sb.toString());
    }
}
