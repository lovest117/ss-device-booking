/* 乐享其约 · 设备预约看板
 * 纯本地 H5 + 原生网络桥（JRBridge.http）。
 * 接口顺序严格复刻已验证链路：sjsw -> login_in -> 预热房间 -> timestate -> confirm_booking -> register_show -> my_register_more。
 */
(function () {
  'use strict';

  var CFG = window.JR_CONFIG || {};
  var DEV = window.JR_DEVICES || {};
  var BASE = String(CFG.base_url || 'http://www.joyreserve.com').replace(/\/+$/, '');
  var AREA = String(CFG.area_id || '43');
  var MAXH = CFG.max_hours || 0;           // 0 = 不限制，跟随平台；>0 才按小时预拦
  var MAXSEG = CFG.max_segments || 15;     // 单笔表单物理上限 15 个时段，0 = 不校验
  var HORIZON = CFG.horizon_days || 15;
  var NATIVE = !!(window.JRBridge && window.JRBridge.http);
  var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  // ---------------------------------------------------------------- 基础工具
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function PAD(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return '' + d.getFullYear() + PAD(d.getMonth() + 1) + PAD(d.getDate()); }
  function dateObj(s) { return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)); }
  function todayStr() { return ymd(new Date()); }
  function prettyDate(s) {
    var d = dateObj(s);
    return s.slice(4, 6) + '-' + s.slice(6, 8) + ' ' + WD[d.getDay()];
  }
  function hhmmss(d) {
    if (!d) return '--:--';
    return PAD(d.getHours()) + ':' + PAD(d.getMinutes()) + ':' + PAD(d.getSeconds());
  }
  function fmtDur(min) {
    var h = Math.floor(min / 6), m = min % 6;
    if (h && m) return h + 'h' + m + 'm';
    if (h) return h + 'h';
    return m + 'm';
  }
  function fmtCn(min) {
    var h = Math.floor(min / 6), m = min % 6;
    if (h && m) return h + ' 小时 ' + m + ' 分';
    if (h) return h + ' 小时';
    return m + ' 分钟';
  }
  function slotMinutes(time) {
    var m = String(time || '').match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (!m) return 0;
    var a = parseInt(m[1], 10) * 6 + parseInt(m[2], 10);
    var b = parseInt(m[3], 10) * 6 + parseInt(m[4], 10);
    if (b <= a) b += 24 * 60;
    return b - a;
  }
  function selMinutes() {
    var n = 0;
    for (var i = 0; i < S.sel.length; i++) n += slotMinutes(S.sel[i].time);
    return n;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function AppError(msg) { this.message = msg; }
  function stripTags(h) {
    return String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function errText(h) {
    var m = /class="text"[^>]*>\s*([^<]+)/i.exec(String(h || ''));
    if (m) return m[1].trim();
    var t = stripTags(h);
    return t ? t.slice(0, 120) : '(空响应)';
  }
  function maskSecrets(s) {
    return String(s == null ? '' : s).replace(/1[3-9]\d{9}/g, function (m) {
      return m.charAt(0) + '**********';
    });
  }

  // ---------------------------------------------------------------- HTTP 桥
  var cbSeq = 0;
  var cbs = Object.create(null);

  window.JR = {
    __cb: function (id, data) {
      var fn = cbs[id];
      if (!fn) return;
      delete cbs[id];
      try { fn(data || {}); } catch (e) { console.error(e); }
    }
  };

  function nativeHttp(req) {
    return new Promise(function (resolve) {
      var id = 'c' + (++cbSeq);
      var done = false;
      var guard = setTimeout(function () {
        if (done) return;
        done = true;
        delete cbs[id];
        resolve({ code: 0, body: '', error: '请求超时（原生无响应）' });
      }, 50000);
      cbs[id] = function (data) {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve(data);
      };
      try {
        window.JRBridge.http(JSON.stringify(req), id);
      } catch (e) {
        done = true;
        clearTimeout(guard);
        delete cbs[id];
        resolve({ code: 0, body: '', error: '桥接异常：' + String(e) });
      }
    });
  }

  // ------- Mock：仅用于 PC 浏览器直接打开 index.html 调界面，不参与 APK 真实链路
  var MOCK_USERS = [['郭晓颖', '17309283750'], ['徐晴', '19953992584'], ['陈辰', '15691878960'],
    ['朱翠翠', '18850147224'], ['李子萌', '18089102262'], ['周敏', '13555558888']];
  var mHash = function (s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h >>> 0;
  };
  function mRand(seedStr) {
    var s = mHash(seedStr) || 1;
    return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  }
  function mockTimestate(roomId, dates) {
    var out = {};
    dates.forEach(function (d) {
      var rnd = mRand(roomId + d);
      var custom = roomId === '15221';
      var tm = {}, ar = {}, ru = {};
      var n = custom ? 3 : 15;
      for (var i = 1; i <= n; i++) {
        if (custom) {
          tm[i] = ['08:30-14:00', '14:00-19:30', '19:30-23:30'][i - 1];
        } else {
          tm[i] = PAD(7 + i) + ':00-' + PAD(8 + i) + ':00';
        }
        var occ = rnd() > 0.5;
        ar[i] = occ ? '1' : '0';
        if (occ) {
          var u = MOCK_USERS[Math.floor(rnd() * MOCK_USERS.length)];
          ru[i] = [{ user_name: u[0], phone: u[1], order_id: '1086' + Math.floor(rnd() * 9000 + 1000) }];
        } else {
          ru[i] = [null];
        }
      }
      out[d] = {
        room_id: roomId, room_name: 'mock', the_room_num_times: n,
        time: tm, already_reserve: ar, reserve_users: ru
      };
    });
    return out;
  }
  var MOCK_STATE = { orders: null, seq: 0, lastTd: '' };
  function mockOrders() {
    if (!MOCK_STATE.orders) {
      MOCK_STATE.orders = [
        {
          id: '10861588', classroom_name: '立体定位仪-双臂3', state: '0',
          submit_time: '2026-11-19 20:32:32', message: '定位',
          reserve_times: [
            { time: { date: '2026-11-28', lesson: '08:00-09:00', start_timestamp: '1' } },
            { time: { date: '2026-11-28', lesson: '21:00-22:00', start_timestamp: '2' } },
            { time: { date: '2026-11-28', lesson: '22:00-23:00', start_timestamp: '3' } }
          ]
        },
        {
          id: '10861504', classroom_name: '切片机-手术室', state: '0',
          submit_time: '2026-11-19 09:02:11', message: '切片',
          reserve_times: [
            { time: { date: '2026-11-23', lesson: '11:00-12:00', start_timestamp: '1' } },
            { time: { date: '2026-11-23', lesson: '12:00-13:00', start_timestamp: '2' } }
          ]
        }
      ];
    }
    return { data: MOCK_STATE.orders };
  }
  function mockNameOfRoom(room) {
    for (var k in DEV) { if (DEV[k] === room) return k; }
    return '设备 ' + room;
  }
  function mockHttp(req) {
    var url = String(req.url || '');
    var form = req.form || [];
    var roomId = '', dates = [];
    for (var i = 0; i < form.length; i++) {
      if (form[i][0] === 'room_id') roomId = form[i][1];
      if (form[i][0] === 'datesList[]') dates.push(form[i][1]);
    }
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (/\/index\.php\/sjsw/.test(url)) {
          return resolve({ code: 200, body: '<html>sjsw ok</html>', error: '' });
        }
        if (/login_in/.test(url)) {
          return resolve({ code: 200, body: '{"code":200,"message":"登录成功"}', error: '' });
        }
        if (/confirm_disclaimer/.test(url) || /one_room_private_booking_table/.test(url)) {
          return resolve({ code: 200, body: '<html>ok</html>', error: '' });
        }
        if (/timestate/.test(url)) {
          var j = mockTimestate(roomId || '8125', dates.length ? dates : [todayStr()]);
          return resolve({ code: 200, body: JSON.stringify(j), error: '' });
        }
        if (/confirm_booking/.test(url)) {
          var tdq = /td_id=([^&]+)/.exec(url);
          MOCK_STATE.lastTd = tdq ? decodeURIComponent(tdq) : '';
          return resolve({
            code: 200, error: '',
            body: '<form id="form-sub"><input type="hidden" name="form_valid_code_value" value="mock">' +
              '<input type="hidden" name="td_id" value="' + MOCK_STATE.lastTd + '"></form>'
          });
        }
        if (/register_show/.test(url)) {
          var td = '', msg = '';
          for (var k = 0; k < form.length; k++) {
            if (form[k][0] === 'td_id') td = String(form[k][1]);
            if (form[k][0] === 'message') msg = String(form[k][1]);
          }
          if (!td) td = MOCK_STATE.lastTd;
          var first = String(td).split(',')[0] || '8125_' + todayStr() + '01';
          var room = first.split('_')[0];
          var parts = first.split('_')[1] || todayStr() + '01';
          var date = parts.slice(0, 8);
          var lesson = PAD(parseInt(parts.slice(8), 10) + 7) + ':00-' + PAD(parseInt(parts.slice(8), 10) + 8) + ':00';
          MOCK_STATE.orders.unshift({
            id: String(10861600 + (++MOCK_STATE.seq)), classroom_name: mockNameOfRoom(room), state: '0',
            submit_time: new Date().toLocaleString(), message: msg || '预约',
            reserve_times: [{ time: { date: date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8), lesson: lesson, start_timestamp: '1' } }]
          });
          return resolve({ code: 302, body: '', error: '' });
        }
        if (/my_register_more/.test(url)) {
          return resolve({ code: 200, body: JSON.stringify(mockOrders()), error: '' });
        }
        if (/register_cancel/.test(url)) {
          var rid = (/reservation_id=([^&]+)/.exec(url)) || '';
          MOCK_STATE.orders.forEach(function (o) {
            if (o.id === decodeURIComponent(rid)) o.state = '3';
          });
          return resolve({ code: 200, body: '<div class="text">取消成功</div>', error: '' });
        }
        return resolve({ code: 200, body: '{}', error: '' });
      }, 120 + Math.floor(Math.random() * 260));
    });
  }
  function http(req) { return NATIVE ? nativeHttp(req) : mockHttp(req); }

  // ---------------------------------------------------------------- 状态
  var S = {
    date: todayStr(),
    mode: 'fav',
    query: '',
    tab: 'board',
    favorites: loadFavorites(),
    cache: {},          // roomId|date -> {ts, day, err}
    sel: [],            // {room, name, date, slot, time}
    orders: null,
    ordersAt: 0,
    loading: {},
    lastUpdate: null,
    busy: false,
    logged: false,
    loginAt: 0,
    logs: [],
    info: {},
    warmAt: {},
    resumedAt: Date.now()
  };

  function loadFavorites() {
    try {
      var raw = JSON.parse(localStorage.getItem('jr_fav') || 'null');
      if (Array.isArray(raw) && raw.length) {
        return raw.filter(function (n) { return typeof n === 'string'; });
      }
    } catch (e) { }
    return (CFG.favorites || []).filter(function (n) { return DEV[n]; });
  }
  function saveFavorites() {
    try { localStorage.setItem('jr_fav', JSON.stringify(S.favorites)); } catch (e) { }
  }

  // ---------------------------------------------------------------- 网络封装
  function raw(method, path, opts) {
    var req = Object.assign({ method: method, url: path, followRedirects: true, timeoutMs: 15000 }, opts || {});
    var t0 = Date.now();
    return http(req).then(function (r) {
      pushLog(method, path, r.code, r.ms || (Date.now() - t0), r.body, r.error);
      return r;
    });
  }

  function pushLog(method, path, code, ms, body, error) {
    var snip = '';
    if (error) {
      snip = 'ERR ' + maskSecrets(String(error)).slice(0, 140);
    } else if (!code || code >= 400) {
      snip = 'HTTP ' + code;
    }
    S.logs.unshift({ t: new Date(), method: method, path: path, code: code, ms: ms || 0, snip: snip });
    if (S.logs.length > 30) S.logs.length = 30;
    if (S.tab === 'set') renderLogs();
  }

  var lastLoginText = '—';

  async function ensureSession(force) {
    if (!force && S.logged && Date.now() - S.loginAt < 10 * 60 * 1000) return;
    await raw('GET', CFG.shop_path || '/index.php/sjsw');
    var r = await raw('POST', '/index.php/Wechat/User/login_in', {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      },
      rawBody: JSON.stringify({ phone: CFG.phone, number: null, password: CFG.password, code: null })
    });
    var ok = false;
    try {
      var j = JSON.parse(r.body);
      ok = !!(j && (j.code === 200 || String(j.code) === '200'));
    } catch (e) {
      ok = /登录成功|"code"\s*:\s*200/.test(r.body);
    }
    if (!ok) {
      S.logged = false;
      setDot('bad');
      throw new AppError('登录失败：' + errText(r.body));
    }
    S.logged = true;
    S.loginAt = Date.now();
    lastLoginText = hhmmss(new Date());
    setDot('ok');
  }

  function tableUrl(roomId) {
    return BASE + '/index.php/Wechat/Booking/one_room_private_booking_table?room_id=' + roomId +
      '&time_type=1&area_id=' + AREA;
  }

  async function warmRoom(roomId) {
    await raw('POST', '/index.php/Wechat/Other/confirm_disclaimer/back_url/one_room_private_booking_table', {
      form: [
        ['back_url', 'one_room_private_booking_table'],
        ['room_id', roomId],
        ['area_id', AREA],
        ['area_must_reserve_times_one_time', '0'],
        ['country_id', ''],
        ['time_type', '1']
      ]
    });
    await raw('GET', '/index.php/Wechat/Booking/one_room_private_booking_table?room_id=' + roomId +
      '&time_type=1&area_id=' + AREA + '&area_must_reserve_times_one_time=0&country_id=0');
  }

  async function timestateOnce(roomId, date) {
    var r = await raw('POST', '/index.php/API/Room/ajax_return_one_period_one_room_timestate', {
      form: [['room_id', roomId], ['datesList[]', date]],
      headers: { Referer: tableUrl(roomId) }
    });
    var j = null;
    try { j = JSON.parse(r.body); } catch (e) { }
    return { json: (j && !j.error) ? j : null, raw: r };
  }

  async function fetchDay(roomId, date) {
    // 预热按房间缓存 8 分钟：一次刷新从 18 个请求降到 6 个；若仍被拒则补预热重试一次
    var warmed = S.warmAt[roomId] && (Date.now() - S.warmAt[roomId] < 8 * 60 * 1000);
    if (!warmed) {
      await warmRoom(roomId);
      S.warmAt[roomId] = Date.now();
    }
    var out = await timestateOnce(roomId, date);
    if (!out.json && warmed) {
      await warmRoom(roomId);
      S.warmAt[roomId] = Date.now();
      out = await timestateOnce(roomId, date);
    }
    if (!out.json) throw new AppError('时段查询失败：' + errText(out.raw.body));
    return parseDay(out.json[date] || {});
  }

  function parseDay(v) {
    var tm = v.time || {};
    var ar = v.already_reserve || {};
    var ru = v.reserve_users || {};
    var slots = [];
    Object.keys(tm).forEach(function (k) {
      var t = tm[k];
      if (!t || t === '-') return;                       // 占位格不渲染
      var m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/.exec(String(t).replace(/\s/g, ''));
      var dur = m
        ? (parseInt(m[3], 10) * 6 + parseInt(m[4], 10)) - (parseInt(m[1], 10) * 6 + parseInt(m[2], 10))
        : 60;
      if (!(dur > 0)) dur = 60;
      var users = (ru[k] || []).filter(Boolean).map(function (u) {
        return { name: u.user_name || u.username || '—', phone: u.phone || '' };
      });
      slots.push({
        slot: parseInt(k, 10),
        time: String(t),
        dur: dur,
        occ: String(ar[k] == null ? '0' : ar[k]) === '1',
        users: users
      });
    });
    slots.sort(function (a, b) { return a.slot - b.slot; });
    return { slots: slots, room: v.room_name || '' };
  }

  function extractForm(html) {
    var fm = /<form[^>]*id=["']form-sub["'][\s\S]*?<\/form>/i.exec(html || '');
    if (!fm) return [];
    var tags = fm[0].match(/<input[^>]*>/gi) || [];
    var pairs = [];
    tags.forEach(function (tag) {
      var n = /name=["']([^"']+)["']/i.exec(tag);
      if (!n) return;
      var v = /value=["']([^"']*)["']/i.exec(tag);
      pairs.push([n[1], v ? v[1] : '']);
    });
    return pairs;
  }

  async function getOrders(force) {
    if (!force && S.orders && Date.now() - S.ordersAt < 20000) return S.orders;
    try {
      var r = await raw('POST', '/index.php/Wechat/Home/my_register_more', {
        form: [['page', '1']],
        headers: { Referer: BASE + '/index.php/Wechat/Home/my_register' }
      });
      var j = JSON.parse(r.body);
      S.orders = (j.data || []).map(normalizeOrder);
      S.ordersAt = Date.now();
      if (NATIVE && window.JRBridge.syncOrders) {
        try { window.JRBridge.syncOrders(JSON.stringify(j.data || [])); } catch (e) { }
      }
    } catch (e) {
      S.orders = S.orders || [];
    }
    return S.orders;
  }

  function normalizeOrder(o) {
    var times = (o.reserve_times || []).map(function (x) { return x.time; }).filter(Boolean);
    times.sort(function (a, b) { return (+a.start_timestamp || 0) - (+b.start_timestamp || 0); });
    var byDate = {};
    times.forEach(function (t) {
      var d = t.date || (t.name ? t.name.slice(0, 4) + '-' + t.name.slice(4, 6) + '-' + t.name.slice(6, 8) : '');
      if (!d) return;
