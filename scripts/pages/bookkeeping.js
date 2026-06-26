/* ============================================
   月度记账本 — 逻辑层（vanilla JS，无框架）
   本地 localStorage + 可选 Supabase 多人共享
   预算口径：预算总额=收入；预算支出=储蓄+开支(计划)；已支出=勾选完成的开支+储蓄；还剩=预算总额-预算支出
   ============================================ */
(function () {
  'use strict';

  var BOOK_ID_KEY = 'bookkeeping_book_id';
  var POLL_FALLBACK_MS = 60000;
  var SYNC_LABELS = {
    '': '',
    ok: '已同步',
    syncing: '同步中…',
    err: '同步失败',
    live: '实时同步'
  };

  /* ---------- 工具 ---------- */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function newBookId() {
    return 'bk_' + Math.random().toString(36).slice(2, 10);
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function monthKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
  var CYCLE_START_DAY = 10;
  function cycleAnchor(d) {
    var y = d.getFullYear();
    var mo = d.getMonth();
    if (d.getDate() < CYCLE_START_DAY) mo -= 1;
    return new Date(y, mo, 1);
  }
  function cycleRangeText(d) {
    var start = new Date(d.getFullYear(), d.getMonth(), 1);
    var end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return (start.getMonth() + 1) + '/' + CYCLE_START_DAY + ' - ' + (end.getMonth() + 1) + '/' + CYCLE_START_DAY;
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function nowISO() {
    return new Date().toISOString();
  }
  function formatPaymentTime(payment) {
    if (!payment) return '';
    if (payment.recordedAt) {
      try {
        var d = new Date(payment.recordedAt);
        if (!isNaN(d.getTime())) {
          return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        }
      } catch (e) {}
    }
    if (payment.date) {
      var parts = payment.date.split('-');
      if (parts.length >= 3) return parts[1] + '-' + parts[2];
      return payment.date;
    }
    return '';
  }
  function buildPaymentTimeline(expense) {
    if (!expense) return [];
    var planned = num(expense.plannedAmount);
    var payments = expense.payments || [];
    var running = 0;
    var rows = [];
    for (var i = 0; i < payments.length; i++) {
      var p = payments[i];
      var amt = num(p.amount);
      if (amt <= 0) continue;
      running += amt;
      rows.push({
        amount: amt,
        amountText: fmt(amt),
        note: (p.note || '').trim() || ('第' + (rows.length + 1) + '笔'),
        timeText: formatPaymentTime(p),
        remain: Math.max(0, planned - running),
        remainText: fmt(Math.max(0, planned - running))
      });
    }
    return rows;
  }
  function num(v) {
    var n = parseFloat(v);
    return isNaN(n) || n < 0 ? 0 : n;
  }
  function fmt(n) {
    n = Math.round((n + Number.EPSILON) * 100) / 100;
    var s = (Math.abs(n) % 1 === 0) ? n.toFixed(0) : n.toFixed(2);
    return '¥' + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function $(id) { return document.getElementById(id); }

  var toastTimer = null;
  function showToast(msg, ms) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
    }, ms || 2400);
  }

  function getConfig() {
    return window.BOOKKEEPING_CONFIG || {};
  }
  function cloudEnabled() {
    var c = getConfig();
    return !!(c.supabaseUrl && c.supabaseAnonKey);
  }
  function supabaseHeaders(extra) {
    var c = getConfig();
    var h = {
      apikey: c.supabaseAnonKey,
      Authorization: 'Bearer ' + c.supabaseAnonKey,
      'Content-Type': 'application/json'
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    }
    return h;
  }

  var STORAGE_PREFIX = 'bookkeeping_data_v1';
  var SYNC_PREFIX = 'bookkeeping_sync_at';

  function dataStorageKey(bookId) {
    return STORAGE_PREFIX + '_' + (bookId || '_none');
  }
  function syncStorageKey(bookId) {
    return SYNC_PREFIX + '_' + (bookId || '_none');
  }

  /* ---------- 数据层 ---------- */
  function emptyMonth() {
    return { income: [], savings: [], expenses: [] };
  }
  function emptyData() {
    return { budgetByMonth: {}, months: {} };
  }
  function migrateLegacyData(bookId) {
    var newKey = dataStorageKey(bookId);
    if (localStorage.getItem(newKey)) return;
    var legacy = localStorage.getItem(STORAGE_PREFIX);
    if (legacy) localStorage.setItem(newKey, legacy);
  }

  function loadLocal(bookId) {
    bookId = bookId || state.bookId;
    if (!bookId) return emptyData();
    migrateLegacyData(bookId);
    try {
      var raw = localStorage.getItem(dataStorageKey(bookId));
      if (!raw) return emptyData();
      var data = JSON.parse(raw);
      if (!data.budgetByMonth) data.budgetByMonth = {};
      if (!data.months) data.months = {};
      return data;
    } catch (e) {
      return emptyData();
    }
  }
  function saveLocal() {
    if (!state.bookId) return;
    try {
      localStorage.setItem(dataStorageKey(state.bookId), JSON.stringify(state.data));
    } catch (e) {
      showToast('保存失败：浏览器存储空间不足或被禁用');
    }
  }
  function getMonth(key) {
    if (!state.data.months[key]) state.data.months[key] = emptyMonth();
    return state.data.months[key];
  }

  /* ---------- 云端同步 ---------- */
  function showSyncError(msg) {
    state.syncFailed = true;
    var bar = $('syncError');
    var msgEl = $('syncErrorMsg');
    if (bar) bar.hidden = false;
    if (msgEl && msg) msgEl.textContent = msg;
    setSyncStatus('err');
  }
  function hideSyncError() {
    state.syncFailed = false;
    var bar = $('syncError');
    if (bar) bar.hidden = true;
  }

  function parseCloudError(res) {
    return res.text().then(function (t) {
      try {
        var j = JSON.parse(t);
        return j.message || t || ('HTTP ' + res.status);
      } catch (e) {
        return t || ('HTTP ' + res.status);
      }
    });
  }

  function setSyncStatus(status, label) {
    var dot = $('syncDot');
    var text = $('syncStatusText');
    if (dot) dot.className = 'sync-dot' + (status ? ' ' + status : '');
    if (text) text.textContent = label != null ? label : (SYNC_LABELS[status] || '');
  }

  function cloudFetch(bookId) {
    var c = getConfig();
    var url = c.supabaseUrl + '/rest/v1/ledgers?id=eq.' + encodeURIComponent(bookId) +
      '&select=data,updated_at';
    return fetch(url, { headers: supabaseHeaders() })
      .then(function (res) {
        if (!res.ok) {
          return parseCloudError(res).then(function (msg) { throw new Error(msg); });
        }
        return res.json();
      })
      .then(function (rows) {
        return rows.length ? rows[0] : null;
      });
  }

  function cloudPush(bookId, data) {
    var c = getConfig();
    var updated_at = new Date().toISOString();
    return fetch(c.supabaseUrl + '/rest/v1/ledgers?on_conflict=id', {
      method: 'POST',
      headers: supabaseHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ id: bookId, data: data, updated_at: updated_at })
    }).then(function (res) {
      if (!res.ok) {
        return parseCloudError(res).then(function (msg) { throw new Error(msg); });
      }
      localStorage.setItem(syncStorageKey(bookId), updated_at);
      hideSyncError();
      return updated_at;
    });
  }

  function applyCloudRow(row, force) {
    if (!row || !row.data) return false;
    var localAt = localStorage.getItem(syncStorageKey(state.bookId)) || '';
    if (force || !localAt || row.updated_at > localAt) {
      state.data = row.data;
      if (!state.data.budgetByMonth) state.data.budgetByMonth = {};
      if (!state.data.months) state.data.months = {};
      saveLocal();
      localStorage.setItem(syncStorageKey(state.bookId), row.updated_at);
      hideSyncError();
      return true;
    }
    return false;
  }

  function pullFromCloud(silent, force) {
    if (!cloudEnabled() || !state.bookId) return Promise.resolve(false);
    if (!silent) setSyncStatus('syncing');
    return cloudFetch(state.bookId)
      .then(function (row) {
        if (!row) {
          return cloudPush(state.bookId, state.data).then(function () {
            setSyncStatus(state.realtimeReady ? 'live' : 'ok');
            return false;
          });
        }
        var changed = applyCloudRow(row, force);
        setSyncStatus(state.realtimeReady ? 'live' : 'ok');
        return changed;
      })
      .catch(function (err) {
        setSyncStatus('err');
        var msg = (err && err.message) ? err.message : '';
        if (msg.indexOf('ledgers') !== -1 || msg.indexOf('PGRST') !== -1) {
          showSyncError('云端同步失败：Supabase 数据库表未创建，家人无法看到数据。请联系管理员建表。');
        } else {
          showSyncError('云端同步失败：' + msg + '。家人可能看不到最新数据。');
        }
        return false;
      });
  }

  var pollTimer = null;
  var supabaseClient = null;
  var realtimeChannel = null;
  var visibilityBound = false;

  function getSupabaseClient() {
    if (!window.supabase || !window.supabase.createClient) return null;
    var c = getConfig();
    if (!supabaseClient) {
      supabaseClient = window.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey);
    }
    return supabaseClient;
  }

  function stopRealtime() {
    state.realtimeReady = false;
    if (realtimeChannel && supabaseClient) {
      supabaseClient.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
  }

  function startRealtime() {
    stopRealtime();
    if (!cloudEnabled() || !state.bookId) return;
    var client = getSupabaseClient();
    if (!client) return;

    realtimeChannel = client
      .channel('ledger-' + state.bookId)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'ledgers',
          filter: 'id=eq.' + state.bookId
        },
        function (payload) {
          var row = payload.new;
          if (!row || !row.data) return;
          var changed = applyCloudRow(row, false);
          if (changed) render();
          setSyncStatus('live');
        }
      )
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          state.realtimeReady = true;
          setSyncStatus('live');
        }
      });
  }

  function stopCloudSync() {
    stopRealtime();
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startCloudSync() {
    stopCloudSync();
    if (!cloudEnabled() || !state.bookId) return;
    startRealtime();
    pollTimer = setInterval(function () {
      pullFromCloud(true).then(function (changed) {
        if (changed) render();
      });
    }, POLL_FALLBACK_MS);
    if (!visibilityBound) {
      visibilityBound = true;
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && state.bookId) {
          pullFromCloud(true).then(function (changed) {
            if (changed) render();
          });
        }
      });
    }
  }

  function retrySync() {
    if (!cloudEnabled() || !state.bookId) return;
    hideSyncError();
    setSyncStatus('syncing');
    cloudPush(state.bookId, state.data)
      .then(function () {
        setSyncStatus(state.realtimeReady ? 'live' : 'ok');
        showToast('同步成功');
        startRealtime();
      })
      .catch(function () {
        pullFromCloud(false, false).then(function (changed) {
          if (changed) render();
          if (!state.syncFailed) {
            setSyncStatus(state.realtimeReady ? 'live' : 'ok');
            showToast('同步成功');
            startRealtime();
          }
        });
      });
  }

  function save() {
    saveLocal();
    if (cloudEnabled() && state.bookId) {
      setSyncStatus('syncing');
      cloudPush(state.bookId, state.data)
        .then(function () { setSyncStatus(state.realtimeReady ? 'live' : 'ok'); })
        .catch(function () {
          setSyncStatus('err');
          showSyncError('保存到云端失败，家人可能看不到最新数据。');
        });
    }
  }

  /* ---------- 账本 ID ---------- */
  function normalizeBookId(raw) {
    return (raw || '').trim().toLowerCase();
  }
  function isValidBookId(id) {
    return /^[a-z0-9_-]{4,32}$/.test(id);
  }
  function resolveBookIdFromUrl() {
    var m = /[?&]book=([^&]+)/.exec(window.location.search);
    return m ? normalizeBookId(decodeURIComponent(m[1])) : '';
  }
  function getPublicEntry() {
    var host = window.location.hostname;
    if (host.indexOf('jsdelivr.net') !== -1) {
      return 'https://cdn.jsdelivr.net/gh/danainiu56-bot/family-ledger@bookkeeping/';
    }
    if (host.indexOf('github.io') !== -1) {
      return window.location.origin + '/family-ledger/book/';
    }
    var p = window.location.pathname;
    if (p.indexOf('/book') !== -1) {
      return window.location.origin + p.replace(/\/[^/]*$/, '/').replace(/\/?$/, '/');
    }
    return window.location.origin + '/family-ledger/book/';
  }
  function getShareLink() {
    return getPublicEntry() + '?book=' + encodeURIComponent(state.bookId);
  }
  function getShareMessage() {
    var key = monthKey(state.current);
    var parts = key.split('-');
    var label = parts[0] + '年' + parseInt(parts[1], 10) + '月';
    return label + '家庭记账本，点开一起看：' + getShareLink();
  }
  function updateBookBar() {
    var bar = $('bookBar');
    if (!cloudEnabled()) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    $('bookIdDisplay').textContent = state.bookId || '未加入';
  }

  function setBookId(id) {
    state.bookId = normalizeBookId(id);
    localStorage.setItem(BOOK_ID_KEY, state.bookId);
    state.data = loadLocal(state.bookId);
    updateBookBar();
    var url = new URL(window.location.href);
    url.searchParams.set('book', state.bookId);
    window.history.replaceState({}, '', url.pathname + url.search);
  }

  function openBookSetup(force) {
    $('fBookId').value = state.bookId || '';
    $('bookMask').hidden = false;
    $('bookDrawer').hidden = false;
    $('bookDrawer').dataset.force = force ? '1' : '';
    setTimeout(function () { $('fBookId').focus(); }, 280);
  }
  function closeBookSetup() {
    if ($('bookDrawer').dataset.force === '1' && !state.bookId) return;
    $('bookMask').hidden = true;
    $('bookDrawer').hidden = true;
  }

  function joinBook(id) {
    id = normalizeBookId(id);
    if (!isValidBookId(id)) {
      showToast('账本编号格式不正确');
      return Promise.resolve(false);
    }
    stopCloudSync();
    setBookId(id);
    return pullFromCloud(false, true).then(function (changed) {
      closeBookSetup();
      render();
      startCloudSync();
      return true;
    });
  }

  function copyText(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function showShareDrawerContent() {
    $('shareLinkText').value = getShareMessage();
    $('shareBookIdText').value = state.bookId;
    $('shareMask').hidden = false;
    $('shareDrawer').hidden = false;
    setTimeout(function () {
      var el = $('shareLinkText');
      el.focus();
      el.select();
    }, 280);
  }

  function openShareDrawer() {
    if (!state.bookId) {
      showToast('请先创建或加入账本');
      return;
    }
    if (!cloudEnabled()) {
      showToast('未配置云端，无法分享给家人');
      return;
    }
    setSyncStatus('syncing');
    cloudPush(state.bookId, state.data).then(function () {
      setSyncStatus(state.realtimeReady ? 'live' : 'ok');
      showShareDrawerContent();
    }).catch(function (err) {
      setSyncStatus('err');
      var msg = (err && err.message) ? err.message : '';
      if (msg.indexOf('ledgers') !== -1 || msg.indexOf('PGRST') !== -1) {
        showSyncError('云端表未创建，家人无法看到数据。');
        showToast('请先在 Supabase 创建 ledgers 表');
      } else {
        showSyncError('保存到云端失败：' + msg);
        showToast('保存失败，请点重试或稍后再分享');
      }
    });
  }

  function closeShareDrawer() {
    $('shareMask').hidden = true;
    $('shareDrawer').hidden = true;
  }

  function doCopyShare() {
    var text = $('shareLinkText').value;
    if (!text) return;
    if (copyText(text)) {
      showToast('已复制，去微信粘贴发给家人吧');
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showToast('已复制，去微信粘贴发给家人吧');
      }).catch(function () {
        $('shareLinkText').focus();
        $('shareLinkText').select();
        showToast('请长按上方文案框，选择「复制」');
      });
      return;
    }
    $('shareLinkText').focus();
    $('shareLinkText').select();
    showToast('请长按上方文案框，选择「复制」');
  }

  /* ---------- 全局状态 ---------- */
  var state = {
    data: emptyData(),
    current: new Date(),
    editing: null,
    bookId: '',
    syncFailed: false,
    realtimeReady: false,
    payingExpenseId: null,
    activeTab: 'home'
  };

  /* ---------- 计算 ---------- */
  function sum(list, field) {
    var t = 0;
    for (var i = 0; i < list.length; i++) t += num(list[i][field]);
    return t;
  }
  function expensePaid(item) {
    if (item.payments && item.payments.length) {
      var t = 0;
      for (var i = 0; i < item.payments.length; i++) t += num(item.payments[i].amount);
      return t;
    }
    if (item.done) {
      var amt = item.actualAmount;
      if (amt === '' || amt == null) amt = item.plannedAmount;
      return num(amt);
    }
    return 0;
  }
  function expenseStatus(item) {
    var paid = expensePaid(item);
    var planned = num(item.plannedAmount);
    if (paid <= 0) return 'pending';
    if (planned > 0 && paid >= planned) return 'done';
    return 'partial';
  }
  function ensurePayments(item) {
    if (item.payments) return item.payments;
    var arr = [];
    if (item.done) {
      var amt = item.actualAmount;
      if (amt === '' || amt == null) amt = item.plannedAmount;
      amt = num(amt);
      if (amt > 0) arr.push({ id: uid(), amount: amt, date: item.date || todayISO() });
    }
    item.payments = arr;
    return arr;
  }
  function expensePaymentCount(item) {
    if (item.payments && item.payments.length) return item.payments.length;
    if (item.done && expensePaid(item) > 0) return 1;
    return 0;
  }
  function paymentNotesSummary(item) {
    if (!item.payments || !item.payments.length) return '';
    var notes = [];
    for (var i = 0; i < item.payments.length; i++) {
      var n = (item.payments[i].note || '').trim();
      if (n) notes.push(n);
    }
    return notes.join('、');
  }
  function refreshExpenseDone(item) {
    var planned = num(item.plannedAmount);
    var wasDone = !!item.done;
    var nowDone = planned > 0 && expensePaid(item) >= planned;
    item.done = nowDone;
    if (nowDone && !wasDone) {
      item.completedAt = new Date().toISOString();
    } else if (!nowDone) {
      delete item.completedAt;
    }
  }
  function expenseCompletedSortTime(item) {
    if (item.completedAt) return item.completedAt;
    if (item.payments && item.payments.length) {
      return item.payments[item.payments.length - 1].date || '';
    }
    return item.date || '';
  }
  function expenseSortRank(item) {
    var status = expenseStatus(item);
    if (status === 'done') return 0;
    if (status === 'partial') return 1;
    return 2;
  }
  function sortExpensesForDisplay(list) {
    return list.slice().sort(function (a, b) {
      var ra = expenseSortRank(a);
      var rb = expenseSortRank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0) {
        return expenseCompletedSortTime(b).localeCompare(expenseCompletedSortTime(a));
      }
      return 0;
    });
  }
  function completedExpenseTotal(expenses) {
    var t = 0;
    for (var i = 0; i < expenses.length; i++) t += expensePaid(expenses[i]);
    return t;
  }
  function calcActualSpent(m) {
    return sum(m.savings, 'amount') + completedExpenseTotal(m.expenses);
  }
  function syncBudgetFromIncome(key) {
    var m = getMonth(key);
    state.data.budgetByMonth[key] = sum(m.income, 'amount');
  }

  /* ---------- Tab 与数据看板 ---------- */
  function setTab(tab) {
    state.activeTab = tab;
    $('planView').hidden = tab !== 'plan';
    $('dashView').hidden = tab !== 'home';
    var items = document.querySelectorAll('.tab-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].getAttribute('data-tab') === tab);
    }
    if (tab === 'home') renderDashboard();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function pct(part, whole) {
    return whole > 0 ? Math.round((part / whole) * 100) : 0;
  }
  function monthDataReadonly(key) {
    return state.data.months[key] || { income: [], savings: [], expenses: [] };
  }

  /* ---------- AI 开支建议 ---------- */
  var AI_PREFIX = 'bookkeeping_ai_advice';
  var aiState = { key: '', state: 'idle', advice: '', error: '', time: '', cached: false, stale: false };

  function aiStorageKey(bookId, key) { return AI_PREFIX + '_' + (bookId || '_none') + '_' + key; }
  function aiFingerprint(ov) {
    if (!ov) return '0';
    var parts = [ov.income, ov.saving, ov.spent, ov.planned, ov.budget];
    var ranked = ov.ranked || [];
    for (var i = 0; i < ranked.length; i++) {
      parts.push(ranked[i].name + ':' + ranked[i].paid);
      var segs = ranked[i].segments || [];
      for (var j = 0; j < segs.length; j++) parts.push((segs[j].label || '') + '=' + segs[j].amount);
    }
    var s = parts.join('|'), h = 5381;
    for (var k = 0; k < s.length; k++) h = ((h << 5) + h + s.charCodeAt(k)) | 0;
    return String(h >>> 0);
  }
  function aiGetCache(key) {
    try {
      var raw = localStorage.getItem(aiStorageKey(state.bookId, key));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function aiSetCache(key, obj) {
    try { localStorage.setItem(aiStorageKey(state.bookId, key), JSON.stringify(obj)); } catch (e) {}
  }
  function aiTimeText(iso) {
    try {
      var d = iso ? new Date(iso) : new Date();
      return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    } catch (e) { return ''; }
  }
  var AI_SYSTEM_PROMPT =
    '你是一位务实、亲切的家庭理财助手。用户会给你本月（按10号账单周期）的家庭收支数据和开支明细。' +
    '请用简体中文输出，总长度控制在300字以内，分成三个部分，每部分用方括号标题开头：\n' +
    '[开支概览] 用一两句话总结这个月钱主要花在哪、收支结构是否健康。\n' +
    '[可优化项] 结合开支明细和备注，指出可能不必要或偏高的开支，给出2-3条具体、可执行的省钱建议；如果开支都合理，就如实说明，不要硬找问题。\n' +
    '[下月预算建议] 基于本月情况，给出下个月主要开支项的预算参考或一个总预算区间，帮助用户做预算判断。\n' +
    '语气自然、不说教，不要编造数据中没有的信息。可以用 Markdown：重点数字或关键词用 **加粗**，多条建议用「- 」开头的列表，让结构更清晰。';
  function buildAiPrompt(key, ov) {
    var lines = [];
    lines.push('统计周期：' + key + '（每月10号到次月10号为一个账单周期）');
    lines.push('收入：' + fmt(ov.income));
    lines.push('储蓄：' + fmt(ov.saving));
    lines.push('已完成开支：' + fmt(ov.spent));
    lines.push('计划开支：' + fmt(ov.planned));
    if (ov.budget) lines.push('预算总额：' + fmt(ov.budget));
    lines.push('本期结余：' + fmt(ov.balance));
    lines.push('');
    lines.push('开支明细（按金额从高到低）：');
    var ranked = ov.ranked || [];
    if (!ranked.length) {
      lines.push('（本周期暂无已支出记录）');
    } else {
      for (var i = 0; i < ranked.length; i++) {
        var it = ranked[i];
        var line = (i + 1) + '. ' + (it.name || '未命名') + '：' + fmt(it.paid);
        var segs = (it.segments || []).filter(function (s) { return num(s.amount) > 0; });
        if (segs.length) {
          line += '（明细：' + segs.map(function (s) {
            return ((s.label || '').trim() || '未备注') + ' ' + fmt(s.amount);
          }).join('、') + '）';
        }
        lines.push(line);
      }
    }
    return lines.join('\n');
  }
  function fetchAiSummaryH5(key, ov) {
    var c = getConfig();
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 30000) : null;
    var url, headers, body, direct = false;
    if (c.zhipuApiKey) {
      direct = true;
      url = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
      headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.zhipuApiKey };
      body = JSON.stringify({
        model: c.zhipuModel || 'glm-4-flash',
        messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: buildAiPrompt(key, ov) }],
        temperature: 0.6, max_tokens: 800
      });
    } else {
      url = c.aiSummaryUrl || (c.supabaseUrl + '/functions/v1/ai-summary');
      headers = c.aiSummaryUrl ? { 'Content-Type': 'application/json' } : supabaseHeaders();
      body = JSON.stringify({ monthKey: key, overview: ov });
    }
    return fetch(url, {
      method: 'POST', headers: headers, body: body,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (direct) {
          var advice = data && data.choices && data.choices[0] && data.choices[0].message && (data.choices[0].message.content || '').trim();
          if (!res.ok || !advice) {
            throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
          }
          return { advice: advice, generatedAt: new Date().toISOString() };
        }
        if (!res.ok || !data || !data.advice) {
          throw new Error((data && data.error) || ('HTTP ' + res.status));
        }
        return data;
      });
    }).finally(function () { if (timer) clearTimeout(timer); });
  }
  function aiInlineMd(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }
  function aiMdToHtml(text) {
    var safe = escapeHtml(String(text || ''));
    var lines = safe.split(/\r?\n/);
    var html = '', listOpen = false;
    function closeList() { if (listOpen) { html += '</ul>'; listOpen = false; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (!ln) { closeList(); continue; }
      var li = ln.match(/^[-*]\s+(.*)$/) || ln.match(/^\d+[.、)]\s+(.*)$/);
      if (li) {
        if (!listOpen) { html += '<ul class="ai-list">'; listOpen = true; }
        html += '<li>' + aiInlineMd(li[1]) + '</li>';
        continue;
      }
      closeList();
      ln = ln.replace(/^#{1,6}\s+/, '');
      ln = ln.replace(/^\[([^\]]+)\]/, '<strong class="ai-h">$1</strong>');
      html += '<p>' + aiInlineMd(ln) + '</p>';
    }
    closeList();
    return html;
  }
  function streamAiSummaryH5(key, ov, onDelta) {
    var c = getConfig();
    if (!c.zhipuApiKey || typeof ReadableStream === 'undefined') {
      return fetchAiSummaryH5(key, ov).then(function (r) { return r.advice; });
    }
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 45000) : null;
    return fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.zhipuApiKey },
      body: JSON.stringify({
        model: c.zhipuModel || 'glm-4-flash',
        messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: buildAiPrompt(key, ov) }],
        temperature: 0.6, max_tokens: 800, stream: true
      }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res.json().catch(function () { return null; }).then(function (d) {
          throw new Error((d && d.error && d.error.message) || ('HTTP ' + res.status));
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var full = '', buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return full;
          buf += decoder.decode(r.value, { stream: true });
          var parts = buf.split('\n');
          buf = parts.pop();
          for (var i = 0; i < parts.length; i++) {
            var line = parts[i].trim();
            if (!line || line.indexOf('data:') !== 0) continue;
            var payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              var j = JSON.parse(payload);
              var delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (delta) { full += delta; if (onDelta) onDelta(full); }
            } catch (e) {}
          }
          return pump();
        });
      }
      return pump();
    }).finally(function () { if (timer) clearTimeout(timer); });
  }
  function renderAiStreaming(text) {
    var sec = document.querySelector('.ai-section');
    if (!sec) return;
    sec.innerHTML = '<div class="dash-title">AI 开支建议 <span class="dash-sub">GLM-4-Flash</span></div>' +
      '<div class="ai-advice">' + aiMdToHtml(text) + '<span class="ai-caret"></span></div>';
  }
  function aiCardHtml(ov, key) {
    var fp = aiFingerprint(ov);
    var s;
    if (aiState.key === key && (aiState.state === 'loading' || aiState.state === 'streaming' || aiState.state === 'done' || aiState.state === 'error')) {
      s = aiState;
    } else {
      var cache = aiGetCache(key);
      if (cache && cache.fingerprint === fp && cache.advice) {
        s = { state: 'done', advice: cache.advice, time: cache.time || '', cached: true, stale: false, error: '' };
      } else {
        s = { state: 'idle', advice: '', time: '', cached: false, error: '', stale: !!(cache && cache.advice) };
      }
      aiState = { key: key, state: s.state, advice: s.advice, error: s.error, time: s.time, cached: s.cached, stale: s.stale };
    }
    var inner;
    if (s.state === 'idle') {
      inner = (s.stale ? '<div class="ai-hint">开支有更新，可重新生成最新建议</div>' : '') +
        '<button class="ai-btn" id="aiGenBtn">生成 AI 建议</button>' +
        '<div class="ai-tip">根据本月开支明细，帮你分析可优化的开支并给出下月预算参考</div>';
    } else if (s.state === 'loading') {
      inner = '<div class="ai-loading"><i class="ai-spinner"></i><span>AI 正在分析本月开支…</span></div>';
    } else if (s.state === 'streaming') {
      inner = '<div class="ai-advice">' + aiMdToHtml(s.advice) + '<span class="ai-caret"></span></div>';
    } else if (s.state === 'done') {
      inner = '<div class="ai-advice">' + aiMdToHtml(s.advice) + '</div>' +
        '<div class="ai-foot"><span class="ai-time">' + (s.cached ? '上次生成 ' : '生成于 ') + escapeHtml(s.time) + '</span>' +
        '<span class="ai-regen" id="aiRegen">重新生成</span></div>';
    } else {
      inner = '<div class="ai-error">' + escapeHtml(s.error) + '</div>' +
        '<button class="ai-btn" id="aiGenBtn">重试</button>';
    }
    return '<section class="dash-section ai-section">' +
      '<div class="dash-title">AI 开支建议 <span class="dash-sub">GLM-4-Flash</span></div>' +
      inner + '</section>';
  }
  function genAdviceH5(force, ov, key) {
    if (!ov) return;
    if ((!ov.ranked || !ov.ranked.length) && ov.spent <= 0) {
      aiState = { key: key, state: 'error', advice: '', error: '本周期还没有开支记录，先记几笔再来生成建议吧', time: '', cached: false, stale: false };
      renderDashboard();
      return;
    }
    var fp = aiFingerprint(ov);
    if (!force) {
      var cache = aiGetCache(key);
      if (cache && cache.fingerprint === fp && cache.advice) {
        aiState = { key: key, state: 'done', advice: cache.advice, error: '', time: cache.time || '', cached: true, stale: false };
        renderDashboard();
        return;
      }
    }
    aiState = { key: key, state: 'loading', advice: '', error: '', time: '', cached: false, stale: false };
    renderDashboard();
    streamAiSummaryH5(key, ov, function (partial) {
      aiState = { key: key, state: 'streaming', advice: partial, error: '', time: '', cached: false, stale: false };
      renderAiStreaming(partial);
    }).then(function (advice) {
      advice = (typeof advice === 'string' ? advice : (advice && advice.advice) || '').trim();
      if (!advice) throw new Error('AI 未返回内容');
      var time = aiTimeText(new Date().toISOString());
      aiSetCache(key, { advice: advice, fingerprint: fp, time: time });
      aiState = { key: key, state: 'done', advice: advice, error: '', time: time, cached: false, stale: false };
      renderDashboard();
    }).catch(function (err) {
      var msg = (err && err.message) || '生成失败，请重试';
      if (err && err.name === 'AbortError') msg = '请求超时，AI 服务可能在当前网络下不稳定，请稍后重试';
      else if (/failed to fetch|networkerror|load failed|abort/i.test(msg)) msg = '网络连接失败，请检查网络后重试';
      aiState = { key: key, state: 'error', advice: '', error: msg, time: '', cached: false, stale: false };
      renderDashboard();
    });
  }

  function renderDashboard() {
    var view = $('dashView');
    if (!view) return;
    var key = monthKey(state.current);
    var year = state.current.getFullYear();
    var m = monthDataReadonly(key);

    var income = sum(m.income, 'amount');
    var saving = sum(m.savings, 'amount');
    var spent = completedExpenseTotal(m.expenses);
    var budget = num(state.data.budgetByMonth[key]);
    var actualSpent = saving + spent;
    var balance = income - actualSpent;
    var execPct = budget > 0 ? Math.min(100, Math.round((actualSpent / budget) * 100)) : 0;
    var execOver = budget > 0 && actualSpent > budget;

    var html = '';
    html += '<section class="dash-section">' +
      '<div class="dash-title">本月复盘 <span class="dash-sub">' + escapeHtml(cycleRangeText(state.current)) + '</span></div>' +
      '<div class="dash-stats">' +
        statCard('收入', income, 'income') +
        statCard('储蓄', saving, 'saving') +
        statCard('已花开支', spent, 'expense') +
        statCard('结余', balance, balance < 0 ? 'neg' : '') +
      '</div>' +
      '<div class="dash-progress">' +
        '<div class="dash-progress-head"><span>预算执行</span><span>' +
          fmt(actualSpent) + ' / ' + (budget > 0 ? fmt(budget) : '未设预算') + '</span></div>' +
        '<div class="dash-track"><div class="dash-fill' + (execOver ? ' over' : '') +
          '" style="width:' + execPct + '%"></div></div>' +
      '</div>' +
    '</section>';

    var ranked = [];
    for (var i = 0; i < m.expenses.length; i++) {
      var ex = m.expenses[i];
      var paid = expensePaid(ex);
      if (paid <= 0) continue;
      var segs = [];
      if (ex.payments && ex.payments.length) {
        for (var pi = 0; pi < ex.payments.length; pi++) {
          var pay = ex.payments[pi];
          var amt = num(pay.amount);
          if (amt > 0) {
            segs.push({
              label: (pay.note || '').trim(),
              amount: amt,
              timeText: formatPaymentTime(pay)
            });
          }
        }
      }
      ranked.push({ expenseId: ex.id, name: ex.name, paid: paid, segments: segs });
    }
    ranked.sort(function (a, b) { return b.paid - a.paid; });
    var maxPaid = ranked.length ? ranked[0].paid : 0;
    var SEG_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#ef4444', '#0ea5e9'];
    var rankHtml = '';
    if (ranked.length) {
      for (var r = 0; r < Math.min(ranked.length, 8); r++) {
        var it = ranked[r];
        var rsegs = it.segments || [];
        var detail = rsegs.length && (rsegs.length > 1 || rsegs[0].label);
        var fillInner = '';
        var chips = '';
        if (detail) {
          for (var s = 0; s < rsegs.length; s++) {
            var col = SEG_COLORS[s % SEG_COLORS.length];
            fillInner += '<i style="width:' + pct(rsegs[s].amount, it.paid) + '%;background:' + col + '"></i>';
            var lbl = rsegs[s].label ? escapeHtml(rsegs[s].label) : ('第' + (s + 1) + '笔');
            chips += '<span class="seg-chip"><i style="background:' + col + '"></i>' + lbl + ' ' + fmt(rsegs[s].amount) + '</span>';
          }
        } else {
          fillInner = '<i style="width:100%;background:var(--expense)"></i>';
        }
        rankHtml += '<div class="rank-row rank-row-clickable" data-expense-id="' + escapeHtml(it.expenseId) + '" role="button" tabindex="0">' +
          '<div class="rank-row-head"><span>' + escapeHtml(it.name) + '</span>' +
          '<span>' + fmt(it.paid) + ' <span class="pct">' + pct(it.paid, spent) + '%</span><span class="rank-chevron">›</span></span></div>' +
          '<div class="rank-bar"><div class="rank-fill-seg" style="width:' + Math.max(4, pct(it.paid, maxPaid)) + '%">' + fillInner + '</div></div>' +
          (chips ? '<div class="rank-segs">' + chips + '</div>' : '') +
        '</div>';
      }
    } else {
      rankHtml = '<div class="dash-empty">本月暂无开支记录</div>';
    }
    html += '<section class="dash-section">' +
      '<div class="dash-title">本月开支占比</div>' + rankHtml + '</section>';

    var planned = sum(m.expenses, 'plannedAmount');
    var ov = { income: income, saving: saving, spent: spent, planned: planned, budget: budget, balance: balance, ranked: ranked };
    html += aiCardHtml(ov, key);

    var months = [];
    var maxVal = 0;
    var ySumInc = 0, ySumSav = 0, ySumExp = 0, activeMonths = 0;
    for (var mo = 1; mo <= 12; mo++) {
      var md = monthDataReadonly(year + '-' + pad2(mo));
      var inc = sum(md.income, 'amount');
      var sav = sum(md.savings, 'amount');
      var exp = completedExpenseTotal(md.expenses);
      maxVal = Math.max(maxVal, inc, sav, exp);
      ySumInc += inc; ySumSav += sav; ySumExp += exp;
      if (inc || sav || exp) activeMonths++;
      months.push({ mo: mo, income: inc, saving: sav, expense: exp });
    }
    var barH = function (v) { return maxVal > 0 ? Math.max(2, Math.round((v / maxVal) * 100)) : 2; };
    var cols = '';
    for (var c = 0; c < months.length; c++) {
      var x = months[c];
      cols += '<div class="year-col"><div class="year-bars">' +
        '<i class="b-income" style="height:' + barH(x.income) + '%"></i>' +
        '<i class="b-saving" style="height:' + barH(x.saving) + '%"></i>' +
        '<i class="b-expense" style="height:' + barH(x.expense) + '%"></i>' +
        '</div><div class="m">' + x.mo + '</div></div>';
    }
    html += '<section class="dash-section">' +
      '<div class="dash-title">年度复盘 <span class="dash-sub">' + year + '</span></div>' +
      '<div class="year-chart">' + cols + '</div>' +
      '<div class="year-legend">' +
        '<span><i class="b-income"></i>收入</span>' +
        '<span><i class="b-saving"></i>储蓄</span>' +
        '<span><i class="b-expense"></i>开支</span>' +
      '</div>' +
    '</section>';

    var avgExp = activeMonths ? ySumExp / activeMonths : 0;
    html += '<section class="dash-section">' +
      '<div class="dash-title">年度汇总 <span class="dash-sub">' + activeMonths + ' 个月有记录</span></div>' +
      '<div class="dash-stats">' +
        statCard('总收入', ySumInc, 'income') +
        statCard('总储蓄', ySumSav, 'saving') +
        statCard('总开支', ySumExp, 'expense') +
        statCard('月均开支', avgExp, '') +
      '</div>' +
    '</section>';

    var yearRate = pct(ySumSav, ySumInc);
    var rateRows = '';
    for (var s = 0; s < months.length; s++) {
      var ym = months[s];
      if (!ym.income) continue;
      var rate = pct(ym.saving, ym.income);
      rateRows += '<div class="rank-row">' +
        '<div class="rank-row-head"><span>' + ym.mo + ' 月</span><span class="pct">' + rate + '%</span></div>' +
        '<div class="rank-bar"><i style="width:' + Math.min(100, rate) + '%;background:var(--saving)"></i></div>' +
      '</div>';
    }
    if (!rateRows) rateRows = '<div class="dash-empty">暂无收入记录</div>';
    html += '<section class="dash-section">' +
      '<div class="dash-title">储蓄率 <span class="dash-sub">年度 ' + yearRate + '%</span></div>' +
      rateRows + '</section>';

    view.innerHTML = html;

    var genBtn = view.querySelector('#aiGenBtn');
    if (genBtn) genBtn.addEventListener('click', function () { genAdviceH5(aiState.state === 'error', ov, key); });
    var regenBtn = view.querySelector('#aiRegen');
    if (regenBtn) regenBtn.addEventListener('click', function () { genAdviceH5(true, ov, key); });
    var rankRows = view.querySelectorAll('.rank-row-clickable[data-expense-id]');
    for (var ri = 0; ri < rankRows.length; ri++) {
      rankRows[ri].addEventListener('click', function () {
        openExpenseDetailDrawer(this.getAttribute('data-expense-id'));
      });
    }
  }

  function statCard(label, value, cls) {
    return '<div class="dash-stat"><div class="label">' + escapeHtml(label) + '</div>' +
      '<div class="value' + (cls ? ' ' + cls : '') + '">' + fmt(value) + '</div></div>';
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var key = monthKey(state.current);
    var m = getMonth(key);
    $('monthLabel').textContent = cycleRangeText(state.current);

    var incomeT = sum(m.income, 'amount');
    var savingT = sum(m.savings, 'amount');
    var plannedT = sum(m.expenses, 'plannedAmount');
    var expenseDone = completedExpenseTotal(m.expenses);
    var budget = num(state.data.budgetByMonth[key]);
    var budgetOut = savingT + plannedT;
    var actualSpent = calcActualSpent(m);
    var remain = budget - budgetOut;

    $('budgetValue').textContent = budget ? fmt(budget) : '¥0';
    $('budgetOutValue').textContent = fmt(budgetOut);
    $('actualSpentValue').textContent = fmt(actualSpent);
    $('remainValue').textContent = fmt(remain);
    $('remainValue').style.color = remain < 0 ? '#fecaca' : '#fff';

    var pct = budget > 0 ? Math.min(100, (budgetOut / budget) * 100) : 0;
    var fill = $('progressFill');
    fill.style.width = pct + '%';
    fill.classList.toggle('over', budget > 0 && budgetOut > budget);

    $('incomeTotal').textContent = fmt(incomeT);
    $('savingTotal').textContent = fmt(savingT);
    $('plannedTotal').textContent = fmt(plannedT);
    $('incomeSum').textContent = fmt(incomeT);
    $('savingSum').textContent = fmt(savingT);
    var expenseRemain = plannedT - expenseDone;
    $('expenseSum').textContent =
      '已花 ' + fmt(expenseDone) + ' / 计划 ' + fmt(plannedT) + ' / 还剩 ' + fmt(expenseRemain);

    renderSimpleList($('incomeList'), m.income, 'income');
    renderSimpleList($('savingList'), m.savings, 'savings');
    renderExpenseList($('expenseList'), m.expenses);
    updateBookBar();
    if (state.activeTab === 'home') renderDashboard();
  }

  function renderSimpleList(ul, list, type) {
    ul.innerHTML = '';
    var cls = type === 'income' ? 'income' : 'saving';
    list.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'row';
      li.innerHTML =
        '<div class="row-main">' +
        '<div class="row-name"></div>' +
        '<div class="row-meta"></div>' +
        '</div>' +
        '<div class="row-amount ' + cls + '"></div>';
      li.querySelector('.row-name').textContent = item.name;
      li.querySelector('.row-meta').textContent = item.date || '';
      li.querySelector('.row-amount').textContent = fmt(num(item.amount));
      li.addEventListener('click', function () { openEntry(type, item.id); });
      ul.appendChild(li);
    });
  }

  function renderExpenseList(ul, list) {
    ul.innerHTML = '';
    sortExpensesForDisplay(list).forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'row';

      var status = expenseStatus(item);
      var paid = expensePaid(item);
      var planned = num(item.plannedAmount);
      var remain = Math.max(0, planned - paid);

      var check = document.createElement('div');
      check.className = 'row-check' + (status === 'done' ? ' done' : (status === 'partial' ? ' partial' : ''));
      check.innerHTML = status === 'done' ? '&#10003;' : (status === 'partial' ? '·' : '');
      check.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleDone(item.id);
      });

      var main = document.createElement('div');
      main.className = 'row-main';
      var name = document.createElement('div');
      name.className = 'row-name' + (status === 'done' ? ' done' : '');
      name.textContent = item.name;
      var meta = document.createElement('div');
      meta.className = 'row-meta';
      var statusText = status === 'done' ? ' · 已完成' : (status === 'partial' ? ' · 部分支出' : ' · 待支出');
      meta.textContent = (item.date || '') + statusText;
      main.appendChild(name);
      main.appendChild(meta);
      var notesText = paymentNotesSummary(item);
      if (notesText) {
        var notesEl = document.createElement('div');
        notesEl.className = 'row-notes';
        notesEl.textContent = notesText;
        main.appendChild(notesEl);
      }

      var amount = document.createElement('div');
      amount.className = 'row-amount';
      if (status === 'pending') {
        amount.innerHTML = '<span class="pending">计划 ' + fmt(planned) + '</span>';
      } else if (status === 'partial') {
        var payCount = expensePaymentCount(item);
        amount.innerHTML = '<span class="partial-main">' + fmt(remain) + '</span>' +
          '<span class="sub">计划 ' + fmt(planned) + ' / 部分支出 ' + payCount + '笔</span>';
      } else {
        amount.innerHTML = fmt(paid) +
          '<span class="sub">计划 ' + fmt(planned) + ' / 已完成</span>';
      }

      li.appendChild(check);
      li.appendChild(main);
      if (status !== 'done') {
        var payBtn = document.createElement('button');
        payBtn.type = 'button';
        payBtn.className = 'row-pay-btn';
        payBtn.textContent = '记支出';
        payBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          openPaymentDrawer(item.id);
        });
        li.appendChild(payBtn);
      }
      li.appendChild(amount);
      li.addEventListener('click', function () { openEntry('expenses', item.id); });
      ul.appendChild(li);
    });
  }

  /* ---------- 明细 CRUD ---------- */
  function findItem(type, id) {
    var list = getMonth(monthKey(state.current))[type];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function toggleDone(id) {
    var item = findItem('expenses', id);
    if (!item) return;
    ensurePayments(item);
    var planned = num(item.plannedAmount);
    if (expenseStatus(item) === 'done') {
      while (item.payments.length && expensePaid(item) >= planned) {
        item.payments.pop();
      }
      item.done = false;
      delete item.completedAt;
      if (!item.payments.length) {
        delete item.payments;
        item.actualAmount = '';
      } else {
        item.actualAmount = expensePaid(item);
      }
      save();
      render();
      showToast('已取消完成');
      return;
    }
    var paid = expensePaid(item);
    var remainder = Math.max(0, planned - paid);
    if (remainder > 0) {
      item.payments.push({ id: uid(), amount: remainder, date: todayISO(), recordedAt: nowISO() });
    }
    refreshExpenseDone(item);
    item.actualAmount = expensePaid(item);
    save();
    render();
  }

  function syncExpenseSummary(item) {
    var summary = $('expenseSummary');
    if (!summary) return;
    if (!item) {
      summary.hidden = true;
      if ($('fPayment')) $('fPayment').value = '';
      return;
    }
    summary.hidden = false;
    var paid = expensePaid(item);
    var planned = num(item.plannedAmount);
    $('expensePaidText').textContent = fmt(paid);
    $('expenseRemainText').textContent = fmt(Math.max(0, planned - paid));
    if ($('fPayment')) $('fPayment').value = '';
  }

  function openPaymentDrawer(id) {
    var item = findItem('expenses', id);
    if (!item || expenseStatus(item) === 'done') return;
    state.payingExpenseId = id;
    var paid = expensePaid(item);
    var planned = num(item.plannedAmount);
    $('paymentTitle').textContent = '记支出 · ' + item.name;
    $('payPaidText').textContent = fmt(paid);
    $('payRemainText').textContent = fmt(Math.max(0, planned - paid));
    $('fPayAmount').value = '';
    $('fPayNote').value = '';
    $('fPayDate').value = todayISO();
    $('paymentMask').hidden = false;
    $('paymentDrawer').hidden = false;
    setTimeout(function () { $('fPayAmount').focus(); }, 280);
  }

  function closePaymentDrawer() {
    state.payingExpenseId = null;
    $('paymentMask').hidden = true;
    $('paymentDrawer').hidden = true;
  }

  function openExpenseDetailDrawer(expenseId) {
    var item = findItem('expenses', expenseId);
    if (!item) return;
    var planned = num(item.plannedAmount);
    var paid = expensePaid(item);
    var timeline = buildPaymentTimeline(item);
    $('expenseDetailTitle').textContent = item.name;
    $('expenseDetailPlanned').textContent = fmt(planned);
    $('expenseDetailPaid').textContent = fmt(paid);
    $('expenseDetailRemain').textContent = fmt(Math.max(0, planned - paid));
    var listEl = $('expenseDetailList');
    if (!timeline.length) {
      listEl.innerHTML = '<div class="expense-detail-empty">暂无支出记录</div>';
    } else {
      var rows = '';
      for (var i = 0; i < timeline.length; i++) {
        var row = timeline[i];
        rows += '<div class="expense-detail-row">' +
          '<div class="expense-detail-row-main">' +
            '<span class="expense-detail-amt">' + escapeHtml(row.amountText) + '</span>' +
            '<span class="expense-detail-note">' + escapeHtml(row.note) + '</span>' +
          '</div>' +
          '<div class="expense-detail-row-sub">' +
            '<span class="expense-detail-time">' + escapeHtml(row.timeText || '—') + '</span>' +
            '<span class="expense-detail-remain">剩余 ' + escapeHtml(row.remainText) + '</span>' +
          '</div>' +
        '</div>';
      }
      listEl.innerHTML = rows;
    }
    $('expenseDetailMask').hidden = false;
    $('expenseDetailDrawer').hidden = false;
  }

  function closeExpenseDetailDrawer() {
    $('expenseDetailMask').hidden = true;
    $('expenseDetailDrawer').hidden = true;
  }

  function submitPayment(e) {
    e.preventDefault();
    var id = state.payingExpenseId;
    if (!id) return;
    var item = findItem('expenses', id);
    if (!item) return;
    var amt = num($('fPayAmount').value);
    if (amt <= 0) {
      showToast('请输入本次支出金额');
      $('fPayAmount').focus();
      return;
    }
    ensurePayments(item);
    var pay = {
      id: uid(),
      amount: amt,
      date: $('fPayDate').value || todayISO(),
      recordedAt: nowISO()
    };
    var note = ($('fPayNote').value || '').trim();
    if (note) pay.note = note;
    item.payments.push(pay);
    refreshExpenseDone(item);
    item.actualAmount = expensePaid(item);
    save();
    render();
    closePaymentDrawer();
    showToast(expenseStatus(item) === 'done' ? '已完成全部支出' : '已记录部分支出');
  }

  /* ---------- 明细抽屉 ---------- */
  function openEntry(type, id) {
    state.editing = { type: type, id: id || null };
    var isExpense = type === 'expenses';
    var titleMap = { income: '收入', savings: '储蓄', expenses: '开支' };

    document.querySelectorAll('[data-mode="single"]').forEach(function (el) {
      el.hidden = isExpense;
    });
    document.querySelector('[data-mode="expense"]').hidden = !isExpense;

    $('drawerTitle').textContent = (id ? '编辑' : '添加') + titleMap[type];
    $('deleteBtn').hidden = !id;

    var item = id ? findItem(type, id) : null;
    $('fName').value = item ? item.name : '';
    $('fDate').value = item ? (item.date || todayISO()) : todayISO();

    if (isExpense) {
      $('fPlanned').value = item ? item.plannedAmount : '';
      syncExpenseSummary(item);
    } else {
      $('fAmount').value = item ? item.amount : '';
    }

    showDrawer('drawer', 'drawerMask');
    setTimeout(function () { $('fName').focus(); }, 280);
  }

  function submitEntry(e) {
    e.preventDefault();
    var ed = state.editing;
    if (!ed) return;
    var name = $('fName').value.trim();
    if (!name) { $('fName').focus(); return; }
    var date = $('fDate').value || todayISO();
    var list = getMonth(monthKey(state.current))[ed.type];
    var item = ed.id ? findItem(ed.type, ed.id) : null;

    if (ed.type === 'expenses') {
      var planned = num($('fPlanned').value);
      var paymentAmt = num($('fPayment').value);
      if (item) {
        item.name = name;
        item.date = date;
        item.plannedAmount = planned;
        ensurePayments(item);
        if (paymentAmt > 0) {
          item.payments.push({ id: uid(), amount: paymentAmt, date: date, recordedAt: nowISO() });
        }
        refreshExpenseDone(item);
        item.actualAmount = expensePaid(item);
      } else {
        var newItem = {
          id: uid(),
          name: name,
          plannedAmount: planned,
          date: date,
          payments: [],
          done: false,
          actualAmount: ''
        };
        if (paymentAmt > 0) {
          newItem.payments.push({ id: uid(), amount: paymentAmt, date: date, recordedAt: nowISO() });
        }
        refreshExpenseDone(newItem);
        newItem.actualAmount = expensePaid(newItem);
        list.push(newItem);
      }
    } else {
      var amount = num($('fAmount').value);
      if (item) {
        item.name = name; item.date = date; item.amount = amount;
      } else {
        list.push({ id: uid(), name: name, amount: amount, date: date });
      }
    }
    if (ed.type === 'income') {
      syncBudgetFromIncome(monthKey(state.current));
    }
    save();
    render();
    closeDrawers();
  }

  function deleteEntry() {
    var ed = state.editing;
    if (!ed || !ed.id) return;
    if (!confirm('确定删除这条记录？')) return;
    var list = getMonth(monthKey(state.current))[ed.type];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === ed.id) { list.splice(i, 1); break; }
    }
    if (ed.type === 'income') {
      syncBudgetFromIncome(monthKey(state.current));
    }
    save();
    render();
    closeDrawers();
  }

  /* ---------- 预算抽屉 ---------- */
  function openBudget() {
    var key = monthKey(state.current);
    $('fBudget').value = state.data.budgetByMonth[key] || '';
    showDrawer('budgetDrawer', 'budgetMask');
    setTimeout(function () { $('fBudget').focus(); }, 280);
  }
  function submitBudget(e) {
    e.preventDefault();
    var key = monthKey(state.current);
    state.data.budgetByMonth[key] = num($('fBudget').value);
    save();
    render();
    closeDrawers();
  }

  /* ---------- 抽屉显隐 ---------- */
  function showDrawer(drawerId, maskId) {
    $(maskId).hidden = false;
    $(drawerId).hidden = false;
  }
  function closeDrawers() {
    ['drawer', 'drawerMask', 'budgetDrawer', 'budgetMask'].forEach(function (id) {
      $(id).hidden = true;
    });
    state.editing = null;
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('prevMonth').addEventListener('click', function () {
      state.current.setMonth(state.current.getMonth() - 1);
      render();
    });
    $('nextMonth').addEventListener('click', function () {
      state.current.setMonth(state.current.getMonth() + 1);
      render();
    });
    $('monthLabel').addEventListener('click', function () {
      var input = prompt('跳转到周期开始月（格式 YYYY-MM，如 2026-06 表示 6/10 起）', monthKey(state.current));
      if (!input) return;
      var match = /^(\d{4})-(\d{1,2})$/.exec(input.trim());
      if (!match) { showToast('格式应为 YYYY-MM'); return; }
      var mm = parseInt(match[2], 10);
      if (mm < 1 || mm > 12) { showToast('月份应在 1-12 之间'); return; }
      state.current = new Date(parseInt(match[1], 10), mm - 1, 1);
      render();
    });

    document.querySelectorAll('[data-add]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openEntry(btn.getAttribute('data-add'), null);
      });
    });

    $('editBudgetBtn').addEventListener('click', openBudget);

    $('entryForm').addEventListener('submit', submitEntry);
    $('cancelBtn').addEventListener('click', closeDrawers);
    $('deleteBtn').addEventListener('click', deleteEntry);

    $('budgetForm').addEventListener('submit', submitBudget);
    $('budgetCancelBtn').addEventListener('click', closeDrawers);

    $('drawerMask').addEventListener('click', closeDrawers);
    $('budgetMask').addEventListener('click', closeDrawers);

    $('paymentForm').addEventListener('submit', submitPayment);
    $('paymentCancelBtn').addEventListener('click', closePaymentDrawer);
    $('paymentMask').addEventListener('click', closePaymentDrawer);

    $('expenseDetailCloseBtn').addEventListener('click', closeExpenseDetailDrawer);
    $('expenseDetailMask').addEventListener('click', closeExpenseDetailDrawer);

    $('syncRetryBtn').addEventListener('click', retrySync);
    $('shareBookBtn').addEventListener('click', openShareDrawer);
    $('copyShareBtn').addEventListener('click', doCopyShare);
    $('closeShareBtn').addEventListener('click', closeShareDrawer);
    $('shareMask').addEventListener('click', closeShareDrawer);
    $('switchBookBtn').addEventListener('click', function () { openBookSetup(false); });
    $('createBookBtn').addEventListener('click', function () {
      joinBook(newBookId());
    });
    $('bookForm').addEventListener('submit', function (e) {
      e.preventDefault();
      joinBook($('fBookId').value);
    });
    $('bookMask').addEventListener('click', closeBookSetup);

    document.querySelectorAll('.tab-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setTab(btn.getAttribute('data-tab'));
      });
    });
  }

  /* ---------- 启动 ---------- */
  function init() {
    bind();
    state.current = cycleAnchor(new Date());
    setTab(state.activeTab);

    var urlBook = resolveBookIdFromUrl();
    var savedBook = normalizeBookId(localStorage.getItem(BOOK_ID_KEY));
    state.bookId = urlBook || savedBook;
    if (state.bookId) {
      setBookId(state.bookId);
      pullFromCloud(false, !!urlBook).then(function () {
        render();
        startCloudSync();
      });
    } else if (cloudEnabled()) {
      joinBook(newBookId()).then(function () {
        showToast('已创建家庭账本，开始记账吧');
      });
    } else {
      render();
    }
  }

  init();
})();
