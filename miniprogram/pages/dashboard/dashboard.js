const L = require('../../utils/ledger.js');

var SEG_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#ef4444', '#0ea5e9'];

function barH(v, maxVal) {
  return maxVal > 0 ? Math.max(2, Math.round((v / maxVal) * 100)) : 2;
}

function fmtTime(iso) {
  try {
    var d = iso ? new Date(iso) : new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch (e) { return ''; }
}

function escMini(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function aiInline(s) {
  return s.replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:700;">$1</strong>');
}
// 把 AI 建议（含 Markdown）转成 rich-text 可渲染的 HTML，段标题加粗高亮。
function aiAdviceHtml(text) {
  var lines = escMini(text).split(/\r?\n/);
  var html = '', listOpen = false;
  function closeList() { if (listOpen) { html += '</ul>'; listOpen = false; } }
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].trim();
    if (!ln) { closeList(); continue; }
    var li = ln.match(/^[-*]\s+(.*)$/) || ln.match(/^\d+[.、)]\s+(.*)$/);
    if (li) {
      if (!listOpen) { html += '<ul style="margin:6rpx 0 12rpx;padding-left:36rpx;">'; listOpen = true; }
      html += '<li style="margin:4rpx 0;">' + aiInline(li[1]) + '</li>';
      continue;
    }
    closeList();
    ln = ln.replace(/^#{1,6}\s+/, '');
    ln = ln.replace(/^\[([^\]]+)\]/, '<strong style="color:#6366f1;font-weight:700;">$1</strong>');
    html += '<p style="margin:0 0 12rpx;">' + aiInline(ln) + '</p>';
  }
  closeList();
  return html;
}

