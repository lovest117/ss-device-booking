package com.joyreserve.board;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 重启后把 8:00 汇总与签到提醒重新挂上。 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            PushScheduler.bootstrap(context);
        } catch (Throwable ignored) {
        }
    }
}
