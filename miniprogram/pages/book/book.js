/* ============================================
   月度记账本 — 页面逻辑（微信小程序）
   本地缓存 + Supabase 轮询同步（约 15s），与 H5 共享同一账本
   ============================================ */
var L = require('../../utils/ledger.js');

var POLL_MS = 15000;
var SYNC_LABELS = { '': '', ok: '已同步', syncing: '同步中…', err: '同步失败', live: '实时同步' };

Page({
  data: {
    monthKey: '',
    monthPickerValue: '',
    cloudEnabled: false,
    bookId: '',
    syncStatus: '',
    syncLabel: '',
    syncFailed: false,
    syncErrorMsg: '',

    budgetText: '¥0',
    budgetOutText: '¥0',
    actualSpentText: '¥0',
    remainText: '¥0',
    remainOver: false,
    progressPct: 0,
    progressOver: false,
    incomeTotalText: '¥0',
    savingTotalText: '¥0',
    plannedTotalText: '¥0',
    incomeSumText: '¥0',
    savingSumText: '¥0',
    expenseSumText: '已花 ¥0 / 计划 ¥0 / 还剩 ¥0',

    incomeRows: [],
    savingRows: [],
    expenseRows: [],

    // 弹层
    drawerEntry: false,
    drawerPayment: false,
    drawerBudget: false,
    drawerBook: false,
    drawerShare: false,

    // 明细表单
    entryTitle: '添加',
    entryIsExpense: false,
    entryEditing: false,
    entryPaidText: '¥0',
    entryRemainText: '¥0',
    f: { name: '', amount: '', planned: '', payment: '', date: '' },

    // 记支出
    payTitle: '记支出',
    payPaidText: '¥0',
    payRemainText: '¥0',
    pay: { amount: '', date: '' },

    budgetInput: '',
    bookInput: ''
  },

  /* ---------- 生命周期 ---------- */
  onLoad: function (options) {
    this._book = {
      id: '',
      data: L.emptyData(),
      current: new Date(),
      editing: null,
      payingId: null,
      bookForce: false
    };
    this._pollTimer = null;
    this.setData({ cloudEnabled: L.cloudEnabled() });
    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });

    var urlBook = L.normalizeBookId(options && options.book);
    var savedBook = L.getSavedBookId();
    this._book.id = urlBook || savedBook;

    if (this._book.id) {
      this.applyBookId(this._book.id);
      this.pullFromCloud(false, !!urlBook).then(this.recompute.bind(this));
    } else if (L.cloudEnabled()) {
      this.joinBook(L.newBookId(), true);
    } else {
      this.recompute();
    }
  },

  onShow: function () {
    if (this._book && this._book.id) {
      this.pullFromCloud(true).then(this.recompute.bind(this));
      this.startPoll();
    }
  },
  onHide: function () { this.stopPoll(); },
  onUnload: function () { this.stopPoll(); },
  onPullDownRefresh: function () {
    var that = this;
    this.pullFromCloud(false, false).then(function () {
      that.recompute();
      wx.stopPullDownRefresh();
    });
  },

  /* ---------- 同步 ---------- */
  startPoll: function () {
    this.stopPoll();
    if (!L.cloudEnabled() || !this._book.id) return;
    var that = this;
    this._pollTimer = setInterval(function () {
      that.pullFromCloud(true).then(function (changed) {
        if (changed) that.recompute();
      });
    }, POLL_MS);
  },
  stopPoll: function () {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },
  setSync: function (status) {
    this.setData({ syncStatus: status, syncLabel: SYNC_LABELS[status] || '' });
  },
  applyCloudRow: function (row, force) {
    if (!row || !row.data) return false;
    var localAt = L.getSyncAt(this._book.id);
    if (force || !localAt || row.updated_at > localAt) {
      var data = row.data;
      if (!data.budgetByMonth) data.budgetByMonth = {};
      if (!data.months) data.months = {};
      this._book.data = data;
      L.saveLocal(this._book.id, data);
      L.setSyncAt(this._book.id, row.updated_at);
      this.setData({ syncFailed: false });
      return true;
    }
    return false;
  },
  pullFromCloud: function (silent, force) {
    var that = this;
    if (!L.cloudEnabled() || !this._book.id) return Promise.resolve(false);
    if (!silent) this.setSync('syncing');
    return L.cloudFetch(this._book.id).then(function (row) {
      if (!row) {
        return L.cloudPush(that._book.id, that._book.data).then(function () {
          that.setSync('ok');
          return false;
        });
      }
      var changed = that.applyCloudRow(row, force);
      that.setSync('ok');
      return changed;
    }).catch(function (err) {
      that.setSync('err');
      var msg = (err && err.message) ? err.message : '';
      if (msg.indexOf('ledgers') !== -1 || msg.indexOf('PGRST') !== -1) {
        that.setData({ syncFailed: true, syncErrorMsg: '云端表 ledgers 未创建，家人无法看到数据。' });
      } else {
        that.setData({ syncFailed: true, syncErrorMsg: '云端同步失败：' + msg });
      }
      return false;
    });
  },
  save: function () {
    var that = this;
    L.saveLocal(this._book.id, this._book.data);
    if (L.cloudEnabled() && this._book.id) {
      this.setSync('syncing');
      L.cloudPush(this._book.id, this._book.data).then(function () {
        that.setSync('ok');
      }).catch(function (err) {
        that.setSync('err');
        var msg = (err && err.message) ? err.message : '';
        that.setData({ syncFailed: true, syncErrorMsg: '保存到云端失败：' + msg + '，家人可能看不到最新数据。' });
      });
    }
  },
  retrySync: function () {
    var that = this;
    if (!L.cloudEnabled() || !this._book.id) return;
    this.setData({ syncFailed: false });
    this.setSync('syncing');
    L.cloudPush(this._book.id, this._book.data).then(function () {
      that.setSync('ok');
      wx.showToast({ title: '同步成功', icon: 'none' });
    }).catch(function () {
      that.pullFromCloud(false, false).then(that.recompute.bind(that));
    });
  },

  /* ---------- 账本 ---------- */
  applyBookId: function (id) {
    id = L.normalizeBookId(id);
    this._book.id = id;
    L.setSavedBookId(id);
    this._book.data = L.loadLocal(id);
    this.setData({ bookId: id });
  },
  joinBook: function (id, isNew) {
    var that = this;
    id = L.normalizeBookId(id);
    if (!L.isValidBookId(id)) {
      wx.showToast({ title: '账本编号格式不正确', icon: 'none' });
      return Promise.resolve(false);
    }
    this.stopPoll();
    this.applyBookId(id);
    return this.pullFromCloud(false, true).then(function () {
      that.setData({ drawerBook: false });
      that.recompute();
      that.startPoll();
      if (isNew) wx.showToast({ title: '已创建家庭账本', icon: 'none' });
      return true;
    });
  },
  openBookSetup: function () {
    this.setData({ drawerBook: true, bookInput: this._book.id || '' });
  },
  closeBookSetup: function () {
    if (this._book.bookForce && !this._book.id) return;
    this.setData({ drawerBook: false });
  },
  createBook: function () { this.joinBook(L.newBookId(), true); },
  joinBookByInput: function () { this.joinBook(this.data.bookInput, false); },

  /* ---------- 分享 ---------- */
  openShare: function () {
    if (!this._book.id) { wx.showToast({ title: '请先创建或加入账本', icon: 'none' }); return; }
    this.setData({ drawerShare: true });
  },
  closeShare: function () { this.setData({ drawerShare: false }); },
  copyBookId: function () {
    var that = this;
    wx.setClipboardData({
      data: this._book.id,
      success: function () { wx.showToast({ title: '已复制账本编号', icon: 'none' }); that.closeShare(); }
    });
  },
  onShareAppMessage: function () {
    var key = this.data.monthKey || L.monthKey(this._book.current);
    return {
      title: '一起记账：' + key + ' 家庭记账本',
      path: '/pages/book/book?book=' + encodeURIComponent(this._book.id)
    };
  },
  onShareTimeline: function () {
    return { title: '家庭记账本', query: 'book=' + encodeURIComponent(this._book.id) };
  },

  /* ---------- 月份 ---------- */
  prevMonth: function () {
    this._book.current.setMonth(this._book.current.getMonth() - 1);
    this.recompute();
  },
  nextMonth: function () {
    this._book.current.setMonth(this._book.current.getMonth() + 1);
    this.recompute();
  },
  onMonthPick: function (e) {
    var parts = e.detail.value.split('-');
    this._book.current = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, 1);
    this.recompute();
  },

  /* ---------- 输入 ---------- */
  onInput: function (e) {
    var k = e.currentTarget.dataset.k;
    var v = e.detail.value;
    if (k === 'budget') { this.setData({ budgetInput: v }); return; }
    if (k === 'book') { this.setData({ bookInput: v }); return; }
    if (k === 'payAmount') { this.setData({ 'pay.amount': v }); return; }
    this.setData(pairsForEntry(k, v));
  },
  onDatePick: function (e) { this.setData({ 'f.date': e.detail.value }); },
  onPayDatePick: function (e) { this.setData({ 'pay.date': e.detail.value }); },
  noop: function () {},

  /* ---------- 明细抽屉 ---------- */
  openAdd: function (e) { this.openEntry(e.currentTarget.dataset.type, null); },
  openEdit: function (e) {
    var ds = e.currentTarget.dataset;
    this.openEntry(ds.type, ds.id);
  },
  openEditExpense: function (e) { this.openEntry('expenses', e.currentTarget.dataset.id); },

  openEntry: function (type, id) {
    this._book.editing = { type: type, id: id || null };
    var isExpense = type === 'expenses';
    var titleMap = { income: '收入', savings: '储蓄', expenses: '开支' };
    var item = id ? this.findItem(type, id) : null;
    var f = { name: '', amount: '', planned: '', payment: '', date: L.todayISO() };
    var paidText = '¥0', remainText = '¥0';

    if (item) {
      f.name = item.name;
      f.date = item.date || L.todayISO();
      if (isExpense) {
        f.planned = item.plannedAmount === 0 ? '0' : (item.plannedAmount || '');
        var paid = L.expensePaid(item);
        var planned = L.num(item.plannedAmount);
        paidText = L.fmt(paid);
        remainText = L.fmt(Math.max(0, planned - paid));
      } else {
        f.amount = item.amount === 0 ? '0' : (item.amount || '');
      }
    }

    this.setData({
      drawerEntry: true,
      entryIsExpense: isExpense,
      entryEditing: !!id,
      entryTitle: (id ? '编辑' : '添加') + titleMap[type],
      entryPaidText: paidText,
      entryRemainText: remainText,
      f: f
    });
  },

  submitEntry: function () {
    var ed = this._book.editing;
    if (!ed) return;
    var f = this.data.f;
    var name = (f.name || '').trim();
    if (!name) { wx.showToast({ title: '请输入名称', icon: 'none' }); return; }
    var date = f.date || L.todayISO();
    var key = L.monthKey(this._book.current);
    var list = L.getMonth(this._book.data, key)[ed.type];
    var item = ed.id ? this.findItem(ed.type, ed.id) : null;

    if (ed.type === 'expenses') {
      var planned = L.num(f.planned);
      var paymentAmt = L.num(f.payment);
      if (item) {
        item.name = name;
        item.date = date;
        item.plannedAmount = planned;
        L.ensurePayments(item);
        if (paymentAmt > 0) item.payments.push({ id: L.uid(), amount: paymentAmt, date: date });
        L.refreshExpenseDone(item);
        item.actualAmount = L.expensePaid(item);
      } else {
        var newItem = {
          id: L.uid(), name: name, plannedAmount: planned, date: date,
          payments: [], done: false, actualAmount: ''
        };
        if (paymentAmt > 0) newItem.payments.push({ id: L.uid(), amount: paymentAmt, date: date });
        L.refreshExpenseDone(newItem);
        newItem.actualAmount = L.expensePaid(newItem);
        list.push(newItem);
      }
    } else {
      var amount = L.num(f.amount);
      if (item) { item.name = name; item.date = date; item.amount = amount; }
      else { list.push({ id: L.uid(), name: name, amount: amount, date: date }); }
    }
    if (ed.type === 'income') this.syncBudgetFromIncome(key);
    this.save();
    this.recompute();
    this.closeDrawers();
  },

  deleteEntry: function () {
    var that = this;
    var ed = this._book.editing;
    if (!ed || !ed.id) return;
    wx.showModal({
      title: '删除', content: '确定删除这条记录？',
      success: function (r) {
        if (!r.confirm) return;
        var key = L.monthKey(that._book.current);
        var list = L.getMonth(that._book.data, key)[ed.type];
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === ed.id) { list.splice(i, 1); break; }
        }
        if (ed.type === 'income') that.syncBudgetFromIncome(key);
        that.save();
        that.recompute();
        that.closeDrawers();
      }
    });
  },
  closeDrawers: function () {
    this._book.editing = null;
    this.setData({ drawerEntry: false, drawerBudget: false });
  },

  /* ---------- 记支出 ---------- */
  toggleDone: function (e) {
    var id = e.currentTarget.dataset.id;
    var item = this.findItem('expenses', id);
    if (!item) return;
    L.ensurePayments(item);
    var planned = L.num(item.plannedAmount);
    if (L.expenseStatus(item) === 'done') {
      while (item.payments.length && L.expensePaid(item) >= planned) item.payments.pop();
      item.done = false;
      delete item.completedAt;
      if (!item.payments.length) { delete item.payments; item.actualAmount = ''; }
      else { item.actualAmount = L.expensePaid(item); }
      this.save();
      this.recompute();
      wx.showToast({ title: '已取消完成', icon: 'none' });
      return;
    }
    var paid = L.expensePaid(item);
    var remainder = Math.max(0, planned - paid);
    if (remainder > 0) item.payments.push({ id: L.uid(), amount: remainder, date: L.todayISO() });
    L.refreshExpenseDone(item);
    item.actualAmount = L.expensePaid(item);
    this.save();
    this.recompute();
  },
  openPayment: function (e) {
    var id = e.currentTarget.dataset.id;
    var item = this.findItem('expenses', id);
    if (!item || L.expenseStatus(item) === 'done') return;
    this._book.payingId = id;
    var paid = L.expensePaid(item);
    var planned = L.num(item.plannedAmount);
    this.setData({
      drawerPayment: true,
      payTitle: '记支出 · ' + item.name,
      payPaidText: L.fmt(paid),
      payRemainText: L.fmt(Math.max(0, planned - paid)),
      pay: { amount: '', date: L.todayISO() }
    });
  },
  closePayment: function () {
    this._book.payingId = null;
    this.setData({ drawerPayment: false });
  },
  submitPayment: function () {
    var id = this._book.payingId;
    if (!id) return;
    var item = this.findItem('expenses', id);
    if (!item) return;
    var amt = L.num(this.data.pay.amount);
    if (amt <= 0) { wx.showToast({ title: '请输入本次支出金额', icon: 'none' }); return; }
    L.ensurePayments(item);
    item.payments.push({ id: L.uid(), amount: amt, date: this.data.pay.date || L.todayISO() });
    L.refreshExpenseDone(item);
    item.actualAmount = L.expensePaid(item);
    this.save();
    this.recompute();
    var done = L.expenseStatus(item) === 'done';
    this.closePayment();
    wx.showToast({ title: done ? '已完成全部支出' : '已记录部分支出', icon: 'none' });
  },

  /* ---------- 预算 ---------- */
  openBudget: function () {
    var key = L.monthKey(this._book.current);
    var v = this._book.data.budgetByMonth[key];
    this.setData({ drawerBudget: true, budgetInput: v || '' });
  },
  submitBudget: function () {
    var key = L.monthKey(this._book.current);
    this._book.data.budgetByMonth[key] = L.num(this.data.budgetInput);
    this.save();
    this.recompute();
    this.closeDrawers();
  },

  /* ---------- 辅助 ---------- */
  findItem: function (type, id) {
    var list = L.getMonth(this._book.data, L.monthKey(this._book.current))[type];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  },
  syncBudgetFromIncome: function (key) {
    var m = L.getMonth(this._book.data, key);
    this._book.data.budgetByMonth[key] = L.sum(m.income, 'amount');
  },

  /* ---------- 渲染 ---------- */
  recompute: function () {
    var b = this._book;
    var key = L.monthKey(b.current);
    var m = L.getMonth(b.data, key);

    var incomeT = L.sum(m.income, 'amount');
    var savingT = L.sum(m.savings, 'amount');
    var plannedT = L.sum(m.expenses, 'plannedAmount');
    var expenseDone = L.completedExpenseTotal(m.expenses);
    var budget = L.num(b.data.budgetByMonth[key]);
    var budgetOut = savingT + plannedT;
    var actualSpent = L.calcActualSpent(m);
    var remain = budget - budgetOut;
    var pct = budget > 0 ? Math.min(100, (budgetOut / budget) * 100) : 0;
    var expenseRemain = plannedT - expenseDone;

    var incomeRows = m.income.map(function (it) {
      return { id: it.id, name: it.name, date: it.date || '', amountText: L.fmt(L.num(it.amount)) };
    });
    var savingRows = m.savings.map(function (it) {
      return { id: it.id, name: it.name, date: it.date || '', amountText: L.fmt(L.num(it.amount)) };
    });
    var expenseRows = L.sortExpensesForDisplay(m.expenses).map(function (it) {
      var status = L.expenseStatus(it);
      var paid = L.expensePaid(it);
      var planned = L.num(it.plannedAmount);
      var remainEx = Math.max(0, planned - paid);
      var row = {
        id: it.id,
        name: it.name,
        nameDone: status === 'done',
        metaText: (it.date || '') + (status === 'done' ? ' · 已完成' : (status === 'partial' ? ' · 部分支出' : ' · 待支出')),
        checkClass: status === 'done' ? 'done' : (status === 'partial' ? 'partial' : ''),
        checkText: status === 'done' ? '✓' : (status === 'partial' ? '·' : ''),
        showPay: status !== 'done',
        amtClass: '',
        mainText: '',
        subText: ''
      };
      if (status === 'pending') {
        row.amtClass = 'pending';
        row.mainText = '计划 ' + L.fmt(planned);
      } else if (status === 'partial') {
        row.amtClass = 'partial-main';
        row.mainText = L.fmt(remainEx);
        row.subText = '计划 ' + L.fmt(planned) + ' / 部分支出 ' + L.expensePaymentCount(it) + '笔';
      } else {
        row.amtClass = '';
        row.mainText = L.fmt(paid);
        row.subText = '计划 ' + L.fmt(planned) + ' / 已完成';
      }
      return row;
    });

    this.setData({
      monthKey: key,
      monthPickerValue: key + '-01',
      bookId: b.id,
      cloudEnabled: L.cloudEnabled(),
      budgetText: budget ? L.fmt(budget) : '¥0',
      budgetOutText: L.fmt(budgetOut),
      actualSpentText: L.fmt(actualSpent),
      remainText: L.fmt(remain),
      remainOver: remain < 0,
      progressPct: pct,
      progressOver: budget > 0 && budgetOut > budget,
      incomeTotalText: L.fmt(incomeT),
      savingTotalText: L.fmt(savingT),
      plannedTotalText: L.fmt(plannedT),
      incomeSumText: L.fmt(incomeT),
      savingSumText: L.fmt(savingT),
      expenseSumText: '已花 ' + L.fmt(expenseDone) + ' / 计划 ' + L.fmt(plannedT) + ' / 还剩 ' + L.fmt(expenseRemain),
      incomeRows: incomeRows,
      savingRows: savingRows,
      expenseRows: expenseRows
    });
  }
});

function pairsForEntry(k, v) {
  var o = {};
  o['f.' + k] = v;
  return o;
}
