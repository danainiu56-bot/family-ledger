/* ============================================
   月度记账本 — 数据层（微信小程序）
   纯计算 + Supabase REST(wx.request) + 本地缓存(wx storage)
   数据结构与口径与现有 H5 完全一致，家人数据互通。
   预算口径：预算总额=收入；预算支出=储蓄+开支(计划)；
            已支出=勾选完成的开支+储蓄；还剩=预算总额-预算支出
   ============================================ */
var config = require('../config.js');

var STORAGE_PREFIX = 'bookkeeping_data_v1';
var SYNC_PREFIX = 'bookkeeping_sync_at';
var BOOK_ID_KEY = 'bookkeeping_book_id';

/* ---------- 基础工具 ---------- */
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
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function newBookId() {
  return 'bk_' + Math.random().toString(36).slice(2, 10);
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

function normalizeBookId(raw) { return (raw || '').trim().toLowerCase(); }
function isValidBookId(id) { return /^[a-z0-9_-]{4,32}$/.test(id); }

/* ---------- 数据模型 ---------- */
function emptyMonth() { return { income: [], savings: [], expenses: [] }; }
function emptyData() { return { budgetByMonth: {}, months: {} }; }
function getMonth(data, key) {
  if (!data.months[key]) data.months[key] = emptyMonth();
  return data.months[key];
}

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

/* ---------- 看板汇总（只读） ---------- */
function monthDataOf(data, key) {
  return (data && data.months && data.months[key]) || { income: [], savings: [], expenses: [] };
}
function monthOverview(data, key) {
  var m = monthDataOf(data, key);
  var income = sum(m.income, 'amount');
  var saving = sum(m.savings, 'amount');
  var spent = completedExpenseTotal(m.expenses);
  var planned = sum(m.expenses, 'plannedAmount');
  var budget = num((data && data.budgetByMonth ? data.budgetByMonth[key] : 0));
  var actualSpent = saving + spent;
  var ranked = [];
  for (var i = 0; i < m.expenses.length; i++) {
    var ex = m.expenses[i];
    var paid = expensePaid(ex);
    if (paid <= 0) continue;
    var segs = [];
    if (ex.payments && ex.payments.length) {
      for (var pi = 0; pi < ex.payments.length; pi++) {
        var amt = num(ex.payments[pi].amount);
        if (amt > 0) segs.push({ label: (ex.payments[pi].note || '').trim(), amount: amt });
      }
    }
    ranked.push({ name: ex.name, paid: paid, segments: segs });
  }
  ranked.sort(function (a, b) { return b.paid - a.paid; });
  return {
    income: income, saving: saving, spent: spent, planned: planned,
    budget: budget, actualSpent: actualSpent, balance: income - actualSpent,
    execPct: budget > 0 ? Math.min(100, Math.round((actualSpent / budget) * 100)) : 0,
    execOver: budget > 0 && actualSpent > budget,
    ranked: ranked
  };
}
function yearSummary(data, year) {
  var months = [];
  var maxVal = 0, totalIncome = 0, totalSaving = 0, totalExpense = 0, activeMonths = 0;
  for (var mo = 1; mo <= 12; mo++) {
    var md = monthDataOf(data, year + '-' + pad2(mo));
    var inc = sum(md.income, 'amount');
    var sav = sum(md.savings, 'amount');
    var exp = completedExpenseTotal(md.expenses);
    if (inc > maxVal) maxVal = inc;
    if (sav > maxVal) maxVal = sav;
    if (exp > maxVal) maxVal = exp;
    totalIncome += inc; totalSaving += sav; totalExpense += exp;
    if (inc || sav || exp) activeMonths++;
    months.push({ mo: mo, income: inc, saving: sav, expense: exp });
  }
  return {
    months: months, maxVal: maxVal,
    totalIncome: totalIncome, totalSaving: totalSaving, totalExpense: totalExpense,
    activeMonths: activeMonths,
    avgExpense: activeMonths ? totalExpense / activeMonths : 0,
    yearRate: totalIncome > 0 ? Math.round((totalSaving / totalIncome) * 100) : 0
  };
}

/* ---------- 本地缓存 ---------- */
function dataStorageKey(bookId) { return STORAGE_PREFIX + '_' + (bookId || '_none'); }
function syncStorageKey(bookId) { return SYNC_PREFIX + '_' + (bookId || '_none'); }

function loadLocal(bookId) {
  if (!bookId) return emptyData();
  try {
    var raw = wx.getStorageSync(dataStorageKey(bookId));
    if (!raw) return emptyData();
    var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data.budgetByMonth) data.budgetByMonth = {};
    if (!data.months) data.months = {};
    return data;
  } catch (e) {
    return emptyData();
  }
}
function saveLocal(bookId, data) {
  if (!bookId) return;
  try {
    wx.setStorageSync(dataStorageKey(bookId), JSON.stringify(data));
  } catch (e) {}
}
function getSyncAt(bookId) {
  try { return wx.getStorageSync(syncStorageKey(bookId)) || ''; } catch (e) { return ''; }
}
function setSyncAt(bookId, at) {
  try { wx.setStorageSync(syncStorageKey(bookId), at); } catch (e) {}
}
function getSavedBookId() {
  try { return normalizeBookId(wx.getStorageSync(BOOK_ID_KEY)); } catch (e) { return ''; }
}
function setSavedBookId(id) {
  try { wx.setStorageSync(BOOK_ID_KEY, id); } catch (e) {}
}

