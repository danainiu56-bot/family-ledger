const L = require('../../utils/ledger.js');

var SEG_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#ef4444', '#0ea5e9'];

function barH(v, maxVal) {
  return maxVal > 0 ? Math.max(2, Math.round((v / maxVal) * 100)) : 2;
}

Page({
  data: {
    hasBook: true,
    monthLabel: '',
    year: 0,
    mo: { ranked: [] },
    yr: { cols: [], rateRows: [] }
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

    this.setData({ monthLabel: L.cycleRangeText(this.cur), year: year, mo: mo, yr: yr });
  }
});
