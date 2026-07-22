/* ============================================
   月度记账本 — 逻辑层（vanilla JS，无框架）
   本地 localStorage + 可选 Supabase 多人共享
   预算口径：预算总额=收入；预算支出=储蓄+开支(计划)；已支出=勾选完成的开支+储蓄；还剩=预算总额-预算支出
   ============================================ */
(function () {
  'use strict';

  var BOOK_ID_KEY = 'bookkeeping_book_id';
  var MEMBER_PROFILE_KEY = 'bookkeeping_member_profile';
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
  var EXPENSE_CATEGORIES = [
    { id: 'food', name: '餐饮' },
    { id: 'housing', name: '住房' },
    { id: 'transport', name: '交通' },
    { id: 'daily', name: '日用' },
    { id: 'medical', name: '医疗' },
    { id: 'education', name: '教育' },
    { id: 'children', name: '育儿' },
    { id: 'entertainment', name: '娱乐' },
    { id: 'social', name: '人情' },
    { id: 'other', name: '其他' }
  ];
  function normalizeCategoryId(id) {
    for (var i = 0; i < EXPENSE_CATEGORIES.length; i++) {
      if (EXPENSE_CATEGORIES[i].id === id) return id;
    }
    return 'other';
  }
  function categoryName(id) {
    id = normalizeCategoryId(id);
    for (var i = 0; i < EXPENSE_CATEGORIES.length; i++) {
      if (EXPENSE_CATEGORIES[i].id === id) return EXPENSE_CATEGORIES[i].name;
    }
    return '其他';
  }
  function categoryOptions(selected) {
    selected = normalizeCategoryId(selected);
    return EXPENSE_CATEGORIES.map(function (item) {
      return '<option value="' + item.id + '"' + (item.id === selected ? ' selected' : '') + '>' +
        item.name + '</option>';
    }).join('');
  }
  function stableId(value) {
    var h = 2166136261;
    value = String(value || '');
    for (var i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return 'carry_' + (h >>> 0).toString(36);
  }
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
        paymentId: p.id,
        amount: amt,
        amountText: fmt(amt),
        rawNote: (p.note || '').trim(),
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
    return {
      members: {},
      budgetByMonth: {},
      budgetUpdatedAt: {},
      deletedRecords: {},
      months: {}
    };
  }
  function normalizeData(data) {
    data = data && typeof data === 'object' ? data : emptyData();
    if (!data.members) data.members = {};
    if (!data.budgetByMonth) data.budgetByMonth = {};
    if (!data.budgetUpdatedAt) data.budgetUpdatedAt = {};
    if (!data.deletedRecords) data.deletedRecords = {};
    if (!data.months) data.months = {};
    return data;
  }
  function recordTime(item) {
    return (item && (item.updatedAt || item.recordedAt || item.completedAt || item.date)) || '';
  }
  function mergeList(remote, local, deleted, isExpense) {
    var map = {};
    var order = [];
    function add(item, preferLocal) {
      if (!item || !item.id) return;
      if (!map[item.id]) order.push(item.id);
      var existing = map[item.id];
      if (!existing || recordTime(item) > recordTime(existing) ||
          (preferLocal && recordTime(item) === recordTime(existing))) {
        map[item.id] = JSON.parse(JSON.stringify(item));
      }
      if (isExpense && existing) {
        map[item.id].payments = mergeList(
          existing.payments || [],
          item.payments || [],
          deleted,
          false
        );
      }
    }
    (remote || []).forEach(function (item) { add(item, false); });
    (local || []).forEach(function (item) { add(item, true); });
    return order.map(function (id) { return map[id]; }).filter(function (item) {
      var deletedAt = deleted[item.id] || '';
      return !deletedAt || deletedAt < recordTime(item);
    });
  }
  function mergeLedgerData(remoteData, localData) {
    var remote = normalizeData(JSON.parse(JSON.stringify(remoteData || emptyData())));
    var local = normalizeData(JSON.parse(JSON.stringify(localData || emptyData())));
    var out = emptyData();
    Object.keys(remote.members).forEach(function (id) { out.members[id] = remote.members[id]; });
    Object.keys(local.members).forEach(function (id) { out.members[id] = local.members[id]; });
    Object.keys(remote.deletedRecords).forEach(function (id) { out.deletedRecords[id] = remote.deletedRecords[id]; });
    Object.keys(local.deletedRecords).forEach(function (id) {
      if (!out.deletedRecords[id] || local.deletedRecords[id] > out.deletedRecords[id]) {
        out.deletedRecords[id] = local.deletedRecords[id];
      }
    });
    var budgetKeys = {};
    Object.keys(remote.budgetByMonth).forEach(function (key) { budgetKeys[key] = true; });
    Object.keys(local.budgetByMonth).forEach(function (key) { budgetKeys[key] = true; });
    Object.keys(budgetKeys).forEach(function (key) {
      var rt = remote.budgetUpdatedAt[key] || '';
      var lt = local.budgetUpdatedAt[key] || '';
      var hasRemote = Object.prototype.hasOwnProperty.call(remote.budgetByMonth, key);
      var hasLocal = Object.prototype.hasOwnProperty.call(local.budgetByMonth, key);
      var source = !hasLocal ? remote : (!hasRemote ? local : (lt >= rt ? local : remote));
      out.budgetByMonth[key] = source.budgetByMonth[key];
      out.budgetUpdatedAt[key] = lt >= rt ? lt : rt;
    });
    var monthKeys = {};
    Object.keys(remote.months).forEach(function (key) { monthKeys[key] = true; });
    Object.keys(local.months).forEach(function (key) { monthKeys[key] = true; });
    Object.keys(monthKeys).forEach(function (key) {
      var rm = remote.months[key] || emptyMonth();
      var lm = local.months[key] || emptyMonth();
      out.months[key] = {
        income: mergeList(rm.income, lm.income, out.deletedRecords, false),
        savings: mergeList(rm.savings, lm.savings, out.deletedRecords, false),
        expenses: mergeList(rm.expenses, lm.expenses, out.deletedRecords, true)
      };
    });
    return normalizeData(out);
  }
  function touchRecord(item) {
    if (item) item.updatedAt = nowISO();
  }
  function markDeleted(id) {
    if (!id) return;
    normalizeData(state.data).deletedRecords[id] = nowISO();
  }
  function touchBudget(key) {
    normalizeData(state.data).budgetUpdatedAt[key] = nowISO();
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
      return normalizeData(JSON.parse(raw));
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
  function shiftedCycleDate(dateValue, targetKey) {
    var day = CYCLE_START_DAY;
    var match = /^\d{4}-\d{2}-(\d{2})$/.exec(dateValue || '');
    if (match) day = parseInt(match[1], 10) || CYCLE_START_DAY;
    var parts = targetKey.split('-');
    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10) - 1;
    var lastDay = new Date(year, month + 1, 0).getDate();
    return year + '-' + pad2(month + 1) + '-' + pad2(Math.min(day, lastDay));
  }
  function ensureFixedPlansForKey(key) {
    if (!/^\d{4}-\d{2}$/.test(key || '')) return false;
    var targetParts = key.split('-');
    var targetDate = new Date(parseInt(targetParts[0], 10), parseInt(targetParts[1], 10) - 1, 1);
    var previousKey = monthKey(new Date(targetDate.getFullYear(), targetDate.getMonth() - 1, 1));
    var previous = state.data.months[previousKey];
    if (!previous || !previous.expenses) return false;
    var target = getMonth(key);
    var changed = false;
    previous.expenses.forEach(function (source) {
      if (!source.isFixed || source.source === 'quick') return;
      var seriesId = source.fixedSeriesId || ('fixed_' + source.id);
      if (!source.fixedSeriesId) {
        source.fixedSeriesId = seriesId;
        touchRecord(source);
        changed = true;
      }
      var carriedId = stableId(seriesId + '|' + key);
      if (state.data.deletedRecords && state.data.deletedRecords[carriedId]) return;
      var exists = target.expenses.some(function (item) {
        return item.id === carriedId || (item.fixedSeriesId === seriesId && item.carriedFromId === source.id);
      });
      if (exists) return;
      target.expenses.push({
        id: carriedId,
        name: source.name,
        categoryId: normalizeCategoryId(source.categoryId),
        plannedAmount: num(source.plannedAmount),
        date: shiftedCycleDate(source.date, key),
        isFixed: true,
        fixedSeriesId: seriesId,
        carriedFromId: source.id,
        payments: [],
        done: false,
        actualAmount: '',
        updatedAt: nowISO()
      });
      changed = true;
    });
    return changed;
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
      var before = JSON.stringify(state.data);
      var remoteChanged = JSON.stringify(normalizeData(row.data)) !== before;
      state.data = mergeLedgerData(row.data, state.data);
      saveLocal();
      localStorage.setItem(syncStorageKey(state.bookId), row.updated_at);
      hideSyncError();
      if (state.localDirty && remoteChanged && Date.now() - state.lastConflictNotice > 8000) {
        state.lastConflictNotice = Date.now();
        showToast('检测到家人同时更新，已自动合并双方记录', 3200);
      }
      return before !== JSON.stringify(state.data);
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
    syncMergedData()
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

  function syncMergedData() {
    if (!cloudEnabled() || !state.bookId) return Promise.resolve(false);
    var revision = state.saveRevision;
    return cloudFetch(state.bookId).then(function (row) {
      if (row && row.data) state.data = mergeLedgerData(row.data, state.data);
      saveLocal();
      return cloudPush(state.bookId, state.data).then(function () {
        if (revision === state.saveRevision) state.localDirty = false;
        hideSyncError();
        return true;
      });
    });
  }

  function save() {
    saveLocal();
    state.localDirty = true;
    state.saveRevision += 1;
    if (cloudEnabled() && state.bookId) {
      setSyncStatus('syncing');
      state.savePromise = (state.savePromise || Promise.resolve())
        .catch(function () {})
        .then(syncMergedData)
        .then(function () {
          render();
          setSyncStatus(state.realtimeReady ? 'live' : 'ok');
        })
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
  function getMemberProfile() {
    if (state.memberProfile) return state.memberProfile;
    try {
      var raw = localStorage.getItem(MEMBER_PROFILE_KEY);
      state.memberProfile = raw ? JSON.parse(raw) : null;
    } catch (e) {
      state.memberProfile = null;
    }
    return state.memberProfile;
  }
  function currentMemberFields() {
    var profile = getMemberProfile();
    return profile ? { memberId: profile.memberId, memberName: profile.name } : {};
  }
  function registerMember(profile) {
    if (!profile || !state.bookId) return;
    normalizeData(state.data).members[profile.memberId] = {
      name: profile.name,
      color: profile.color,
      createdAt: profile.createdAt || nowISO()
    };
  }
  function openMemberDrawer(force) {
    var profile = getMemberProfile();
    $('fMemberName').value = profile ? profile.name : '';
    state.memberColor = profile ? profile.color : '#6366f1';
    var colors = document.querySelectorAll('.member-color');
    for (var i = 0; i < colors.length; i++) {
      colors[i].classList.toggle('active', colors[i].getAttribute('data-color') === state.memberColor);
    }
    $('memberDrawer').dataset.force = force ? '1' : '';
    $('memberMask').hidden = false;
    $('memberDrawer').hidden = false;
    setTimeout(function () { $('fMemberName').focus(); }, 220);
  }
  function closeMemberDrawer() {
    if ($('memberDrawer').dataset.force === '1' && !getMemberProfile()) return;
    $('memberMask').hidden = true;
    $('memberDrawer').hidden = true;
  }
  function submitMember(e) {
    e.preventDefault();
    var name = ($('fMemberName').value || '').trim();
    if (!name) {
      showToast('请输入成员名称');
      $('fMemberName').focus();
      return;
    }
    var old = getMemberProfile();
    var profile = {
      memberId: old && old.memberId ? old.memberId : ('member_' + uid()),
      name: name,
      color: state.memberColor || '#6366f1',
      createdAt: old && old.createdAt ? old.createdAt : nowISO()
    };
    state.memberProfile = profile;
    localStorage.setItem(MEMBER_PROFILE_KEY, JSON.stringify(profile));
    registerMember(profile);
    save();
    updateBookBar();
    $('memberDrawer').dataset.force = '';
    closeMemberDrawer();
    showToast('成员身份已保存');
    var next = state.memberNext;
    state.memberNext = null;
    if (typeof next === 'function') next();
  }
  function ensureMember(next) {
    var profile = getMemberProfile();
    if (profile) {
      registerMember(profile);
      return true;
    }
    state.memberNext = next || null;
    openMemberDrawer(true);
    return false;
  }
  function updateBookBar() {
    var bar = $('bookBar');
    if (!cloudEnabled()) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    $('bookIdDisplay').textContent = state.bookId || '未加入';
    var profile = getMemberProfile();
    if ($('memberBookBtn')) $('memberBookBtn').textContent = profile ? profile.name : '设置成员';
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
    activeTab: 'home',
    memberProfile: null,
    memberColor: '#6366f1',
    memberNext: null,
    savePromise: Promise.resolve(),
    quickUndo: null,
    quickUndoTimer: null,
    aiBudgetUndo: null,
    metricContext: null,
    localDirty: false,
    saveRevision: 0,
    lastConflictNotice: 0
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
      if (amt > 0) {
        arr.push({
          id: 'legacy_' + item.id,
          amount: amt,
          date: item.date || todayISO(),
          recordedAt: item.completedAt || '',
          updatedAt: item.updatedAt || item.completedAt || ''
        });
      }
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
  function quickExpenseTotal(expenses) {
    var t = 0;
    for (var i = 0; i < (expenses || []).length; i++) {
      if (expenses[i].source === 'quick') t += expensePaid(expenses[i]);
    }
    return t;
  }
  function historicalQuickDaily(current) {
    var quickTotal = 0;
    var dayTotal = 0;
    for (var offset = 1; offset <= 3; offset++) {
      var d = new Date(current.getFullYear(), current.getMonth() - offset, 1);
      var month = state.data.months && state.data.months[monthKey(d)];
      if (!month || !(month.expenses || []).some(function (item) { return item.source === 'quick'; })) continue;
      quickTotal += quickExpenseTotal(month.expenses);
      dayTotal += Math.round((
        new Date(d.getFullYear(), d.getMonth() + 1, CYCLE_START_DAY) -
        new Date(d.getFullYear(), d.getMonth(), CYCLE_START_DAY)
      ) / (24 * 60 * 60 * 1000));
    }
    return { hasData: dayTotal > 0, daily: dayTotal > 0 ? quickTotal / dayTotal : 0 };
  }
  function forecastExpenses(current, expenses, elapsedDays, remainingDays) {
    var fixedExpected = 0;
    var fixedPlanned = 0;
    var fixedPaid = 0;
    var fixedRemaining = 0;
    var quickSpent = 0;
    for (var i = 0; i < (expenses || []).length; i++) {
      var item = expenses[i];
      var paid = expensePaid(item);
      if (item.source === 'quick') {
        quickSpent += paid;
      } else {
        var planned = num(item.plannedAmount);
        fixedPlanned += planned;
        fixedPaid += paid;
        fixedExpected += Math.max(planned, paid);
        fixedRemaining += Math.max(planned - paid, 0);
      }
    }

    var history = historicalQuickDaily(current);
    var currentDaily = elapsedDays > 0 ? quickSpent / elapsedDays : 0;
    var quickDaily = history.hasData
      ? (quickSpent + history.daily * 7) / (elapsedDays + 7)
      : currentDaily;
    var quickRemaining = quickDaily * remainingDays;

    return {
      fixedExpected: fixedExpected,
      fixedPlanned: fixedPlanned,
      fixedPaid: fixedPaid,
      fixedRemaining: fixedRemaining,
      quickSpent: quickSpent,
      quickDaily: quickDaily,
      quickRemaining: quickRemaining,
      total: fixedExpected + quickSpent + quickRemaining,
      remaining: fixedRemaining + quickRemaining
    };
  }
  function calcActualSpent(m) {
    return sum(m.savings, 'amount') + completedExpenseTotal(m.expenses);
  }
  function syncBudgetFromIncome(key) {
    var m = getMonth(key);
    state.data.budgetByMonth[key] = sum(m.income, 'amount');
    touchBudget(key);
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
  function cycleMetrics(current, spent, budget, expenses) {
    var start = new Date(current.getFullYear(), current.getMonth(), CYCLE_START_DAY);
    var end = new Date(current.getFullYear(), current.getMonth() + 1, CYCLE_START_DAY);
    var today = new Date();
    var dayMs = 24 * 60 * 60 * 1000;
    var totalDays = Math.round((end - start) / dayMs);
    var elapsedDays = today <= start ? 0 : (today >= end ? totalDays : Math.max(1, Math.ceil((today - start) / dayMs)));
    var remainingDays = today >= end ? 0 : (today <= start ? totalDays : Math.max(0, Math.ceil((end - today) / dayMs)));
    var remainingBudget = budget - spent;
    var prediction = forecastExpenses(current, expenses, elapsedDays, remainingDays);
    var availableDaily = remainingDays > 0 ? Math.max(0, remainingBudget) / remainingDays : 0;
    var dailyAvailable = remainingDays > 0
      ? Math.max(0, remainingBudget - prediction.fixedRemaining) / remainingDays
      : 0;
    var projectedBalance = remainingBudget - prediction.fixedRemaining;
    var risk = {
      level: 'safe',
      label: '余额够用',
      note: '付完计划后剩余 ' + fmt(Math.max(0, projectedBalance))
    };
    if (budget <= 0) {
      risk = { level: 'neutral', label: '未设预算', note: '设置预算后可判断超支风险' };
    } else if (projectedBalance < 0) {
      risk = { level: 'high', label: '余额不足', note: '固定待付仍差 ' + fmt(Math.abs(projectedBalance)) };
    } else if (remainingBudget > 0 && projectedBalance < remainingBudget * 0.1) {
      risk = { level: 'watch', label: '需要关注', note: '付完计划后仅剩 ' + fmt(projectedBalance) };
    }
    return {
      totalDays: totalDays,
      elapsedDays: elapsedDays,
      remainingDays: remainingDays,
      remainingBudget: remainingBudget,
      availableDaily: availableDaily,
      dailyAvailable: dailyAvailable,
      forecast: prediction.total,
      forecastRemaining: prediction.remaining,
      fixedPlanned: prediction.fixedPlanned,
      fixedPaid: prediction.fixedPaid,
      fixedRemaining: prediction.fixedRemaining,
      projectedBalance: projectedBalance,
      risk: risk
    };
  }
  function metricBreakdown(key) {
    var c = state.metricContext;
    if (!c) return null;
    var rows = [];
    var result = { title: '计算明细', formula: '', rows: rows, note: '' };
    if (key === 'remainingBudget') {
      result.title = '本周期可用余额';
      result.formula = '预算总额 − 储蓄 − 已花';
      rows.push(['预算总额', fmt(c.budget)], ['减：储蓄', fmt(c.saving)], ['减：已花', fmt(c.spent)], ['结果', fmt(c.forecast.remainingBudget)]);
      result.note = '储蓄会从可消费余额中预留，但不计入“已花”。';
    } else if (key === 'budgetUsed') {
      result.title = '预算已用';
      result.formula = '（储蓄 + 已花）÷ 预算总额';
      rows.push(['储蓄 + 已花', fmt(c.actualSpent)], ['预算总额', fmt(c.budget)], ['结果', c.execPct + '%']);
    } else if (key === 'safeDaily') {
      result.title = '安全日额度';
      result.formula = '（可用余额 − 计划待付）÷ 剩余天数';
      rows.push(['可用余额', fmt(c.forecast.remainingBudget)], ['减：计划待付', fmt(c.forecast.fixedRemaining)], ['剩余天数', c.forecast.remainingDays + ' 天'], ['结果', fmt(c.forecast.dailyAvailable) + ' / 天']);
      result.note = '先为尚未支付的计划开支留足金额，再计算每天可以安心使用的额度。';
    } else if (key === 'averageDaily') {
      result.title = '平均每日余额';
      result.formula = '可用余额 ÷ 剩余天数';
      rows.push(['可用余额', fmt(c.forecast.remainingBudget)], ['剩余天数', c.forecast.remainingDays + ' 天'], ['结果', fmt(c.forecast.availableDaily) + ' / 天']);
      result.note = '这是未预留计划待付的平均数，不建议直接当作每天消费上限。';
    } else if (key === 'risk') {
      result.title = '余额风险判断';
      result.formula = '可用余额 − 计划待付';
      rows.push(['可用余额', fmt(c.forecast.remainingBudget)], ['计划待付', fmt(c.forecast.fixedRemaining)], ['安全余量', fmt(c.forecast.projectedBalance)], ['判断', c.forecast.risk.label]);
    } else if (key === 'budgetTotal') {
      result.title = '预算总额';
      result.formula = '本周期收入合计';
      rows.push(['收入合计', fmt(c.income)], ['预算总额', fmt(c.budget)]);
    } else if (key === 'budgetOut') {
      result.title = '预算支出';
      result.formula = '储蓄 + 计划开支';
      rows.push(['储蓄', fmt(c.saving)], ['计划开支', fmt(c.planned)], ['结果', fmt(c.saving + c.planned)]);
    } else if (key === 'actualSpent') {
      result.title = '已支出';
      result.formula = '储蓄 + 已支付开支';
      rows.push(['储蓄', fmt(c.saving)], ['已支付开支', fmt(c.spent)], ['结果', fmt(c.actualSpent)]);
    } else if (key === 'planRemaining') {
      result.title = '计划剩余';
      result.formula = '预算总额 − 储蓄 − 计划开支';
      rows.push(['预算总额', fmt(c.budget)], ['减：储蓄', fmt(c.saving)], ['减：计划开支', fmt(c.planned)], ['结果', fmt(c.budget - c.saving - c.planned)]);
    } else {
      return null;
    }
    return result;
  }
  function openMetricDetail(key) {
    var detail = metricBreakdown(key);
    if (!detail) return;
    $('metricDetailTitle').textContent = detail.title;
    $('metricDetailFormula').textContent = detail.formula;
    $('metricDetailLines').innerHTML = detail.rows.map(function (row, index) {
      return '<div class="metric-detail-row' + (index === detail.rows.length - 1 ? ' total' : '') + '">' +
        '<span>' + escapeHtml(row[0]) + '</span><b>' + escapeHtml(row[1]) + '</b></div>';
    }).join('');
    $('metricDetailNote').textContent = detail.note || '';
    $('metricDetailNote').hidden = !detail.note;
    showDrawer('metricDetailDrawer', 'metricDetailMask');
  }
  function closeMetricDetail() {
    $('metricDetailMask').hidden = true;
    $('metricDetailDrawer').hidden = true;
  }
  function recentFamilyPayments(expenses) {
    var rows = [];
    (expenses || []).forEach(function (expense) {
      (expense.payments || []).forEach(function (payment) {
        if (num(payment.amount) <= 0) return;
        rows.push({
          expenseId: expense.id,
          amount: num(payment.amount),
          note: (payment.note || expense.name || '未备注').trim(),
          memberName: payment.memberName || '未标注',
          timeText: formatPaymentTime(payment),
          sortAt: payment.recordedAt || payment.date || ''
        });
      });
    });
    return rows.sort(function (a, b) { return a.sortAt < b.sortAt ? 1 : -1; }).slice(0, 5);
  }
  function categoryStats(expenses) {
    var map = {};
    EXPENSE_CATEGORIES.forEach(function (category) {
      map[category.id] = { id: category.id, name: category.name, amount: 0, count: 0 };
    });
    (expenses || []).forEach(function (expense) {
      var fallback = normalizeCategoryId(expense.categoryId);
      var payments = expense.payments || [];
      if (!payments.length && expensePaid(expense) > 0) {
        map[fallback].amount += expensePaid(expense);
        map[fallback].count += 1;
      }
      payments.forEach(function (payment) {
        var amount = num(payment.amount);
        if (amount <= 0) return;
        var categoryId = normalizeCategoryId(payment.categoryId || fallback);
        map[categoryId].amount += amount;
        map[categoryId].count += 1;
      });
    });
    return Object.keys(map).map(function (id) { return map[id]; })
      .filter(function (item) { return item.amount > 0; })
      .sort(function (a, b) { return b.amount - a.amount; });
  }
  function memberStats(expenses) {
    var map = {};
    (expenses || []).forEach(function (expense) {
      var payments = expense.payments || [];
      if (!payments.length && expensePaid(expense) > 0) {
        var legacyAmount = expensePaid(expense);
        if (!map._unknown) map._unknown = { id: '_unknown', name: '未标注', amount: 0, count: 0 };
        map._unknown.amount += legacyAmount;
        map._unknown.count += 1;
      }
      payments.forEach(function (payment) {
        var amount = num(payment.amount);
        if (amount <= 0) return;
        var id = payment.memberId || '_unknown';
        if (!map[id]) map[id] = { id: id, name: payment.memberName || '未标注', amount: 0, count: 0 };
        map[id].amount += amount;
        map[id].count += 1;
      });
    });
    return Object.keys(map).map(function (id) { return map[id]; })
      .sort(function (a, b) { return b.amount - a.amount; });
  }
  function categoryHistoryAverage(current) {
    var totals = {};
    var periods = 0;
    for (var offset = 1; offset <= 3; offset++) {
      var d = new Date(current.getFullYear(), current.getMonth() - offset, 1);
      var month = state.data.months && state.data.months[monthKey(d)];
      if (!month) continue;
      periods += 1;
      categoryStats(month.expenses).forEach(function (item) {
        totals[item.id] = (totals[item.id] || 0) + item.amount;
      });
    }
    Object.keys(totals).forEach(function (id) { totals[id] = periods ? totals[id] / periods : 0; });
    return { periods: periods, totals: totals };
  }
  function buildActionInsights(current, expenses, actualSpent, budget, forecast, categories) {
    var insights = [];
    var fixedPending = 0;
    var fixedAmount = 0;
    (expenses || []).forEach(function (item) {
      var remaining = Math.max(0, num(item.plannedAmount) - expensePaid(item));
      if (item.isFixed && remaining > 0) {
        fixedPending += 1;
        fixedAmount += remaining;
      }
    });
    if (forecast.projectedBalance < 0) {
      insights.push({ level: 'high', title: '计划待付存在缺口', note: '付完计划后还差 ' + fmt(Math.abs(forecast.projectedBalance)), target: 'plan' });
    } else if (fixedPending > 0) {
      insights.push({ level: 'info', title: fixedPending + ' 项固定开支待付', note: '合计还需支付 ' + fmt(fixedAmount), target: 'plan' });
    }
    var timePct = forecast.totalDays > 0 ? Math.round((forecast.elapsedDays / forecast.totalDays) * 100) : 0;
    var spendPct = budget > 0 ? Math.round((actualSpent / budget) * 100) : 0;
    if (budget > 0 && spendPct > timePct + 10) {
      insights.push({ level: 'watch', title: '支出进度偏快', note: '周期过了 ' + timePct + '%，预算已用 ' + spendPct + '%', target: 'home' });
    }
    var history = categoryHistoryAverage(current);
    if (history.periods > 0) {
      for (var i = 0; i < categories.length; i++) {
        var avg = history.totals[categories[i].id] || 0;
        if (categories[i].amount >= 100 && avg > 0 && categories[i].amount > avg * 1.3) {
          var increasePct = Math.round((categories[i].amount / avg - 1) * 100);
          var comparison = increasePct > 500
            ? '是近 ' + history.periods + ' 期均值的 ' + Math.round(categories[i].amount / avg) + ' 倍'
            : '较近 ' + history.periods + ' 期均值高 ' + increasePct + '%';
          insights.push({
            level: 'watch',
            title: categories[i].name + '开支明显上涨',
            note: '本期 ' + fmt(categories[i].amount) + '，' + comparison,
            target: 'category'
          });
          break;
        }
      }
    }
    if (!insights.length && forecast.projectedBalance >= 0) {
      insights.push({ level: 'safe', title: '本周期节奏正常', note: '付完计划后预计还剩 ' + fmt(forecast.projectedBalance), target: 'home' });
    }
    return insights.slice(0, 3);
  }
  function localAnomalies(insights) {
    return (insights || []).filter(function (item) {
      return item.level === 'high' || item.level === 'watch';
    }).map(function (item) {
      return { title: item.title, reason: item.note, amount: 0 };
    }).slice(0, 3);
  }
  function aiTrendContext(current) {
    var trends = [];
    var nameCounts = {};
    for (var offset = 1; offset <= 3; offset++) {
      var d = new Date(current.getFullYear(), current.getMonth() - offset, 1);
      var key = monthKey(d);
      var expenses = monthDataReadonly(key).expenses || [];
      var total = 0;
      var categories = {};
      categoryStats(expenses).forEach(function (category) {
        total += category.amount;
        categories[category.name] = category.amount;
      });
      expenses.forEach(function (expense) {
        if (expensePaid(expense) > 0) {
          nameCounts[expense.name || '未命名'] = (nameCounts[expense.name || '未命名'] || 0) + 1;
        }
      });
      trends.push({ monthKey: key, spent: total, categories: categories });
    }
    return {
      trends: trends,
      recurring: Object.keys(nameCounts).filter(function (name) { return nameCounts[name] >= 2; }).slice(0, 8)
    };
  }

  /* ---------- AI 开支建议 ---------- */
  var AI_PREFIX = 'bookkeeping_ai_advice';
  var aiState = { key: '', state: 'idle', advice: '', result: null, error: '', time: '', cached: false, stale: false };

  function aiStorageKey(bookId, key) { return AI_PREFIX + '_' + (bookId || '_none') + '_' + key; }
  function aiFingerprint(ov) {
    if (!ov) return '0';
    var parts = [
      ov.income, ov.saving, ov.spent, ov.planned, ov.budget,
      ov.remainingDays, ov.forecast, JSON.stringify(ov.trends || []),
      JSON.stringify(ov.recurring || []), JSON.stringify(ov.categories || []),
      JSON.stringify(ov.members || []), JSON.stringify(ov.localAnomalies || [])
    ];
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
    '你是一位务实、亲切的家庭理财助手。请根据10号账单周期数据优先识别有明确数据证据的异常。' +
    '只返回合法JSON，不要使用代码围栏。结构为：' +
    '{"overview":"一句话概览","advice":"300字内的具体建议，可使用Markdown列表",' +
    '"risks":[{"title":"异常标题","reason":"数据证据和建议","amount":数字}],' +
    '"actions":[{"type":"set_budget","monthKey":"输入给出的建议预算周期","amount":数字,"label":"采用建议预算 ¥金额"}]}。' +
    'risks最多3项，没有异常时必须为空数组；不要为了给建议而编造异常。actions最多1项。' +
    '不要输出账本编号、设备ID或成员ID，语气自然、不说教。';
  function buildAiPrompt(key, ov) {
    var lines = [];
    lines.push('统计周期：' + key + '（每月10号到次月10号为一个账单周期）');
    lines.push('收入：' + fmt(ov.income));
    lines.push('储蓄：' + fmt(ov.saving));
    lines.push('已完成开支：' + fmt(ov.spent));
    lines.push('计划开支：' + fmt(ov.planned));
    if (ov.budget) lines.push('预算总额：' + fmt(ov.budget));
    lines.push('本期结余：' + fmt(ov.balance));
    lines.push('剩余天数：' + (ov.remainingDays || 0));
    lines.push('预计周期末开支：' + fmt(ov.forecast || 0));
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
            return ((s.label || '').trim() || '未备注') + ' ' + fmt(s.amount) +
              (s.memberName ? '（' + s.memberName + '）' : '');
          }).join('、') + '）';
        }
        lines.push(line);
      }
    }
    if (ov.trends && ov.trends.length) lines.push('最近周期趋势：' + JSON.stringify(ov.trends));
    if (ov.recurring && ov.recurring.length) lines.push('重复支出候选：' + ov.recurring.join('、'));
    if (ov.categories && ov.categories.length) lines.push('分类汇总：' + JSON.stringify(ov.categories));
    if (ov.members && ov.members.length) lines.push('成员汇总：' + JSON.stringify(ov.members));
    if (ov.localAnomalies && ov.localAnomalies.length) lines.push('本地规则已识别异常：' + JSON.stringify(ov.localAnomalies));
    return lines.join('\n');
  }
  function aiPayloadOverview(ov) {
    return {
      income: ov.income, saving: ov.saving, spent: ov.spent, planned: ov.planned,
      budget: ov.budget, balance: ov.balance, remainingDays: ov.remainingDays,
      forecast: ov.forecast, nextMonthKey: ov.nextMonthKey,
      trends: ov.trends || [], recurring: ov.recurring || [],
      categories: ov.categories || [], members: ov.members || [],
      localAnomalies: ov.localAnomalies || [],
      ranked: (ov.ranked || []).slice(0, 20).map(function (item) {
        return {
          name: item.name,
          paid: item.paid,
          segments: (item.segments || []).slice(0, 30).map(function (segment) {
            return {
              label: segment.label,
              amount: segment.amount,
              memberName: segment.memberName || '未标注'
            };
          })
        };
      })
    };
  }
  function parseAiStructuredContent(content, ov) {
    var cleaned = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      var parsed = JSON.parse(cleaned);
      var advice = typeof parsed.advice === 'string' ? parsed.advice.trim() : '';
      if (!advice) throw new Error('AI 未返回建议');
      var risks = Array.isArray(parsed.risks) ? parsed.risks.slice(0, 3).map(function (risk) {
        return {
          title: String((risk && risk.title) || '支出提醒').slice(0, 40),
          reason: String((risk && risk.reason) || '').slice(0, 180),
          amount: Math.max(0, num(risk && risk.amount))
        };
      }) : [];
      var actions = Array.isArray(parsed.actions) ? parsed.actions.filter(function (action) {
        return action && action.type === 'set_budget' && action.monthKey === ov.nextMonthKey && num(action.amount) > 0;
      }).slice(0, 1) : [];
      return { advice: advice, overview: String(parsed.overview || '').slice(0, 180), risks: risks, actions: actions };
    } catch (e) {
      return { advice: String(content || '').trim(), risks: [], actions: [] };
    }
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
      body = JSON.stringify({ monthKey: key, overview: aiPayloadOverview(ov) });
    }
    return fetch(url, {
      method: 'POST', headers: headers, body: body,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (direct) {
          var content = data && data.choices && data.choices[0] && data.choices[0].message && (data.choices[0].message.content || '').trim();
          if (!res.ok || !content) {
            throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
          }
          var structured = parseAiStructuredContent(content, ov);
          structured.generatedAt = new Date().toISOString();
          return structured;
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
    return fetchAiSummaryH5(key, ov);
  }
  function renderAiStreaming(text) {
    var sec = document.querySelector('.ai-section');
    if (!sec) return;
    sec.innerHTML = '<div class="dash-title">支出异常提醒 <span class="dash-sub">GLM-4-Flash</span></div>' +
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
        s = { state: 'done', advice: cache.advice, result: cache.result || null, time: cache.time || '', cached: true, stale: false, error: '' };
      } else {
        s = { state: 'idle', advice: '', result: null, time: '', cached: false, error: '', stale: !!(cache && cache.advice) };
      }
      aiState = { key: key, state: s.state, advice: s.advice, result: s.result || null, error: s.error, time: s.time, cached: s.cached, stale: s.stale };
    }
    var inner;
    if (s.state === 'idle') {
      var local = ov.localAnomalies && ov.localAnomalies.length
        ? aiStructuredHtml({ risks: ov.localAnomalies })
        : '<div class="ai-clear">暂无明显异常</div>';
      inner = local +
        (s.stale ? '<div class="ai-hint">开支有更新，可重新分析最新数据</div>' : '') +
        '<button class="ai-btn" id="aiGenBtn">用 AI 深度分析</button>' +
        '<div class="ai-tip">AI 会核对分类趋势和家庭支出，只提示有数据依据的异常</div>';
    } else if (s.state === 'loading') {
      inner = '<div class="ai-loading"><i class="ai-spinner"></i><span>AI 正在分析本月开支…</span></div>';
    } else if (s.state === 'streaming') {
      inner = '<div class="ai-advice">' + aiMdToHtml(s.advice) + '<span class="ai-caret"></span></div>';
    } else if (s.state === 'done') {
      inner = aiStructuredHtml(s.result, true) +
        '<div class="ai-advice">' + aiMdToHtml(s.advice) + '</div>' +
        '<div class="ai-foot"><span class="ai-time">' + (s.cached ? '上次生成 ' : '生成于 ') + escapeHtml(s.time) + '</span>' +
        '<button type="button" class="ai-regen" id="aiRegen">重新分析</button></div>';
    } else {
      inner = '<div class="ai-error">' + escapeHtml(s.error) + '</div>' +
        '<button class="ai-btn" id="aiGenBtn">重试</button>';
    }
    return '<section class="dash-section ai-section">' +
      '<div class="dash-title">支出异常提醒 <span class="dash-sub">规则检测 + AI</span></div>' +
      inner + '</section>';
  }
  function aiStructuredHtml(result, showClear) {
    if (!result || typeof result !== 'object') return '';
    var html = '';
    var risks = Array.isArray(result.risks) ? result.risks.slice(0, 3) : [];
    if (risks.length) {
      html += '<div class="ai-risk-list">' + risks.map(function (risk) {
        return '<div class="ai-risk"><i></i><div><b>' + escapeHtml(risk.title || '支出提醒') + '</b>' +
          '<span>' + escapeHtml(risk.reason || '') + '</span></div>' +
          (num(risk.amount) > 0 ? '<strong>' + fmt(num(risk.amount)) + '</strong>' : '') + '</div>';
      }).join('') + '</div>';
    } else if (showClear) {
      html += '<div class="ai-clear">AI 未发现有明确证据的异常</div>';
    }
    var actions = Array.isArray(result.actions) ? result.actions.filter(function (action) {
      return action && action.type === 'set_budget' && /^\d{4}-\d{2}$/.test(action.monthKey || '') && num(action.amount) > 0;
    }).slice(0, 1) : [];
    if (actions.length) {
      var action = actions[0];
      html += '<button type="button" class="ai-action-btn" data-month-key="' + escapeHtml(action.monthKey) +
        '" data-amount="' + num(action.amount) + '">✓ ' +
        escapeHtml(action.label || ('采用下周期预算 ' + fmt(num(action.amount)))) + '</button>';
    }
    return html;
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
        aiState = { key: key, state: 'done', advice: cache.advice, result: cache.result || null, error: '', time: cache.time || '', cached: true, stale: false };
        renderDashboard();
        return;
      }
    }
    aiState = { key: key, state: 'loading', advice: '', error: '', time: '', cached: false, stale: false };
    renderDashboard();
    streamAiSummaryH5(key, ov, function (partial) {
      aiState = { key: key, state: 'streaming', advice: partial, error: '', time: '', cached: false, stale: false };
      renderAiStreaming(partial);
    }).then(function (response) {
      var result = typeof response === 'string' ? null : response;
      var advice = (typeof response === 'string' ? response : (response && response.advice) || '').trim();
      if (!advice) throw new Error('AI 未返回内容');
      var time = aiTimeText(new Date().toISOString());
      aiSetCache(key, { advice: advice, result: result, fingerprint: fp, time: time });
      aiState = { key: key, state: 'done', advice: advice, result: result, error: '', time: time, cached: false, stale: false };
      renderDashboard();
    }).catch(function (err) {
      var msg = (err && err.message) || '生成失败，请重试';
      if (err && err.name === 'AbortError') msg = '请求超时，AI 服务可能在当前网络下不稳定，请稍后重试';
      else if (/failed to fetch|networkerror|load failed|abort/i.test(msg)) msg = '网络连接失败，请检查网络后重试';
      aiState = { key: key, state: 'error', advice: '', error: msg, time: '', cached: false, stale: false };
      renderDashboard();
    });
  }
  function applyAiBudget(monthKeyValue, amount) {
    amount = num(amount);
    if (!/^\d{4}-\d{2}$/.test(monthKeyValue || '') || amount <= 0) return;
    if (!confirm('将 ' + monthKeyValue + ' 的预算设置为 ' + fmt(amount) + '？')) return;
    state.aiBudgetUndo = {
      monthKey: monthKeyValue,
      hadValue: Object.prototype.hasOwnProperty.call(state.data.budgetByMonth, monthKeyValue),
      value: state.data.budgetByMonth[monthKeyValue]
    };
    state.quickUndo = null;
    state.data.budgetByMonth[monthKeyValue] = amount;
    touchBudget(monthKeyValue);
    save();
    render();
    showQuickUndo('AI 建议预算已采用');
  }
  function undoAiBudget() {
    var undo = state.aiBudgetUndo;
    if (!undo) return;
    if (undo.hadValue) state.data.budgetByMonth[undo.monthKey] = undo.value;
    else state.data.budgetByMonth[undo.monthKey] = null;
    touchBudget(undo.monthKey);
    state.aiBudgetUndo = null;
    save();
    render();
    showToast('已撤销预算修改');
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
    var forecast = cycleMetrics(state.current, actualSpent, budget, m.expenses);
    var planned = sum(m.expenses, 'plannedAmount');
    var categories = categoryStats(m.expenses);
    var members = memberStats(m.expenses);
    var actionInsights = buildActionInsights(state.current, m.expenses, actualSpent, budget, forecast, categories);
    state.metricContext = {
      income: income, saving: saving, spent: spent, planned: planned,
      budget: budget, actualSpent: actualSpent, execPct: execPct, forecast: forecast
    };

    var html = '';
    html += '<section class="finance-cockpit">' +
      '<div class="cockpit-top"><div class="metric-trigger" data-metric-key="remainingBudget" role="button" tabindex="0"><div class="cockpit-kicker">本周期可用余额 <small>查看计算</small></div>' +
        '<div class="cockpit-balance' + (forecast.remainingBudget < 0 ? ' neg' : '') + '">' + fmt(forecast.remainingBudget) + '</div>' +
        '<div class="cockpit-cycle">' + escapeHtml(cycleRangeText(state.current)) + ' · 剩余 ' + forecast.remainingDays + ' 天</div></div>' +
        '<div class="budget-ring metric-trigger" data-metric-key="budgetUsed" role="button" tabindex="0" style="--ring-pct:' + execPct + ';--ring-color:' + (execOver ? '#fca5a5' : '#93c5fd') + '">' +
          '<div><b>' + execPct + '%</b><span>预算已用</span></div></div></div>' +
      '<div class="cockpit-grid">' +
        '<div class="metric-trigger" data-metric-key="safeDaily" role="button" tabindex="0"><span>安全日额度</span><b>' + fmt(forecast.dailyAvailable) + '</b><small>已预留计划待付</small></div>' +
        '<div class="metric-trigger" data-metric-key="averageDaily" role="button" tabindex="0"><span>平均每日余额</span><b>' + fmt(forecast.availableDaily) + '</b><small>未预留计划待付</small></div>' +
      '</div>' +
      '<div class="risk-banner metric-trigger ' + forecast.risk.level + '" data-metric-key="risk" role="button" tabindex="0"><i></i><div><b>' + forecast.risk.label + '</b><span>' + forecast.risk.note + '</span></div><em>查看依据</em></div>' +
      '<div class="cockpit-mini"><span>收入 <b class="income">' + fmt(income) + '</b></span><span>储蓄 <b class="saving">' + fmt(saving) +
        '</b></span><span>已花 <b class="expense">' + fmt(spent) + '</b></span></div>' +
    '</section>';

    var actionHtml = actionInsights.map(function (item) {
      return '<button type="button" class="action-insight ' + item.level + '" data-target="' + item.target + '">' +
        '<i></i><span><b>' + escapeHtml(item.title) + '</b><small>' + escapeHtml(item.note) + '</small></span><em>›</em></button>';
    }).join('');
    html += '<section class="dash-section action-section">' +
      '<div class="dash-title">本周期行动 <span class="dash-sub">最多 3 条</span></div>' + actionHtml + '</section>';

    var recent = recentFamilyPayments(m.expenses);
    var recentHtml = recent.length ? recent.map(function (row) {
      return '<button type="button" class="activity-row" data-expense-id="' + escapeHtml(row.expenseId) + '">' +
        '<span class="activity-avatar">' + escapeHtml(row.memberName.charAt(0)) + '</span>' +
        '<span class="activity-main"><b>' + escapeHtml(row.note) + '</b><small>' +
          escapeHtml(row.memberName) + ' · ' + escapeHtml(row.timeText || '—') + '</small></span>' +
        '<strong>-' + fmt(row.amount) + '</strong><span class="rank-chevron">›</span></button>';
    }).join('') : '<div class="dash-empty">本周期还没有家庭支出</div>';
    html += '<section class="dash-section family-activity">' +
      '<div class="dash-title">最近家庭动态 <span class="dash-sub">最近 5 笔</span></div>' + recentHtml + '</section>';

    var memberTotal = members.reduce(function (total, item) { return total + item.amount; }, 0);
    var memberHtml = members.length ? members.map(function (item) {
      return '<div class="member-stat-row"><div class="member-stat-head"><span>' + escapeHtml(item.name) +
        ' <small>' + item.count + ' 笔</small></span><b>' + fmt(item.amount) + ' · ' + pct(item.amount, memberTotal) + '%</b></div>' +
        '<div class="member-stat-bar"><i style="width:' + Math.max(3, pct(item.amount, memberTotal)) + '%"></i></div></div>';
    }).join('') : '<div class="dash-empty">本周期还没有成员支出</div>';
    html += '<section class="dash-section member-stats">' +
      '<div class="dash-title">成员支出 <span class="dash-sub">按付款人统计</span></div>' + memberHtml + '</section>';

    var categoryMax = categories.length ? categories[0].amount : 0;
    var categoryHtml = categories.length ? categories.map(function (item) {
      return '<div class="category-stat-row"><div class="rank-row-head"><span>' + escapeHtml(item.name) +
        ' <small>' + item.count + ' 笔</small></span><span>' + fmt(item.amount) + ' <span class="pct">' +
        pct(item.amount, spent) + '%</span></span></div><div class="rank-bar"><i style="width:' +
        Math.max(4, pct(item.amount, categoryMax)) + '%"></i></div></div>';
    }).join('') : '<div class="dash-empty">本周期暂无分类数据</div>';
    html += '<section class="dash-section category-section" id="categorySection">' +
      '<div class="dash-title">分类开支 <span class="dash-sub">标准分类</span></div>' + categoryHtml + '</section>';

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
              timeText: formatPaymentTime(pay),
              memberName: pay.memberName || '未标注'
            });
          }
        }
      }
      ranked.push({ expenseId: ex.id, name: ex.name, category: categoryName(ex.categoryId), paid: paid, segments: segs });
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
      '<div class="dash-title">开支明细排行</div>' + rankHtml + '</section>';

    var aiContext = aiTrendContext(state.current);
    var nextCycle = monthKey(new Date(state.current.getFullYear(), state.current.getMonth() + 1, 1));
    var ov = {
      income: income, saving: saving, spent: spent, planned: planned,
      budget: budget, balance: balance, ranked: ranked,
      remainingDays: forecast.remainingDays, forecast: forecast.forecast,
      trends: aiContext.trends, recurring: aiContext.recurring,
      categories: categories.map(function (item) { return { name: item.name, amount: item.amount, count: item.count }; }),
      members: members.map(function (item) { return { name: item.name, amount: item.amount, count: item.count }; }),
      localAnomalies: localAnomalies(actionInsights),
      nextMonthKey: nextCycle
    };
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

    var metricTriggers = view.querySelectorAll('[data-metric-key]');
    for (var mi = 0; mi < metricTriggers.length; mi++) {
      metricTriggers[mi].addEventListener('click', function () {
        openMetricDetail(this.getAttribute('data-metric-key'));
      });
      metricTriggers[mi].addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openMetricDetail(this.getAttribute('data-metric-key'));
        }
      });
    }
    var insightButtons = view.querySelectorAll('.action-insight[data-target]');
    for (var ii = 0; ii < insightButtons.length; ii++) {
      insightButtons[ii].addEventListener('click', function () {
        var target = this.getAttribute('data-target');
        if (target === 'plan') {
          setTab('plan');
        } else if (target === 'category') {
          var section = $('categorySection');
          if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
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
    var activityRows = view.querySelectorAll('.activity-row[data-expense-id]');
    for (var ai = 0; ai < activityRows.length; ai++) {
      activityRows[ai].addEventListener('click', function () {
        openExpenseDetailDrawer(this.getAttribute('data-expense-id'));
      });
    }
    var actionBtn = view.querySelector('.ai-action-btn');
    if (actionBtn) {
      actionBtn.addEventListener('click', function () {
        applyAiBudget(this.getAttribute('data-month-key'), this.getAttribute('data-amount'));
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
    var carried = ensureFixedPlansForKey(key);
    var m = getMonth(key);
    if (carried) save();
    $('monthLabel').textContent = cycleRangeText(state.current);

    var incomeT = sum(m.income, 'amount');
    var savingT = sum(m.savings, 'amount');
    var plannedT = sum(m.expenses, 'plannedAmount');
    var expenseDone = completedExpenseTotal(m.expenses);
    var budget = num(state.data.budgetByMonth[key]);
    var budgetOut = savingT + plannedT;
    var actualSpent = calcActualSpent(m);
    var remain = budget - budgetOut;
    var currentForecast = cycleMetrics(state.current, actualSpent, budget, m.expenses);
    state.metricContext = {
      income: incomeT, saving: savingT, spent: expenseDone, planned: plannedT,
      budget: budget, actualSpent: actualSpent,
      execPct: budget > 0 ? Math.min(100, Math.round((actualSpent / budget) * 100)) : 0,
      forecast: currentForecast
    };

    $('budgetValue').textContent = budget ? fmt(budget) : '¥0';
    $('budgetOutValue').textContent = fmt(budgetOut);
    $('actualSpentValue').textContent = fmt(actualSpent);
    $('remainValue').textContent = fmt(remain);
    $('remainValue').style.color = remain < 0 ? 'var(--danger)' : 'var(--text)';

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
      meta.textContent = (item.date || '') + ' · ' + categoryName(item.categoryId) +
        (item.isFixed ? ' · 固定' : '') + statusText;
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
        var removed = item.payments.pop();
        markDeleted(removed && removed.id);
      }
      item.done = false;
      delete item.completedAt;
      if (!item.payments.length) {
        delete item.payments;
        item.actualAmount = '';
      } else {
        item.actualAmount = expensePaid(item);
      }
      touchRecord(item);
      save();
      render();
      showToast('已取消完成');
      return;
    }
    var paid = expensePaid(item);
    var remainder = Math.max(0, planned - paid);
    if (remainder > 0) {
      if (!getMemberProfile()) {
        ensureMember(function () { toggleDone(id); });
        return;
      }
      var member = currentMemberFields();
      item.payments.push({
        id: uid(), amount: remainder, date: todayISO(), note: '完成计划',
        recordedAt: nowISO(), updatedAt: nowISO(),
        categoryId: normalizeCategoryId(item.categoryId),
        memberId: member.memberId, memberName: member.memberName
      });
    }
    refreshExpenseDone(item);
    item.actualAmount = expensePaid(item);
    touchRecord(item);
    save();
    render();
  }

  function syncExpenseSummary(item) {
    var summary = $('expenseSummary');
    if (!summary) return;
    if (!item) {
      summary.hidden = true;
      if ($('expenseHistoryNotes')) {
        $('expenseHistoryNotes').hidden = true;
        $('expenseHistoryNotes').innerHTML = '';
      }
      if ($('fPayment')) $('fPayment').value = '';
      return;
    }
    summary.hidden = false;
    var paid = expensePaid(item);
    var planned = num(item.plannedAmount);
    $('expensePaidText').textContent = fmt(paid);
    $('expenseRemainText').textContent = fmt(Math.max(0, planned - paid));
    renderExpenseHistoryNotes(item);
    if ($('fPayment')) $('fPayment').value = '';
  }

  function renderExpenseHistoryNotes(item) {
    var wrap = $('expenseHistoryNotes');
    if (!wrap) return;
    var timeline = buildPaymentTimeline(item);
    if (!timeline.length) {
      wrap.hidden = true;
      wrap.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    var html = '<div class="expense-history-title">支出历史备注</div>';
    for (var i = 0; i < timeline.length; i++) {
      var row = timeline[i];
      html += '<div class="expense-history-row">' +
        '<div class="expense-history-main">' +
          '<span class="expense-detail-amt">' + escapeHtml(row.amountText) + '</span>' +
          '<span class="expense-detail-note">' + escapeHtml(row.note) + '</span>' +
        '</div>' +
        '<div class="expense-detail-row-sub">' +
          '<span class="expense-detail-time">' + escapeHtml(row.timeText || '—') + '</span>' +
          '<span class="expense-detail-remain">剩余 ' + escapeHtml(row.remainText) + '</span>' +
        '</div>' +
        '<div class="expense-detail-edit" data-payment-id="' + escapeHtml(row.paymentId || '') + '">' +
          '<button type="button" class="expense-detail-edit-btn">编辑备注</button>' +
          '<div class="expense-detail-editor" hidden>' +
            '<input type="text" class="expense-detail-note-input" maxlength="40" value="' + escapeHtml(row.rawNote) + '" placeholder="补充备注">' +
            '<button type="button" class="expense-detail-save">保存</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }
    wrap.innerHTML = html;
    var editBtns = wrap.querySelectorAll('.expense-detail-edit-btn');
    for (var ei = 0; ei < editBtns.length; ei++) {
      editBtns[ei].addEventListener('click', function () {
        var parent = this.parentNode;
        this.hidden = true;
        parent.querySelector('.expense-detail-editor').hidden = false;
        parent.querySelector('.expense-detail-note-input').focus();
      });
    }
    var saveBtns = wrap.querySelectorAll('.expense-detail-save');
    for (var si = 0; si < saveBtns.length; si++) {
      saveBtns[si].addEventListener('click', function () {
          var parent = this.parentNode.parentNode;
          saveEntryPaymentNote(item.id, parent.getAttribute('data-payment-id'), parent.querySelector('.expense-detail-note-input').value);
      });
    }
  }

  function openPaymentDrawer(id) {
    if (!getMemberProfile()) {
      ensureMember(function () { openPaymentDrawer(id); });
      return;
    }
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

  function quickSuggestions() {
    var map = {};
    function remember(name, amount, categoryId, at) {
      name = (name || '').trim();
      if (!name) return;
      if (!map[name]) map[name] = { name: name, count: 0, lastAt: '', planId: '', lastAmount: 0, categoryId: 'other' };
      map[name].count += 1;
      if ((at || '') >= map[name].lastAt) {
        map[name].lastAt = at || '';
        map[name].lastAmount = num(amount);
        map[name].categoryId = normalizeCategoryId(categoryId);
      }
    }
    Object.keys(state.data.months || {}).forEach(function (key) {
      var expenses = (state.data.months[key] && state.data.months[key].expenses) || [];
      expenses.forEach(function (expense) {
        if (!(expense.payments || []).length) {
          remember(expense.name, expensePaid(expense), expense.categoryId, recordTime(expense));
        }
        (expense.payments || []).forEach(function (payment) {
          remember(payment.note || expense.name, payment.amount, payment.categoryId || expense.categoryId, recordTime(payment));
        });
      });
    });
    var currentExpenses = getMonth(monthKey(state.current)).expenses;
    Object.keys(map).forEach(function (name) {
      for (var i = 0; i < currentExpenses.length; i++) {
        if (currentExpenses[i].name === name) map[name].planId = currentExpenses[i].id;
      }
    });
    return Object.keys(map).map(function (name) { return map[name]; })
      .sort(function (a, b) { return b.count - a.count || (b.lastAt > a.lastAt ? 1 : -1); })
      .slice(0, 6);
  }
  function renderQuickEntryOptions() {
    var profile = getMemberProfile();
    var members = normalizeData(state.data).members;
    var memberIds = Object.keys(members);
    if (profile && memberIds.indexOf(profile.memberId) === -1) {
      registerMember(profile);
      memberIds = Object.keys(members);
    }
    memberIds.sort(function (a, b) {
      if (profile && a === profile.memberId) return -1;
      if (profile && b === profile.memberId) return 1;
      return 0;
    });
    $('fQuickMember').innerHTML = memberIds.map(function (id) {
      return '<option value="' + escapeHtml(id) + '">' + escapeHtml(members[id].name || '未命名') + '</option>';
    }).join('');
    if (profile) $('fQuickMember').value = profile.memberId;
    $('quickMemberPill').textContent = profile ? profile.name + ' 的设备' : '';
    $('quickCategoryChips').innerHTML = EXPENSE_CATEGORIES.map(function (item) {
      return '<button type="button" class="category-chip' + (item.id === 'other' ? ' active' : '') +
        '" data-category-id="' + item.id + '">' + item.name + '</button>';
    }).join('');

    var key = monthKey(state.current);
    var plans = getMonth(key).expenses.filter(function (item) { return item.source !== 'quick'; });
    $('fQuickPlan').innerHTML = '<option value="">不关联计划 · 即时支出</option>' +
      plans.map(function (item) {
        var remain = Math.max(0, num(item.plannedAmount) - expensePaid(item));
        return '<option value="' + escapeHtml(item.id) + '">' +
          escapeHtml(item.name) + ' · 剩余 ' + escapeHtml(fmt(remain)) + '</option>';
      }).join('');

    var chips = quickSuggestions();
    $('quickChips').innerHTML = chips.length
      ? '<span class="quick-chips-label">常用</span>' + chips.map(function (item) {
          return '<button type="button" class="quick-chip" data-note="' + escapeHtml(item.name) +
            '" data-plan-id="' + escapeHtml(item.planId) + '" data-amount="' + item.lastAmount +
            '" data-category-id="' + item.categoryId + '">' + escapeHtml(item.name) + '</button>';
        }).join('')
      : '';
  }
  function openQuickEntry() {
    if (!getMemberProfile()) {
      ensureMember(openQuickEntry);
      return;
    }
    renderQuickEntryOptions();
    $('fQuickAmount').value = '';
    $('fQuickNote').value = '';
    $('fQuickDate').value = todayISO();
    $('fQuickPlan').value = '';
    $('fQuickCategory').value = 'other';
    if ($('quickMore')) $('quickMore').open = false;
    showDrawer('quickEntryDrawer', 'quickEntryMask');
    setTimeout(function () { $('fQuickAmount').focus(); }, 220);
  }
  function closeQuickEntry() {
    $('quickEntryMask').hidden = true;
    $('quickEntryDrawer').hidden = true;
  }
  function submitQuickEntry(e) {
    e.preventDefault();
    var amount = num($('fQuickAmount').value);
    var note = ($('fQuickNote').value || '').trim();
    if (amount <= 0) {
      showToast('请输入支出金额');
      $('fQuickAmount').focus();
      return;
    }
    var categoryId = normalizeCategoryId($('fQuickCategory').value);
    if (!note) note = categoryName(categoryId);
    var key = monthKey(state.current);
    var month = getMonth(key);
    var memberId = $('fQuickMember').value;
    var member = state.data.members[memberId] || {};
    var payment = {
      id: uid(),
      amount: amount,
      note: note,
      date: $('fQuickDate').value || todayISO(),
      recordedAt: nowISO(),
      updatedAt: nowISO(),
      categoryId: categoryId,
      memberId: memberId,
      memberName: member.name || '未标注'
    };
    var planId = $('fQuickPlan').value;
    var expense = null;
    var createdExpense = false;
    if (planId) {
      for (var i = 0; i < month.expenses.length; i++) {
        if (month.expenses[i].id === planId) expense = month.expenses[i];
      }
    }
    if (expense) {
      ensurePayments(expense);
      expense.payments.push(payment);
      refreshExpenseDone(expense);
      expense.actualAmount = expensePaid(expense);
      touchRecord(expense);
    } else {
      expense = {
        id: uid(),
        name: note,
        categoryId: categoryId,
        plannedAmount: amount,
        date: payment.date,
        source: 'quick',
        payments: [payment],
        done: true,
        completedAt: nowISO(),
        actualAmount: amount,
        updatedAt: nowISO()
      };
      month.expenses.push(expense);
      createdExpense = true;
    }
    state.quickUndo = {
      monthKey: key,
      expenseId: expense.id,
      paymentId: payment.id,
      createdExpense: createdExpense
    };
    state.aiBudgetUndo = null;
    save();
    render();
    closeQuickEntry();
    showQuickUndo();
  }
  function showQuickUndo(message) {
    var toast = $('quickUndoToast');
    var label = toast.querySelector('span');
    if (label) label.textContent = message || '支出已记录';
    toast.hidden = false;
    toast.classList.add('show');
    if (state.quickUndoTimer) clearTimeout(state.quickUndoTimer);
    state.quickUndoTimer = setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () { toast.hidden = true; }, 220);
      state.quickUndo = null;
      state.aiBudgetUndo = null;
    }, 8000);
  }
  function undoQuickEntry() {
    var undo = state.quickUndo;
    if (!undo) return;
    var month = state.data.months[undo.monthKey];
    if (!month) return;
    for (var i = 0; i < month.expenses.length; i++) {
      var expense = month.expenses[i];
      if (expense.id !== undo.expenseId) continue;
      if (undo.createdExpense) {
        month.expenses.splice(i, 1);
        markDeleted(expense.id);
        markDeleted(undo.paymentId);
      } else {
        expense.payments = (expense.payments || []).filter(function (payment) {
          return payment.id !== undo.paymentId;
        });
        markDeleted(undo.paymentId);
        refreshExpenseDone(expense);
        expense.actualAmount = expensePaid(expense);
        touchRecord(expense);
      }
      break;
    }
    state.quickUndo = null;
    if (state.quickUndoTimer) clearTimeout(state.quickUndoTimer);
    $('quickUndoToast').classList.remove('show');
    $('quickUndoToast').hidden = true;
    save();
    render();
    showToast('已撤销这笔支出');
  }
  function undoLastAction() {
    if (state.aiBudgetUndo) {
      undoAiBudget();
      $('quickUndoToast').classList.remove('show');
      $('quickUndoToast').hidden = true;
      return;
    }
    undoQuickEntry();
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
          '<div class="expense-detail-edit" data-payment-id="' + escapeHtml(row.paymentId || '') + '">' +
            '<button type="button" class="expense-detail-edit-btn">编辑备注</button>' +
            '<div class="expense-detail-editor" hidden>' +
            '<input type="text" class="expense-detail-note-input" maxlength="40" value="' + escapeHtml(row.rawNote) + '" placeholder="补充备注">' +
            '<button type="button" class="expense-detail-save">保存</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }
      listEl.innerHTML = rows;
      var editBtns = listEl.querySelectorAll('.expense-detail-edit-btn');
      for (var ei = 0; ei < editBtns.length; ei++) {
        editBtns[ei].addEventListener('click', function () {
          var wrap = this.parentNode;
          this.hidden = true;
          wrap.querySelector('.expense-detail-editor').hidden = false;
          wrap.querySelector('.expense-detail-note-input').focus();
        });
      }
      var saveBtns = listEl.querySelectorAll('.expense-detail-save');
      for (var bi = 0; bi < saveBtns.length; bi++) {
        saveBtns[bi].addEventListener('click', function () {
          var wrap = this.parentNode.parentNode;
          savePaymentNote(expenseId, wrap.getAttribute('data-payment-id'), wrap.querySelector('.expense-detail-note-input').value);
        });
      }
    }
    $('expenseDetailMask').hidden = false;
    $('expenseDetailDrawer').hidden = false;
  }

  function updatePaymentNote(expenseId, paymentId, note) {
    var item = findItem('expenses', expenseId);
    if (!item || !item.payments) return false;
    for (var i = 0; i < item.payments.length; i++) {
      if (item.payments[i].id === paymentId) {
        note = (note || '').trim();
        if (note) item.payments[i].note = note;
        else delete item.payments[i].note;
        touchRecord(item.payments[i]);
        touchRecord(item);
        return true;
      }
    }
    return false;
  }

  function savePaymentNote(expenseId, paymentId, note) {
    if (!updatePaymentNote(expenseId, paymentId, note)) return;
    save();
    render();
    openExpenseDetailDrawer(expenseId);
    showToast('备注已保存');
  }

  function saveEntryPaymentNote(expenseId, paymentId, note) {
    if (!updatePaymentNote(expenseId, paymentId, note)) return;
    save();
    render();
    syncExpenseSummary(findItem('expenses', expenseId));
    showToast('备注已保存');
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
    var note = ($('fPayNote').value || '').trim();
    if (!note) {
      showToast('请输入本次支出备注');
      $('fPayNote').focus();
      return;
    }
    ensurePayments(item);
    var pay = {
      id: uid(),
      amount: amt,
      date: $('fPayDate').value || todayISO(),
      recordedAt: nowISO(),
      updatedAt: nowISO(),
      categoryId: normalizeCategoryId(item.categoryId)
    };
    var memberFields = currentMemberFields();
    pay.memberId = memberFields.memberId;
    pay.memberName = memberFields.memberName;
    pay.note = note;
    item.payments.push(pay);
    touchRecord(item);
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
      $('fCategory').innerHTML = categoryOptions(item && item.categoryId);
      $('fPlanned').value = item ? item.plannedAmount : '';
      $('fIsFixed').checked = !!(item && item.isFixed);
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
      var categoryId = normalizeCategoryId($('fCategory').value);
      var isFixed = !!$('fIsFixed').checked;
      if (paymentAmt > 0 && !getMemberProfile()) {
        ensureMember(function () { $('entryForm').requestSubmit(); });
        return;
      }
      if (item) {
        item.name = name;
        item.date = date;
        item.plannedAmount = planned;
        item.categoryId = categoryId;
        item.isFixed = isFixed;
        if (isFixed && !item.fixedSeriesId) item.fixedSeriesId = 'fixed_' + item.id;
        if (!isFixed) {
          delete item.fixedSeriesId;
          delete item.carriedFromId;
        }
        ensurePayments(item);
        if (paymentAmt > 0) {
          var member = currentMemberFields();
          item.payments.push({
            id: uid(), amount: paymentAmt, date: date,
            recordedAt: nowISO(), updatedAt: nowISO(),
            categoryId: categoryId,
            memberId: member.memberId, memberName: member.memberName
          });
        }
        refreshExpenseDone(item);
        item.actualAmount = expensePaid(item);
        touchRecord(item);
      } else {
        var newItem = {
          id: uid(),
          name: name,
          categoryId: categoryId,
          plannedAmount: planned,
          date: date,
          isFixed: isFixed,
          payments: [],
          done: false,
          actualAmount: '',
          updatedAt: nowISO()
        };
        if (isFixed) newItem.fixedSeriesId = 'fixed_' + newItem.id;
        if (paymentAmt > 0) {
          var newMember = currentMemberFields();
          newItem.payments.push({
            id: uid(), amount: paymentAmt, date: date,
            recordedAt: nowISO(), updatedAt: nowISO(),
            categoryId: categoryId,
            memberId: newMember.memberId, memberName: newMember.memberName
          });
        }
        refreshExpenseDone(newItem);
        newItem.actualAmount = expensePaid(newItem);
        list.push(newItem);
      }
    } else {
      var amount = num($('fAmount').value);
      if (item) {
        item.name = name; item.date = date; item.amount = amount;
        touchRecord(item);
      } else {
        list.push({ id: uid(), name: name, amount: amount, date: date, updatedAt: nowISO() });
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
    markDeleted(ed.id);
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
    touchBudget(key);
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
    $('quickEntryBtn').addEventListener('click', openQuickEntry);
    $('quickEntryForm').addEventListener('submit', submitQuickEntry);
    $('quickEntryCancelBtn').addEventListener('click', closeQuickEntry);
    $('quickEntryMask').addEventListener('click', closeQuickEntry);
    $('quickUndoBtn').addEventListener('click', undoLastAction);
    $('quickChips').addEventListener('click', function (e) {
      var chip = e.target.closest('.quick-chip');
      if (!chip) return;
      $('fQuickNote').value = chip.getAttribute('data-note') || '';
      var amount = num(chip.getAttribute('data-amount'));
      if (amount > 0) $('fQuickAmount').value = amount;
      var categoryId = normalizeCategoryId(chip.getAttribute('data-category-id'));
      $('fQuickCategory').value = categoryId;
      document.querySelectorAll('#quickCategoryChips .category-chip').forEach(function (item) {
        item.classList.toggle('active', item.getAttribute('data-category-id') === categoryId);
      });
      var planId = chip.getAttribute('data-plan-id') || '';
      if (planId) $('fQuickPlan').value = planId;
      $('fQuickAmount').focus();
    });
    $('quickCategoryChips').addEventListener('click', function (e) {
      var chip = e.target.closest('.category-chip');
      if (!chip) return;
      var categoryId = normalizeCategoryId(chip.getAttribute('data-category-id'));
      $('fQuickCategory').value = categoryId;
      this.querySelectorAll('.category-chip').forEach(function (item) {
        item.classList.toggle('active', item === chip);
      });
    });
    $('fQuickPlan').addEventListener('change', function () {
      var plan = this.value ? findItem('expenses', this.value) : null;
      if (!plan) return;
      var categoryId = normalizeCategoryId(plan.categoryId);
      $('fQuickCategory').value = categoryId;
      document.querySelectorAll('#quickCategoryChips .category-chip').forEach(function (item) {
        item.classList.toggle('active', item.getAttribute('data-category-id') === categoryId);
      });
      if (!$('fQuickNote').value) $('fQuickNote').value = plan.name || '';
    });

    $('expenseDetailCloseBtn').addEventListener('click', closeExpenseDetailDrawer);
    $('expenseDetailMask').addEventListener('click', closeExpenseDetailDrawer);
    $('metricDetailCloseBtn').addEventListener('click', closeMetricDetail);
    $('metricDetailMask').addEventListener('click', closeMetricDetail);
    document.querySelectorAll('.metric-summary[data-metric-key]').forEach(function (item) {
      item.addEventListener('click', function () { openMetricDetail(item.getAttribute('data-metric-key')); });
    });

    $('syncRetryBtn').addEventListener('click', retrySync);
    $('memberBookBtn').addEventListener('click', function () { openMemberDrawer(false); });
    $('memberForm').addEventListener('submit', submitMember);
    $('memberCancelBtn').addEventListener('click', closeMemberDrawer);
    $('memberMask').addEventListener('click', closeMemberDrawer);
    document.querySelectorAll('.member-color').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.memberColor = btn.getAttribute('data-color');
        document.querySelectorAll('.member-color').forEach(function (item) {
          item.classList.toggle('active', item === btn);
        });
      });
    });
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
