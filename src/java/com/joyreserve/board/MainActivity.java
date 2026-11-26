package com.joyreserve.board;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * 单 Activity + WebView 容器。
 * 所有业务逻辑在 assets/app.js，网络在 JsBridge（HttpURLConnection 串行）。
 *
 * 注意：系统栏外观必须在 setContentView 之后再设置。Android 14 的
 * PhoneWindow.getInsetsController() 在 DecorView 尚未创建时会空指针崩溃。
 */
public class MainActivity extends Activity {

    private static final String TAG = "JRBoard";
    private WebView web;
    private FrameLayout root;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        root.setFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                int top, bottom, left, right;
                if (Build.VERSION.SDK_INT >= 30) {
                    Insets bars = insets.getInsets(
                            WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    Insets ime = insets.getInsets(WindowInsets.Type.ime());
                    top = bars.top;
                    // 键盘弹出时把底部让出来，避免「备注」输入框被输入法遮住
                    bottom = Math.max(bars.bottom, ime.bottom);
                    left = bars.left;
                    right = bars.right;
                } else {
                    //noinspection deprecation
                    top = insets.getSystemWindowInsetTop();
                    //noinspection deprecation
                    bottom = insets.getSystemWindowInsetBottom();
                    //noinspection deprecation
                    left = insets.getSystemWindowInsetLeft();
                    //noinspection deprecation
                    right = insets.getSystemWindowInsetRight();
                }
                v.setPadding(left, top, right, bottom);
                return insets;
            }
        });

        rebuildWebView();

        // 必须先有 DecorView，再碰 WindowInsetsController
        setContentView(root);
        applySystemBars();

        // 每天 08:00 汇总 + 开始前 30 分钟签到提醒
        try {
            PushScheduler.bootstrap(this);
        } catch (Throwable t) {
            Log.w(TAG, "push bootstrap: " + t);
        }
        requestNotifPermission();
    }

    private void maybePromptExactAlarm() {
        if (Build.VERSION.SDK_INT < 31 || isFinishing()) return;
        try {
            if (!Notify.enabled(this)) return; // 先把通知权限处理完
            android.app.AlarmManager am = (android.app.AlarmManager)
                    getSystemService(ALARM_SERVICE);
            if (am == null || am.canScheduleExactAlarms()) return;
            if (PushStore.sp(this).getBoolean("exact_prompted", false)) return;
            PushStore.sp(this).edit().putBoolean("exact_prompted", true).apply();
            new AlertDialog.Builder(this)
                    .setTitle("让提醒准点")
                    .setMessage("允许「闹钟与提醒」后，早上 8:00 的设备推送、开始前 30 分钟的签到提醒才能准点。\n不授权也能用，但可能延迟（最长约 1 小时）。")
                    .setPositiveButton("去设置", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int w) {
                            openExactAlarmSettings();
                        }
                    })
                    .setNegativeButton("暂不", null)
                    .show();
        } catch (Throwable t) {
            Log.w(TAG, "exact prompt: " + t);
        }
    }

    public void openExactAlarmSettings() {
        if (Build.VERSION.SDK_INT < 31) return;
        try {
            Intent it = new Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
            it.setData(android.net.Uri.parse("package:" + getPackageName()));
            startActivity(it);
        } catch (Throwable t) {
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS));
            } catch (Throwable ignored) {
            }
        }
    }

    public void requestNotifPermission() {
        try {
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 501);
            }
        } catch (Throwable t) {
            Log.w(TAG, "request notif: " + t);
        }
    }

    private void applySystemBars() {
        Window w = getWindow();
        try {
            w.setStatusBarColor(Color.WHITE);
            w.setNavigationBarColor(Color.WHITE);
        } catch (Throwable ignore) {
        }
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController c = w.getInsetsController();
                if (c == null) {
                    c = w.getDecorView().getWindowInsetsController();
                }
                if (c != null) {
                    int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                    c.setSystemBarsAppearance(light, light);
                }
            } else {
                //noinspection deprecation
                w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            }
        } catch (Throwable t) {
            Log.w(TAG, "apply system bars failed: " + t);
        }
    }

    private void rebuildWebView() {
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        setupWebView();
    }

    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadsImagesAutomatically(true);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // Android 16 默认算法变暗可能打乱语义色块
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                s.setAlgorithmicDarkeningAllowed(false);
            } else if (Build.VERSION.SDK_INT >= 29) {
                //noinspection deprecation
                s.setForceDark(WebSettings.FORCE_DARK_OFF);
            }
        } catch (Throwable ignore) {
        }

        web.addJavascriptInterface(new JsBridge(this, web), "JRBridge");

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.d(TAG, cm.message() + " @" + cm.lineNumber());
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // 只允许本地 assets 页面，外部链接一律拦截（避免误跳微信/浏览器）
                return !url.startsWith("file:///android_asset/");
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                String url = request.getUrl() == null ? "" : request.getUrl().toString();
                return !url.startsWith("file:///android_asset/");
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                try {
                    if (view != null) {
                        if (view.getParent() == root) root.removeView(view);
                        view.destroy();
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "render gone cleanup: " + t);
                }
                web = null;
                rebuildWebView();
                return true;
            }
        });

        web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onResume() {
        super.onResume();
        try {
            // 用户可能在系统里刚授权精确闹钟，回前台时把 8:00 与签到提醒按精确模式重挂一遍
            PushScheduler.scheduleDaily(this);
            if (PushStore.signOn(this)) {
                PushScheduler.scheduleSignIns(this, PushStore.ordersJson(this));
            }
        } catch (Throwable t) {
            Log.w(TAG, "resume schedule: " + t);
        }
        maybePromptExactAlarm();
        if (web != null) {
            web.onResume();
            // MagicOS 后台冻结后回来：让 H5 检查会话并按需刷新
            try {
                web.evaluateJavascript(
                        "window.JRApp && window.JRApp.onResume && window.JRApp.onResume();", null);
            } catch (Throwable ignore) {
            }
        }
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return window.JRApp && window.JRApp.onBack && window.JRApp.onBack() ? '1':'0';}catch(e){return '0';}})()",
                value -> {
                    boolean handled = value != null
                            && (value.startsWith("true") || value.startsWith("\"1\""));
                    if (!handled) {
                        finish();
                    }
                });
    }
}
