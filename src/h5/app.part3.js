      } else {
        throw new AppError('预约失败：' + errText(sub.body));
      }
    } catch (e) {
      openErrorSheet(e);
      setDot(S.logged ? 'ok' : 'bad');
    } finally {
      var b = $('doBook');
      if (b) b.disabled = false;
      renderAction();
    }
  }

  async function doCancel(id) {
    try {
      var old = (await getOrders(false)).filter(function (o) { return o.id === id; })[0];
      var r = await raw('GET', '/index.php/Wechat/Home/register_cancel?reservation_id=' + encodeURIComponent(id));
      var txt = stripTags(r.body);
      var ok = (/取消/.test(txt) && /成功|true/i.test(txt)) || /取消成功/.test(txt) ||
        /"code"\s*:\s*200/.test(r.body);
      if (!ok) throw new AppError('取消失败：' + errText(r.body));
      if (old) {
        var rid = DEV[old.name];
        var dates = {};
        (old.raw.reserve_times || []).forEach(function (x) {
          if (x.time && x.time.date) dates[x.time.date] = 1;
        });
        if (rid) {
          Object.keys(dates).forEach(function (d) {
            delete S.cache[rid + '|' + d];
          });
        }
      }
      closeSheet();
      toast('已取消订单 ' + id);
      await getOrders(true);
      renderOrders();
      refreshBoard(false);
    } catch (e) {
      openErrorSheet(e);
    }
  }

  // ---------------------------------------------------------------- 我的预约
  async function renderOrders() {
    $('orders').innerHTML = '<div class="section-note">正在读取订单…</div>';
    var list = await getOrders(true);
    var now = Date.now();
    // 只留未来仍有效的预约：已取消(state!=0)、已过期的都不显示
    var future = list.filter(function (o) {
      return o.state === '0' && orderSpan(o).end > now;
    }).sort(function (a, b) { return orderSpan(a).start - orderSpan(b).start; });
    if (!future.length) {
      $('orders').innerHTML = '<div class="section-note">没有未来的有效预约。已取消、已结束的订单不再显示；平台只返回最近 5 条。</div>';
      return;
    }
    $('orders').innerHTML = future.map(function (o) {
      return '<div class="order">' +
        '<div class="order-head"><div class="n">' + esc(o.name) + '</div>' +
        '<span class="badge ok">有效</span></div>' +
        '<div class="order-line">时段：<b>' + esc(o.times || '—') + '</b></div>' +
        (o.message ? '<div class="order-line">备注：' + esc(o.message) + '</div>' : '') +
        '<div class="order-foot"><span class="oid">订单号 ' + esc(o.id) + '</span>' +
        '<button class="btn danger" data-cancel="' + esc(o.id) + '">取消</button>' +
        '</div></div>';
    }).join('');
  }

  // ---------------------------------------------------------------- 设置
  function renderSettings() {
    $('setPhone').textContent = CFG.phone || '—';
    $('setSession').textContent = S.logged ? '已登录' : '未登录';
    $('setLogin').textContent = lastLoginText;
    $('setModel').textContent = S.info.model ? (S.info.brand + ' ' + S.info.model) : '—';
    $('setOS').textContent = S.info.release ? ('Android ' + S.info.release + '（API ' + S.info.sdk + '）') : '—';
    $('setWV').textContent = S.info.webview || '—';
    $('setDark').textContent = S.info.darkMode == null ? '—' : (S.info.darkMode ? '系统深色（应用固定浅色）' : '浅色');
    $('setSource').textContent = NATIVE ? 'APK 原生桥 · 直连平台' : '浏览器 Mock 数据';
    $('favHint').textContent = S.favorites.length + ' 台';
    renderFavList();
    renderLogs();
    renderPush();
  }

  function renderPush() {
    var sw = $('swSign'), hint = $('pushHint'), note = $('pushNotif');
    if (!sw || !hint) return;
    if (!NATIVE || !window.JRBridge.pushState) {
      hint.textContent = '仅 APK 内生效';
      sw.disabled = true;
      note.textContent = '';
      return;
    }
    var st = {};
    try { st = JSON.parse(window.JRBridge.pushState()); } catch (e) { st = {}; }
    sw.classList.toggle('on', !!st.signOn);
    sw.setAttribute('aria-pressed', st.signOn ? 'true' : 'false');
    if (!st.signOn) hint.textContent = '签到提醒已关闭';
    else hint.textContent = st.scheduled ? ('已排 ' + st.scheduled + ' 条签到提醒') : '暂无待提醒';
    if (!st.notif) {
      note.innerHTML = '通知权限未开启，<a href="#" id="lnkNotif">点此开启</a>';
    } else if (!st.exact) {
      note.innerHTML = '未授权精确闹钟，8:00 推送与签到提醒可能延迟（最长约 1 小时），<a href="#" id="lnkExact">去授权</a>';
    } else {
      note.textContent = '';
    }
  }

  function renderFavList() {
    var names = Object.keys(DEV).sort().sort(function (a, b) {
      var fa = S.favorites.indexOf(a) >= 0 ? 0 : 1;
      var fb = S.favorites.indexOf(b) >= 0 ? 0 : 1;
      return fa - fb;
    });
    $('favList').innerHTML = names.map(function (n) {
      var on = S.favorites.indexOf(n) >= 0;
      return '<div class="favrow"><span>' + esc(n) + '</span>' +
        '<button class="star ' + (on ? 'on' : 'off') + '" data-fav="' + esc(n) + '">' + (on ? '★' : '☆') + '</button></div>';
    }).join('');
  }

  function renderLogs() {
    if (S.tab !== 'set') return;
    var el = $('logs');
    if (!el) return;
    if (!S.logs.length) { el.innerHTML = '<div class="row">暂无请求</div>'; return; }
    el.innerHTML = S.logs.map(function (l) {
      var bad = (!l.code || l.code >= 400) ? ' bad' : '';
      var t = PAD(l.t.getHours()) + ':' + PAD(l.t.getMinutes()) + ':' + PAD(l.t.getSeconds());
      return '<div class="row' + bad + '"><i>' + t + '</i><b>' + l.code + '</b><u>' +
        esc(l.method + ' ' + l.path.split('?')[0].replace('/index.php', '')) + '</u></div>';
    }).join('');
  }

  function diagText() {
    return [
      '设备预约诊断',
      '时间: ' + new Date().toLocaleString(),
      '机型: ' + (S.info.brand || '') + ' ' + (S.info.model || '') + ' / Android ' + (S.info.release || '') + ' (API ' + (S.info.sdk || '') + ')',
      'WebView: ' + (S.info.webview || ''),
      '运行模式: ' + (NATIVE ? 'APK' : '浏览器Mock'),
      '会话: ' + (S.logged ? '已登录' : '未登录') + ' · ' + lastLoginText,
      '最近日志:',
      S.logs.slice(0, 12).map(function (l) {
        return '  ' + l.method + ' ' + l.path.split('?')[0] + ' -> ' + l.code + ' (' + l.ms + 'ms) ' + l.snip.slice(0, 60);
      }).join('\n')
    ].join('\n');
  }

  function copyValue(txt, label) {
    if (!txt || txt === '—') { toast('没有可复制的内容'); return; }
    var ok = false;
    try {
      if (window.JRBridge && window.JRBridge.copy) {
        window.JRBridge.copy(String(txt));
        ok = true;
      }
    } catch (e) { ok = false; }
    if (!ok) {
      try {
        var ta = document.createElement('textarea');
        ta.value = String(txt);
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) { ok = false; }
    }
    toast(ok ? ('已复制' + (label ? label : '') + ' ' + txt) : '复制失败，请长按文字手动选择');
  }

  function copyText(txt) {
    try {
      if (window.JRBridge && window.JRBridge.copy) {
        window.JRBridge.copy(String(txt));
        toast('已复制，可粘贴发回');
        return;
      }
    } catch (e) { /* 走下面的兜底 */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      toast(ok ? '已复制，可粘贴发回' : '复制失败，请截图');
    } catch (e) {
      toast('复制失败：' + String(e));
    }
  }

  // ---------------------------------------------------------------- 事件绑定
  function bind() {
    $('dates').addEventListener('click', function (ev) {
      var chip = ev.target.closest('.date-chip');
      if (!chip) return;
      var d = chip.getAttribute('data-date');
      if (d === S.date) return;
      S.date = d;
      S.sel = [];
      renderDates();
      renderCards();
      refreshBoard(false);
    });

    $('segMode').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      S.mode = b.getAttribute('data-mode');
      Array.prototype.forEach.call($('segMode').children, function (x) {
        x.classList.toggle('on', x === b);
      });
      S.sel = [];
      renderCards();
      refreshBoard(false);
    });

    var searchTimer = null;
    $('search').addEventListener('input', function () {
      clearTimeout(searchTimer);
      var v = this.value;
      searchTimer = setTimeout(function () {
        S.query = v;
        renderCards();
      }, 160);
    });

    $('btnRefresh').addEventListener('click', function () {
      this.classList.add('spin');
      var btn = this;
      refreshBoard(true).then(function () { btn.classList.remove('spin'); });
      setTimeout(function () { btn.classList.remove('spin'); }, 3000);
    });

    $('cards').addEventListener('click', function (ev) {
      var retry = ev.target.closest('[data-retry]');
      if (retry) {
        ev.preventDefault();
        var rid = retry.getAttribute('data-retry');
        var dev = currentDevices().filter(function (x) { return x.id === rid; })[0];
        if (dev) {
          delete S.cache[rid + '|' + S.date];
          renderCards();
          refreshBoard(false);
        }
        return;
      }
      var blk = ev.target.closest('.blk');
      if (!blk) {
        var card = ev.target.closest('[data-load]');
        if (card) {
          var did = card.getAttribute('data-load');
          var dv = currentDevices().filter(function (x) { return x.id === did; })[0];
          if (dv) loadOne(dv);
        }
        return;
      }
      var room = blk.getAttribute('data-room');
      var slotN = parseInt(blk.getAttribute('data-slot'), 10);
      var c = S.cache[room + '|' + S.date];
      if (!c || !c.day) return;
      var slot = c.day.slots.filter(function (s) { return s.slot === slotN; })[0];
      if (!slot) return;
      var dev = currentDevices().filter(function (x) { return x.id === room; })[0] || { name: c.day.room || room, id: room };
      if (slot.occ) openSlotSheet(dev, slot);
      else toggleSel(dev, slot);
    });

    $('btnBook').addEventListener('click', openBookSheet);

    $('tabbar').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      var tab = b.getAttribute('data-tab');
      S.tab = tab;
      Array.prototype.forEach.call($('tabbar').children, function (x) {
        x.classList.toggle('on', x === b);
      });
      $('viewBoard').classList.toggle('hidden', tab !== 'board');
      $('viewMine').classList.toggle('hidden', tab !== 'mine');
      $('viewSet').classList.toggle('hidden', tab !== 'set');
      $('datebar').classList.toggle('hidden', tab !== 'board');
      renderAction();
      if (tab === 'mine') { renderOrders(); }
      if (tab === 'set') { renderSettings(); }
      if (tab === 'board') { renderCards(); refreshBoard(false); }
    });

    $('sheetMask').addEventListener('click', closeSheet);
    $('sheet').addEventListener('click', function (ev) {
      var t = ev.target;
      var cp = t.closest('[data-copy]');
      if (cp) {
        copyValue(cp.getAttribute('data-copy'), cp.getAttribute('data-copy-label'));
        return;
      }
      if (t.closest('[data-close]')) { closeSheet(); return; }
      if (t.id === 'doBook') { doBook(($('bookNote') || {}).value || ''); return; }
      var act = t.closest('[data-act]');
      if (act && act.getAttribute('data-act') === 'relogin') {
        closeSheet();
        refreshBoard(true);
        return;
      }
      var cancel = t.closest('[data-cancel]');
      if (cancel) {
        var id = cancel.getAttribute('data-cancel');
        openSheet('<div class="sheet-title">取消预约</div>' +
          '<div class="sheet-sub">确认取消订单 ' + esc(id) + ' ？取消后时段会重新释放。</div>' +
          '<div class="actions"><button class="btn ghost" data-close>返回</button>' +
          '<button class="btn danger" data-cancel-do="' + esc(id) + '">确认取消</button></div>');
      }
      var cancelDo = t.closest('[data-cancel-do]');
      if (cancelDo) doCancel(cancelDo.getAttribute('data-cancel-do'));
    });

    $('orders').addEventListener('click', function (ev) {
      var c = ev.target.closest('[data-cancel]');
      if (!c) return;
      var id = c.getAttribute('data-cancel');
      openSheet('<div class="sheet-title">取消预约</div>' +
        '<div class="sheet-sub">确认取消订单 ' + esc(id) + ' ？</div>' +
        '<div class="actions"><button class="btn ghost" data-close>返回</button>' +
        '<button class="btn danger" data-cancel-do="' + esc(id) + '">确认取消</button></div>');
    });
    // 订单区的确认按钮复用 sheet 上的处理，不需要额外监听

    $('favList').addEventListener('click', function (ev) {
      var s = ev.target.closest('[data-fav]');
      if (!s) return;
      var n = s.getAttribute('data-fav');
      var i = S.favorites.indexOf(n);
      if (i >= 0) S.favorites.splice(i, 1);
      else S.favorites.push(n);
      saveFavorites();
      renderSettings();
      renderCards();
    });

    $('btnRelogin').addEventListener('click', function () {
      S.logged = false;
      ensureSession(true).then(function () {
        toast('已重新登录');
        renderSettings();
        refreshBoard(true);
      }).catch(function (e) { openErrorSheet(e); });
    });

    $('btnClear').addEventListener('click', function () {
      S.logged = false;
      S.cache = {};
      if (window.JRBridge && window.JRBridge.clearCookies) window.JRBridge.clearCookies();
      try { localStorage.removeItem('jr_fav'); } catch (e) { }
      toast('已清空会话与缓存');
      renderSettings();
      refreshBoard(true);
    });

    $('swSign').addEventListener('click', function () {
      var on = !this.classList.contains('on');
      if (window.JRBridge && window.JRBridge.setSignReminder) {
        window.JRBridge.setSignReminder(on);
      }
      renderPush();
    });

    $('viewSet').addEventListener('click', function (ev) {
      if (ev.target && ev.target.id === 'lnkExact') {
        ev.preventDefault();
        if (window.JRBridge && window.JRBridge.exactSettings) window.JRBridge.exactSettings();
        return;
      }
      if (ev.target && ev.target.id === 'lnkNotif') {
        ev.preventDefault();
        if (window.JRBridge && window.JRBridge.requestNotif) window.JRBridge.requestNotif();
        setTimeout(renderPush, 1200);
      }
    });

    $('btnCopyLog').addEventListener('click', function () { copyText(diagText()); });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      var idle = Date.now() - S.resumedAt;
      S.resumedAt = Date.now();
      if (idle > 60 * 1000 && S.tab === 'board') {
        ensureSession().then(function () { return refreshBoard(true); }).catch(function () { });
      }
    });
  }

  // ---------------------------------------------------------------- 生命周期
  function tick() {
    if (document.hidden || S.busy) return;
    if (S.tab !== 'board') return;
    refreshBoard(false);
  }

  window.JRApp = {
    onResume: function () {
      var idle = Date.now() - S.resumedAt;
      S.resumedAt = Date.now();
      if (idle > 30 * 1000) {
        refreshBoard(false);
      }
      if (S.tab === 'set') renderPush();
      return true;
    },
    onBack: function () {
      if (sheetOpen) { closeSheet(); return true; }
      return false;
    }
  };

  async function boot() {
    if (!CFG.phone || !CFG.password) {
      $('topMeta').textContent = '缺少账号配置（config.js）';
      setDot('bad');
    }
    S.date = todayStr();
    if (window.JRBridge && window.JRBridge.info) {
      try { S.info = JSON.parse(window.JRBridge.info()); } catch (e) { }
    }
    renderDates();
    renderCards();
    renderSettings();
    bind();
    setDot('busy');
    $('topMeta').textContent = '正在登录…';
    try {
      await ensureSession();
      await refreshBoard(true);
      // 启动时同步一次订单，让原生马上排上「开始前 30 分钟」提醒
      getOrders(true).catch(function () { });
      setInterval(tick, (CFG.refresh_seconds || 60) * 1000);
    } catch (e) {
      setDot('bad');
      $('topMeta').textContent = '连接失败：' + String(e.message || e);
      renderCards();
      openErrorSheet(e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
