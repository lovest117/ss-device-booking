      byDate[d] = byDate[d] || [];
      byDate[d].push(t.lesson || '');
    });
    var parts = Object.keys(byDate).sort().map(function (d) {
      return d.slice(5) + ' ' + mergeLessons(byDate[d]);
    });
    return {
      id: String(o.id || ''),
      name: o.classroom_name || '',
      state: String(o.state == null ? '0' : o.state),
      message: o.message || '',
      submit: o.submit_time || '',
      times: parts.join('；'),
      raw: o
    };
  }

  function orderSpan(o) {
    var rt = (o.raw && o.raw.reserve_times) || [];
    var out = { start: Infinity, end: 0 };
    for (var i = 0; i < rt.length; i++) {
      var t = rt[i] && rt[i].time;
      if (!t) continue;
      var d = String(t.date || '');
      var m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/.exec(String(t.lesson || ''));
      if (!d || !m) continue;
      var y = +d.slice(0, 4), mo = +d.slice(5, 7) - 1, da = +d.slice(8, 10);
      var st = new Date(y, mo, da, +m[1], +m[2]).getTime();
      var en = new Date(y, mo, da, +m[3], +m[4]).getTime();
      if (en <= st) en += 24 * 3600 * 1000;
      if (st < out.start) out.start = st;
      if (en < out.end) out.end = en;
    }
    return out;
  }

  function mergeLessons(list) {
    var segs = [];
    list.forEach(function (t) {
      var m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
      if (!m) return;
      segs.push({
        s: (m[1].length === 1 ? '0' + m[1] : m[1]) + ':' + m[2],
        e: (m[3].length === 1 ? '0' + m[3] : m[3]) + ':' + m[4],
        sm: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
        em: parseInt(m[3], 10) * 60 + parseInt(m[4], 10)
      });
    });
    segs.sort(function (a, b) { return a.sm - b.sm; });
    var merged = [];
    segs.forEach(function (x) {
      var last = merged[merged.length - 1];
      if (last && last.em === x.sm) last.em = x.em;
      else merged.push({ sm: x.sm, em: x.em });
    });
    function fmtMin(m) { return PAD(Math.floor(m / 60)) + ':' + PAD(m % 60); }
    return merged.map(function (x) { return fmtMin(x.sm) + '-' + fmtMin(x.em); }).join('、');
  }

  // ---------------------------------------------------------------- 看板数据
  function currentDevices() {
    var names = S.mode === 'fav' ? S.favorites.slice() : Object.keys(DEV);
    if (S.query) {
      var q = S.query.trim();
      names = names.filter(function (n) { return n.indexOf(q) >= 0 || DEV[n] === q; });
    }
    var seen = {};
    return names.filter(function (n) {
      if (!DEV[n] || seen[DEV[n]]) return false;
      seen[DEV[n]] = 1;
      return true;
    }).map(function (n) { return { name: n, id: DEV[n] }; });
  }

  async function refreshBoard(force) {
    if (S.busy) return;
    S.busy = true;
    setDot('busy');
    setProgress(0.08);
    var list = currentDevices();
    var date = S.date;
    var need = [];
    list.forEach(function (d) {
      var key = d.id + '|' + date;
      var c = S.cache[key];
      var stale = force || !c || Date.now() - c.ts > 55 * 1000;
      if (!stale) return;
      // 「全部」模式下不批量拉 40+ 台，仅收藏设备自动读，其余点卡片懒加载
      if (S.mode === 'fav' || S.query || S.favorites.indexOf(d.name) >= 0) need.push(d);
    });
    try {
      await ensureSession();
      for (var i = 0; i < need.length; i++) {
        var d = need[i];
        if (need.length > 1) setProgress(0.1 + 0.85 * (i / need.length));
        var key2 = d.id + '|' + date;
        S.loading[key2] = 1;
        try {
          var day = await fetchDay(d.id, date);
          S.cache[key2] = { ts: Date.now(), day: day };
        } catch (e) {
          S.cache[key2] = { ts: Date.now(), day: null, err: String(e.message || e) };
        } finally {
          delete S.loading[key2];
        }
        renderCards();
      }
      S.lastUpdate = new Date();
    } catch (e) {
      setDot('bad');
      $('topMeta').textContent = '连接失败：' + String(e.message || e);
      openErrorSheet(e);
    } finally {
      S.busy = false;
      setProgress(0);
      setDot(S.logged ? 'ok' : 'bad');
      renderCards();
      renderTop();
    }
  }

  // ---------------------------------------------------------------- 单台懒加载
  async function loadOne(d) {
    var key = d.id + '|' + S.date;
    if (S.loading[key]) return;
    S.loading[key] = 1;
    renderCards();
    try {
      await ensureSession();
      var day = await fetchDay(d.id, S.date);
      S.cache[key] = { ts: Date.now(), day: day };
    } catch (e) {
      S.cache[key] = { ts: Date.now(), day: null, err: String(e.message || e) };
    } finally {
      delete S.loading[key];
      renderCards();
      renderTop();
    }
  }

  // ---------------------------------------------------------------- 渲染：看板
  function selectedSlot(room, slot) {
    for (var i = 0; i < S.sel.length; i++) {
      if (S.sel[i].room === room && S.sel[i].slot === slot && S.sel[i].date === S.date) return true;
    }
    return false;
  }

  function cardHtml(d) {
    var c = S.cache[d.id + '|' + S.date];
    var headOpen = '<div class="card-head"><div class="name">' + esc(d.name) + '</div>';
    if (!c) {
      var tip = S.loading[d.id + '|' + S.date] ? '正在读取时段…' : '点击读取时段';
      return '<div class="card" data-load="' + d.id + '">' + headOpen +
        '<div class="skel">' + tip + '</div></div>';
    }
    if (!c.day) {
      return '<div class="card" data-load="' + d.id + '">' + headOpen +
        '<div class="card-note">读取失败：' + esc(c.err || '未知错误') +
        ' · <a href="#" data-retry="' + d.id + '">重试</a></div></div>';
    }
    var slots = c.day.slots;
    if (!slots.length) {
      return '<div class="card"><div class="card-head">' + headOpen + '<div class="free none">不可约</div></div>' +
        '<div class="card-note">当日无可预约时段（自定义时段或已关闭）</div></div>';
    }
    var totalFree = 0;
    var mineCount = 0;
    var blocks = slots.map(function (s) {
      if (!s.occ) totalFree += s.dur;
      var mine = s.occ && s.users.some(function (u) { return u.phone && u.phone === CFG.phone; });
      if (mine) mineCount++;
      var sel = !s.occ && selectedSlot(d.id, s.slot);
      var cls = sel ? 'sel' : (s.occ ? (mine ? 'mine' : 'occ') : 'free');
      var label = '';
      if (!sel) {
        var st = String(s.time).split('-')[0] || '';
        var hm = st.split(':');
        if (hm.length === 2) {
          var hh = parseInt(hm[0], 10);
          // 整点只写小时（8），半点写 8:30；太窄的格子渲染后会自动隐藏
          label = '<span class="hl">' + (hm[1] === '00' ? hh : hh + ':' + hm[1]) + '</span>';
        }
      }
      return '<button class="blk ' + cls + '" style="flex:' + s.dur + ' 1 0" ' +
        'data-room="' + d.id + '" data-slot="' + s.slot + '" aria-label="' + esc(s.time) + '">' + label + '</button>';
    }).join('');
    var freeBadge = totalFree
      ? '<div class="free">空闲 ' + fmtDur(totalFree) + '</div>'
      : '<div class="free none">全满</div>';
    return '<div class="card' + (mineCount ? ' mine' : '') + '">' +
      headOpen + freeBadge + '</div>' +
      '<div class="timeline">' + blocks + '</div>' +
      '<div class="axis"><span>' + esc(slots[0].time.split('-')[0]) + '</span><span>' +
      esc(slots[slots.length - 1].time.split('-')[1]) + '</span></div>' +
      '</div>';
  }
  function renderCards() {
    var list = currentDevices();
    $('cards').innerHTML = list.map(function (d) {
      return '<div data-card="' + d.id + '">' + cardHtml(d) + '</div>';
    }).join('');
    renderTop();
    renderAction();
    fitSlotLabels();
  }

  // 窄格子（半小时或更短）塞不下数字时自动隐藏，避免糊成一团
  function fitSlotLabels() {
    var run = function () {
      var els = document.querySelectorAll('#cards .blk');
      Array.prototype.forEach.call(els, function (b) {
        var hl = b.querySelector('.hl');
        if (hl && b.clientWidth < 13) hl.style.display = 'none';
      });
    };
    if (window.requestAnimationFrame) requestAnimationFrame(run);
    else setTimeout(run, 30);
  }

  function renderTop() {
    var list = currentDevices();
    var freeN = 0;
    list.forEach(function (d) {
      var c = S.cache[d.id + '|' + date];
      if (c && c.day && c.day.slots.some(function (s) { return !s.occ; })) freeN++;
    });
    var meta = list.length + ' 台 · ' + freeN + ' 台可约';
    if (S.busy) meta += ' · 读取中…';
    else if (S.lastUpdate) meta += ' · 更新 ' + hhmmss(S.lastUpdate);
    $('topMeta').textContent = meta;
    $('statLeft').textContent = (S.mode === 'fav' ? '收藏 ' : '全部 ') + list.length;
    $('statRight').textContent = S.lastUpdate ? '更新 ' + hhmmss(S.lastUpdate) : '未更新';
  }

  function renderDates() {
    var out = [];
    var now = new Date();
    for (var i = 0; i < HORIZON; i++) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      var s = ymd(d);
      var label = i === 0 ? '今天' : WD[d.getDay()];
      out.push('<button class="date-chip' + (s === S.date ? ' on' : '') + (i === 0 ? ' today' : '') +
        '" data-date="' + s + '"><b>' + PAD(d.getMonth() + 1) + '-' + PAD(d.getDate()) +
        '</b><s>' + label + '</s></button>');
    }
    $('dates').innerHTML = out.join('');
  }

  function setDot(state) {
    var d = $('dotSession');
    d.className = 'dot' + (state ? ' ' + state : '');
  }

  var progressTimer = null;
  function setProgress(v) {
    var p = $('progress');
    if (!v) {
      p.className = 'progress';
      p.style.width = '100%';
      setTimeout(function () { p.style.width = '0'; }, 260);
      return;
    }
    p.className = 'progress on';
    p.style.width = Math.max(4, Math.round(v * 100)) + '%';
  }

  // ---------------------------------------------------------------- 选择与操作条
  function sortedSel() {
    return S.sel.slice().sort(function (a, b) { return a.slot - b.slot; });
  }

  function toggleSel(d, slotObj) {
    var idx = -1;
    for (var i = 0; i < S.sel.length; i++) {
      if (S.sel[i].room === d.id && S.sel[i].slot === slotObj.slot) { idx = i; break; }
    }
    if (idx >= 0) {
      S.sel.splice(idx, 1);
    } else {
      if (S.sel.length && (S.sel[0].room !== d.id || S.sel[0].date !== S.date)) {
        toast('一单只能约同一台设备、同一天');
        return;
      }
      if (MAXH > 0) {
        var addMin = slotMinutes(slotObj.time);
        var curMin = selMinutes();
        if (curMin + addMin > MAXH * 60) {
          toast('每台设备每天最多约 ' + MAXH + ' 小时（已选 ' + fmtCn(curMin) + '），可拆成两单');
          return;
        }
      }
      if (MAXSEG > 0 && S.sel.length >= MAXSEG) {
        toast('单笔最多 ' + MAXSEG + ' 个时段，剩下的可拆到第二单');
        return;
      }
      S.sel.push({ room: d.id, name: d.name, date: S.date, slot: slotObj.slot, time: slotObj.time });
    }
    renderCards();
  }

  function renderAction() {
    var bar = $('actionBar');
    if (S.tab !== 'board' || !S.sel.length) {
      bar.classList.add('hidden');
      return;
    }
    var sel = sortedSel();
    bar.classList.remove('hidden');
    var mins = selMinutes();
    $('selCount').textContent = sel.length;
    var span = sel[0].time.split('-')[0] + ' 起 · ' + fmtCn(mins);
    if (sel.length > 1) span += ' / ' + sel.length + ' 段';
    $('selText').textContent = prettyDate(sel[0].date) + ' · ' + span;
  }

  // ---------------------------------------------------------------- 弹层
  var sheetOpen = false;
  function openSheet(html) {
    $('sheet').innerHTML = html;
    $('sheetWrap').classList.remove('hidden');
    sheetOpen = true;
  }
  function closeSheet() {
    $('sheetWrap').classList.add('hidden');
    sheetOpen = false;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function openErrorSheet(e) {
    openSheet('<div class="sheet-title">连接异常</div>' +
      '<div class="sheet-sub">' + esc(String((e && e.message) || e)) + '</div>' +
      '<div class="chips" style="margin-top:12px">' +
      '<span class="chip bad">' + esc(lastFailed()) + '</span></div>' +
      '<div class="actions"><button class="btn ghost" data-close>关闭</button>' +
      '<button class="btn" data-act="relogin">重新连接</button></div>');
  }

  function lastFailed() {
    var l = S.logs[0];
    if (!l) return '无日志';
    return l.method + ' ' + l.path.split('?')[0] + ' → ' + l.code;
  }

  function openSlotSheet(d, slot) {
    var users = slot.users.length
      ? slot.users.map(function (u) {
        return '<div class="urow">' +
          '<button class="uval" data-copy="' + esc(u.name) + '" data-copy-label="姓名">' +
          esc(u.name) + '</button>' +
          (u.phone
            ? '<button class="uval tel" data-copy="' + esc(u.phone) + '" data-copy-label="电话">' +
              esc(u.phone) + '<i class="ic">⧉</i></button>'
            : '<b>—</b>') +
          '</div>';
      }).join('')
      : '<div class="urow"><span>占用中（未公开使用人）</span><b>—</b></div>';
    openSheet('<div class="sheet-title">' + esc(d.name) + '</div>' +
      '<div class="sheet-sub">' + esc(prettyDate(S.date)) + ' · ' + esc(slot.time) + ' · 已被预约</div>' +
      '<div class="sheet-hint">点姓名或电话即可复制</div>' +
      '<div class="users">' + users + '</div>' +
      '<div class="actions"><button class="btn ghost" data-close>关闭</button></div>');
  }

  function defaultMessage(name) {
    var map = CFG.message_map || {};
    for (var k in map) {
      if (name.indexOf(k) >= 0) return map[k];
    }
    return name;
  }

  function openBookSheet() {
    var sel = sortedSel();
    if (!sel.length) return;
    if (MAXSEG > 0 && sel.length > MAXSEG) { toast('单笔最多 ' + MAXSEG + ' 个时段'); return; }
    if (MAXH > 0 && selMinutes() > MAXH * 60) {
      toast('每台设备每天最多约 ' + MAXH + ' 小时（已选 ' + fmtCn(selMinutes()) + '），可拆成两单');
      return;
    }
    var chips = sel.map(function (x) { return '<span class="chip">' + esc(x.time) + '</span>'; }).join('');
    openSheet('<div class="sheet-title">确认预约</div>' +
      '<div class="sheet-sub">' + esc(sel[0].name) + ' · ' + esc(prettyDate(sel[0].date)) + ' · ' + sel.length + ' 段</div>' +
      '<div class="chips">' + chips + '</div>' +
      '<div class="field"><label>备注（平台留言）</label>' +
      '<input id="bookNote" value="' + esc(defaultMessage(sel[0].name)) + '" maxlength="30"></div>' +
      '<div class="actions"><button class="btn ghost" data-close>取消</button>' +
      '<button class="btn" id="doBook">确认预约</button></div>');
  }

  async function doBook(note) {
    var sel = sortedSel();
    if (!sel.length) return;
    var room = sel[0].room, name = sel[0].name, date = sel[0].date;
    $('doBook').disabled = true;
    try {
      setDot('busy');
      await ensureSession();
      await warmRoom(room);
      var td = sel.map(function (x) { return room + '_' + date + PAD(x.slot); }).join(',');
      var r = await raw('GET', '/index.php/Wechat/Booking/confirm_booking?area_id=' + AREA +
        '&td_id=' + td + '&query_date=' + date + '&country_id=0', { headers: { Referer: tableUrl(room) } });
      if (!/form-sub/.test(r.body)) throw new AppError('确认页失败：' + errText(r.body));
      var pairs = extractForm(r.body);
      if (!pairs.length) throw new AppError('确认页表单解析失败（可能已过期）');
      pairs.push(['message', note || defaultMessage(name)]);

      var before = {};
      (await getOrders(true)).forEach(function (o) { before[o.id] = 1; });

      var sub = await raw('POST', '/index.php/Wechat/Register/register_show', {
        form: pairs,
        headers: { Referer: BASE + '/index.php/Wechat/Booking/confirm_booking' },
        followRedirects: false
      });

      var created = null;
      for (var i = 0; i < 6; i++) {
        if (i) await sleep(1300);
        var list = await getOrders(true);
        for (var k = 0; k < list.length; k++) {
          var o = list[k];
          if (!before[o.id] && o.name === name && o.state === '0') { created = o; break; }
        }
        if (created) break;
      }

      if (created) {
        S.sel = [];
        closeSheet();
        delete S.cache[room + '|' + date];
        setDot('ok');
        toast('已预约 · ' + name + ' · ' + sel.map(function (x) { return x.time.split('-')[0]; }).join('/') + ' · 单号 ' + created.id);
        renderCards();
        refreshBoard(false);
      } else if (sub.code === 302) {
        closeSheet();
        S.sel = [];
        delete S.cache[room + '|' + date];
        toast('提交已受理，订单列表暂未刷新，请稍后在「我的预约」确认');
        renderCards();
        refreshBoard(false);