/* ---------- 云端（Supabase REST） ---------- */
function cloudEnabled() {
  return !!(config.supabaseUrl && config.supabaseAnonKey);
}
function supabaseHost() {
  var m = /^https?:\/\/[^/]+/.exec(config.supabaseUrl || '');
  return m ? m[0] : (config.supabaseUrl || '');
}
function headers(extra) {
  var h = {
    apikey: config.supabaseAnonKey,
    Authorization: 'Bearer ' + config.supabaseAnonKey,
    'Content-Type': 'application/json'
  };
  if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  return h;
}
function parseErr(res) {
  var d = res && res.data;
  if (d && d.message) return d.message;
  if (typeof d === 'string' && d) return d;
  return 'HTTP ' + (res ? res.statusCode : '?');
}
function cloudFetch(bookId) {
  return new Promise(function (resolve, reject) {
    wx.request({
      url: config.supabaseUrl + '/rest/v1/ledgers?id=eq.' +
        encodeURIComponent(bookId) + '&select=data,updated_at',
      method: 'GET',
      header: headers(),
      success: function (res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          var rows = res.data || [];
          resolve(rows.length ? rows[0] : null);
        } else {
          reject(new Error(parseErr(res)));
        }
      },
      fail: function (err) { reject(new Error((err && err.errMsg) || '网络错误')); }
    });
  });
}
function cloudPush(bookId, data) {
  var updated_at = new Date().toISOString();
  return new Promise(function (resolve, reject) {
    wx.request({
      url: config.supabaseUrl + '/rest/v1/ledgers?on_conflict=id',
      method: 'POST',
      header: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      data: { id: bookId, data: data, updated_at: updated_at },
      success: function (res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          setSyncAt(bookId, updated_at);
          resolve(updated_at);
        } else {
          reject(new Error(parseErr(res)));
        }
      },
      fail: function (err) { reject(new Error((err && err.errMsg) || '网络错误')); }
    });
  });
}

/* ---------- AI 开支建议 ---------- */
var AI_PREFIX = 'bookkeeping_ai_advice';
function aiStorageKey(bookId, key) { return AI_PREFIX + '_' + (bookId || '_none') + '_' + key; }
function overviewFingerprint(ov) {
  if (!ov) return '0';
  var parts = [ov.income, ov.saving, ov.spent, ov.planned, ov.budget];
  var ranked = ov.ranked || [];
  for (var i = 0; i < ranked.length; i++) {
    parts.push(ranked[i].name + ':' + ranked[i].paid);
    var segs = ranked[i].segments || [];
    for (var j = 0; j < segs.length; j++) parts.push((segs[j].label || '') + '=' + segs[j].amount);
  }
  var s = parts.join('|');
  var h = 5381;
  for (var k = 0; k < s.length; k++) h = ((h << 5) + h + s.charCodeAt(k)) | 0;
  return String(h >>> 0);
}
function getAiCache(bookId, key) {
  try {
    var raw = wx.getStorageSync(aiStorageKey(bookId, key));
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { return null; }
}
function setAiCache(bookId, key, obj) {
  try { wx.setStorageSync(aiStorageKey(bookId, key), JSON.stringify(obj)); } catch (e) {}
}
function fetchAiSummary(key, ov) {
  return new Promise(function (resolve, reject) {
    wx.request({
      url: config.supabaseUrl + '/functions/v1/ai-summary',
      method: 'POST',
      header: headers(),
      data: { monthKey: key, overview: ov },
      success: function (res) {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data && res.data.advice) {
          resolve(res.data);
        } else {
          reject(new Error((res.data && res.data.error) || parseErr(res)));
        }
      },
      fail: function (err) { reject(new Error((err && err.errMsg) || '网络错误')); }
    });
  });
}

module.exports = {
  // 工具
  pad2: pad2, monthKey: monthKey, cycleAnchor: cycleAnchor, cycleRangeText: cycleRangeText,
  todayISO: todayISO, uid: uid, newBookId: newBookId,
  num: num, fmt: fmt, normalizeBookId: normalizeBookId, isValidBookId: isValidBookId,
  // 模型
  emptyMonth: emptyMonth, emptyData: emptyData, getMonth: getMonth,
  // 计算
  sum: sum, expensePaid: expensePaid, expenseStatus: expenseStatus,
  ensurePayments: ensurePayments, expensePaymentCount: expensePaymentCount,
  paymentNotesSummary: paymentNotesSummary,
  refreshExpenseDone: refreshExpenseDone, sortExpensesForDisplay: sortExpensesForDisplay,
  completedExpenseTotal: completedExpenseTotal, calcActualSpent: calcActualSpent,
  // 看板
  monthOverview: monthOverview, yearSummary: yearSummary,
  // 缓存
  loadLocal: loadLocal, saveLocal: saveLocal, getSyncAt: getSyncAt, setSyncAt: setSyncAt,
  getSavedBookId: getSavedBookId, setSavedBookId: setSavedBookId,
  // 云端
  cloudEnabled: cloudEnabled, supabaseHost: supabaseHost,
  cloudFetch: cloudFetch, cloudPush: cloudPush,
  // AI 建议
  fetchAiSummary: fetchAiSummary, overviewFingerprint: overviewFingerprint,
  getAiCache: getAiCache, setAiCache: setAiCache
};
