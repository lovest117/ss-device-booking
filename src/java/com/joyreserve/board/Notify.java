package com.joyreserve.board;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** 通知渠道与两类提醒。 */
public class Notify {

    static final String CH_DAILY = "jr_daily";
    static final String CH_SIGN = "jr_sign";

    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel daily = new NotificationChannel(CH_DAILY, "今日设备提醒",
                NotificationManager.IMPORTANCE_DEFAULT);
        daily.setDescription("每天早上 8:00 汇总当天开始的设备");
        nm.createNotificationChannel(daily);
        NotificationChannel sign = new NotificationChannel(CH_SIGN, "签到提醒",
                NotificationManager.IMPORTANCE_HIGH);
        sign.setDescription("设备开始前 30 分钟提醒签到");
        nm.createNotificationChannel(sign);
    }

    static boolean enabled(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;
        if (Build.VERSION.SDK_INT >= 24) return nm.areNotificationsEnabled();
        return true;
    }

    private static PendingIntent openApp(Context c) {
        Intent it = new Intent(c, MainActivity.class);
        it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, 100, it,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void daily(Context c, String title, String text) {
        try {
            ensureChannels(c);
            if (!enabled(c)) return;
            Notification.Builder b = builder(c, CH_DAILY);
            b.setSmallIcon(R.drawable.ic_stat_notify)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setAutoCancel(true)
                    .setContentIntent(openApp(c));
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(8001, b.build());
        } catch (Throwable ignored) {
        }
    }

    static void sign(Context c, String name, String lesson, int id) {
        try {
            ensureChannels(c);
            if (!enabled(c)) return;
            Notification.Builder b = builder(c, CH_SIGN);
            b.setSmallIcon(R.drawable.ic_stat_notify)
                    .setContentTitle("30 分钟后开始：" + name)
                    .setContentText(lesson + " · 记得签到")
                    .setStyle(new Notification.BigTextStyle()
                            .bigText(lesson + " 开始使用「" + name + "」，记得在平台签到。"))
                    .setAutoCancel(true)
                    .setContentIntent(openApp(c));
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(id, b.build());
        } catch (Throwable ignored) {
        }
    }

    private static Notification.Builder builder(Context c, String channel) {
        if (Build.VERSION.SDK_INT >= 26) return new Notification.Builder(c, channel);
        return new Notification.Builder(c);
    }
}
