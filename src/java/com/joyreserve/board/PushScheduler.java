package com.joyreserve.board;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.util.Calendar;
import java.util.List;

/** 系统闹钟调度：每天 08:00 汇总 + 每段开始前 30 分钟签到提醒。 */
public class PushScheduler {

    static final String ACTION_DAILY = "com.joyreserve.board.PUSH_DAILY";
    static final String ACTION_SIGN = "com.joyreserve.board.PUSH_SIGN";
    private static final int REQ_DAILY = 9001;
    private static final int SIGN_BASE = 2000;

    static void bootstrap(Context c) {
        Notify.ensureChannels(c);
        scheduleDaily(c);
        scheduleSignIns(c, PushStore.ordersJson(c));
    }

    static void scheduleDaily(Context c) {
        scheduleDaily(c, 0);
    }

    /** 当天推送已完成后，直接排到明天 08:00，避免不精确闹钟提前触发又排一次今天。 */
    static void scheduleDailyNext(Context c) {
        scheduleDaily(c, 1);
    }

    private static void scheduleDaily(Context c, int dayOffset) {
        Calendar cal = Calendar.getInstance();
        cal.add(Calendar.DAY_OF_YEAR, dayOffset);
        cal.set(Calendar.HOUR_OF_DAY, 8);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long at = cal.getTimeInMillis();
        if (dayOffset == 0 && at <= System.currentTimeMillis()) at += 24L * 3600L * 1000L;
        Intent it = new Intent(c, PushReceiver.class).setAction(ACTION_DAILY);
        PendingIntent pi = PendingIntent.getBroadcast(c, REQ_DAILY, it,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        setAlarm(c, at, pi);
    }

    static void cancelSignIns(Context c) {
        int[] codes = PushStore.codes(c);
        for (int code : codes) {
            if (code < 0) continue;
            Intent it = new Intent(c, PushReceiver.class).setAction(ACTION_SIGN);
            PendingIntent pi = PendingIntent.getBroadcast(c, code, it,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.cancel(pi);
            pi.cancel();
        }
        PushStore.saveCodes(c, "");
        PushStore.sp(c).edit().putInt("sign_count", 0).apply();
    }

    /** 依据当前订单重排签到提醒；关掉开关则全部撤销。 */
    static int scheduleSignIns(Context c, String ordersJson) {
        cancelSignIns(c);
        if (!PushStore.signOn(c)) return 0;
        List<PushStore.Booking> list = PushStore.blocks(ordersJson);
        long now = System.currentTimeMillis();
        StringBuilder codes = new StringBuilder();
        int seq = 0;
        for (PushStore.Booking b : list) {
            long at = b.start - 30L * 60L * 1000L;
            if (at <= now + 60000L) continue;
            int code = SIGN_BASE + seq++;
            Intent it = new Intent(c, PushReceiver.class).setAction(ACTION_SIGN)
                    .putExtra("name", b.name)
                    .putExtra("lesson", b.lesson)
                    .putExtra("nid", code);
            PendingIntent pi = PendingIntent.getBroadcast(c, code, it,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            setAlarm(c, at, pi);
            if (codes.length() > 0) codes.append(',');
            codes.append(code);
        }
        PushStore.saveCodes(c, codes.toString());
        PushStore.sp(c).edit().putInt("sign_count", seq).apply();
        return seq;
    }

    private static void setAlarm(Context c, long at, PendingIntent pi) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else if (Build.VERSION.SDK_INT >= 23) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (Throwable t) {
            try {
                am.set(AlarmManager.RTC_WAKEUP, at, pi);
            } catch (Throwable ignored) {
            }
        }
    }

    static boolean exactAllowed(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return false;
        if (Build.VERSION.SDK_INT >= 31) return am.canScheduleExactAlarms();
        return true;
    }
}