Page({
  data: {
    hasBook: true,
    monthLabel: '',
    year: 0,
    mo: { ranked: [] },
    yr: { cols: [], rateRows: [] },
    ai: { state: 'idle', advice: '', error: '', time: '', cached: false, stale: false }
  },

  onLoad: function () {
    this.cur = L.cycleAnchor(new Date());
  },

  onShow: function () {
    var bookId = L.getSavedBookId();
    if (!bookId) {
      this.setData({ hasBook: false });
      return;
    }
    this.bookId = bookId;
    if (!this.cur) this.cur = L.cycleAnchor(new Date());
    this.setData({ hasBook: true });
    this.renderFrom(L.loadLocal(bookId));
    this.refreshFromCloud(false);
  },

  goPlan: function () {
    wx.switchTab({ url: '/pages/book/book' });
  },

  onPullDownRefresh: function () {
    this.refreshFromCloud(true);
  },

  refreshFromCloud: function (stop) {
    var self = this;
    if (!L.cloudEnabled() || !this.bookId) {
      if (stop) wx.stopPullDownRefresh();
      return;
    }
    L.cloudFetch(this.bookId).then(function (row) {
      if (row && row.data) {
        L.saveLocal(self.bookId, row.data);
        self.renderFrom(row.data);
      }
      if (stop) wx.stopPullDownRefresh();
    }).catch(function () {
      if (stop) wx.stopPullDownRefresh();
    });
  },

  prevMonth: function () {
    this.cur = new Date(this.cur.getFullYear(), this.cur.getMonth() - 1, 1);
    this.renderFrom(L.loadLocal(this.bookId));
  },

  nextMonth: function () {
    this.cur = new Date(this.cur.getFullYear(), this.cur.getMonth() + 1, 1);
    this.renderFrom(L.loadLocal(this.bookId));
  },

  renderFrom: function (data) {
    var key = L.monthKey(this.cur);
    var year = this.cur.getFullYear();

    var o = L.monthOverview(data, key);
    var maxPaid = o.ranked.length ? o.ranked[0].paid : 0;
    var ranked = [];
    for (var i = 0; i < Math.min(o.ranked.length, 8); i++) {
      var it = o.ranked[i];
      var segs = it.segments || [];
      var detail = segs.length && (segs.length > 1 || segs[0].label);
      var vsegs = [];
      if (detail) {
        for (var s = 0; s < segs.length; s++) {
          vsegs.push({
            color: SEG_COLORS[s % SEG_COLORS.length],
            width: it.paid > 0 ? (segs[s].amount / it.paid) * 100 : 0,
            label: segs[s].label || ('第' + (s + 1) + '笔'),
            amount: L.fmt(segs[s].amount)
          });
        }
      }
      ranked.push({
        name: it.name,
        amount: L.fmt(it.paid),
        pct: o.spent > 0 ? Math.round((it.paid / o.spent) * 100) : 0,
        barPct: maxPaid > 0 ? Math.max(4, Math.round((it.paid / maxPaid) * 100)) : 4,
        detail: detail,
        segs: vsegs
      });
    }
    var mo = {
      income: L.fmt(o.income),
      saving: L.fmt(o.saving),
      spent: L.fmt(o.spent),
      balance: L.fmt(o.balance),
      balanceNeg: o.balance < 0,
      actualSpent: L.fmt(o.actualSpent),
      budgetText: o.budget > 0 ? L.fmt(o.budget) : '未设预算',
      execPct: o.execPct,
      execOver: o.execOver,
      ranked: ranked
    };

    var y = L.yearSummary(data, year);
    var cols = [];
    for (var c = 0; c < y.months.length; c++) {
      var x = y.months[c];
      cols.push({
        mo: x.mo,
        incomeH: barH(x.income, y.maxVal),
        savingH: barH(x.saving, y.maxVal),
        expenseH: barH(x.expense, y.maxVal)
      });
    }
    var rateRows = [];
    for (var r = 0; r < y.months.length; r++) {
      var ym = y.months[r];
      if (!ym.income) continue;
      var rate = Math.round((ym.saving / ym.income) * 100);
      rateRows.push({ mo: ym.mo, rate: rate, rateW: Math.min(100, rate) });
    }
    var yr = {
      year: year,
      cols: cols,
      totalIncome: L.fmt(y.totalIncome),
      totalSaving: L.fmt(y.totalSaving),
      totalExpense: L.fmt(y.totalExpense),
      avgExpense: L.fmt(y.avgExpense),
      activeMonths: y.activeMonths,
      yearRate: y.yearRate,
      rateRows: rateRows
    };

    this._ov = o;
    this._key = key;
    var fp = L.overviewFingerprint(o);
    var cache = L.getAiCache(this.bookId, key);
    var ai;
    if (cache && cache.fingerprint === fp && cache.advice) {
      ai = { state: 'done', advice: cache.advice, html: aiAdviceHtml(cache.advice), error: '', time: cache.time || '', cached: true, stale: false };
    } else {
      ai = { state: 'idle', advice: '', html: '', error: '', time: '', cached: false, stale: !!(cache && cache.advice) };
    }

    this.setData({ monthLabel: L.cycleRangeText(this.cur), year: year, mo: mo, yr: yr, ai: ai });
  },

  genAdvice: function (e) {
    var self = this;
    var force = !!(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.force);
    var ov = this._ov;
    var key = this._key;
    if (!ov) return;
    if ((!ov.ranked || !ov.ranked.length) && ov.spent <= 0) {
      self.setData({ ai: { state: 'error', advice: '', error: '本周期还没有开支记录，先记几笔再来生成建议吧', time: '', cached: false, stale: false } });
      return;
    }
    var fp = L.overviewFingerprint(ov);
    if (!force) {
      var cache = L.getAiCache(this.bookId, key);
      if (cache && cache.fingerprint === fp && cache.advice) {
        self.setData({ ai: { state: 'done', advice: cache.advice, html: aiAdviceHtml(cache.advice), error: '', time: cache.time || '', cached: true, stale: false } });
        return;
      }
    }
    self.setData({ 'ai.state': 'loading', 'ai.error': '' });
    L.fetchAiSummary(key, ov).then(function (res) {
      var time = fmtTime(res.generatedAt);
      L.setAiCache(self.bookId, key, { advice: res.advice, fingerprint: fp, time: time });
      self.setData({ ai: { state: 'done', advice: res.advice, html: aiAdviceHtml(res.advice), error: '', time: time, cached: false, stale: false } });
    }).catch(function (err) {
      var msg = (err && err.message) || '生成失败，请重试';
      if (/fail|网络|timeout|abort/i.test(msg)) msg = '网络连接失败，请检查网络后重试';
      self.setData({ ai: { state: 'error', advice: '', error: msg, time: '', cached: false, stale: false } });
    });
  }
});
