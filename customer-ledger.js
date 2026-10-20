(() => {
  const LEDGER_KEY = 'probashi-customer-ledger';
  const PROFILE_KEY = 'probashi-customer-profiles';
  const BACKUP_KEYS = ['probashi-orders','probashi-products','probashi-expenses','probashi-purchases','probashi-balances','probashi-store-settings','probashi-store-name',LEDGER_KEY,PROFILE_KEY];
  const read = (key, fallback) => {
    try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; }
    catch { return fallback; }
  };
  const isEnglish = () => { try { return localStorage.getItem('probashi-language') === 'en'; } catch { return false; } };
  const write = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { notify('Could not save. Browser storage may be full or unavailable.'); return false; }
  };
  let ledger = read(LEDGER_KEY, []);
  let profiles = read(PROFILE_KEY, {});
  if (!Array.isArray(ledger)) ledger = [];
  ledger = ledger.filter(entry => entry && typeof entry === 'object' && typeof entry.cid === 'string' && entry.cid && ['due','payment','adjustment'].includes(entry.type) && Number.isFinite(Number(entry.amount)));
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) profiles = {};
  let selectedCustomer = '';
  let correctionTarget = '';
  let editingCustomer = '';
  let editReturnTo = 'list';
  const priorOrderStatus = new Map();

  const normalized = value => String(value || '').trim().toLowerCase();
  // The app gives walk-in sales a synthetic email. Use the customer's name for
  // those records so Bengali names do not collapse into the same empty slug.
  const customerKey = (name, email) => email && !/@walkin\.local$/i.test(email)
    ? `email:${normalized(email)}`
    : (normalized(name) ? `name:${normalized(name)}` : '');
  const saleCustomerKey = sale => customerKey(sale.name, sale.email || '');
  const entryId = () => globalThis.crypto?.randomUUID?.() || `L-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const dateISO = value => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return value;
    const parsed = new Date(value || '');
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0,10) : parsed.toISOString().slice(0,10);
  };
  ledger = ledger.map(entry => ({...entry,amount:Number(entry.amount),date:dateISO(entry.date)}));
  const entryEffect = entry => entry.type === 'payment' ? -Number(entry.amount || 0) : Number(entry.amount || 0);
  const entriesFor = key => ledger.filter(entry => entry.cid === key).sort((a,b) => dateISO(a.date).localeCompare(dateISO(b.date)) || ({due:0,payment:1,adjustment:2}[a.type]??3)-({due:0,payment:1,adjustment:2}[b.type]??3) || String(a.id).localeCompare(String(b.id)));
  const balanceFor = key => entriesFor(key).reduce((sum,entry) => sum + entryEffect(entry), 0);
  const money = amount => `৳ ${Number(amount || 0).toLocaleString('en-BD')}`;
  const persistLedger = () => write(LEDGER_KEY, ledger);
  const persistProfiles = () => write(PROFILE_KEY, profiles);

  function pushEntry({cid, customerName, type, amount, note, date, saleId, correctionOf, allocations, account}) {
    const entry = {id:entryId(),date:dateISO(date),cid,customerName:String(customerName || ''),type,amount:Number(amount),note:String(note || ''),...(saleId?{saleId}:{}),...(correctionOf?{correctionOf}:{}),...(allocations?{allocations}:{}),...(account?{account}:{})};
    ledger.push(entry);
    if (!persistLedger()) { ledger.pop(); return null; }
    return entry;
  }

  function applyPaymentToSales(cid, delta) {
    let remaining=Math.abs(Number(delta)||0);
    const candidates=orders.filter(sale=>sale.status!=='Cancelled'&&saleCustomerKey(sale)===cid)
      .sort((a,b)=>dateISO(a.saleDate||a.date).localeCompare(dateISO(b.saleDate||b.date)));
    const allocations=[];
    const list=delta<0?candidates.slice().reverse():candidates;
    for (const sale of list) {
      const total=Math.max(0,Number(sale.total)||0),paid=Math.min(total,Math.max(0,Number(sale.paidAmount??(sale.status==='Paid'?total:0))||0));
      const available=delta<0?paid:total-paid;
      const portion=Math.min(available,remaining);
      if (!portion) continue;
      sale.paidAmount=paid+(delta<0?-portion:portion);
      if (sale.paidAmount>=total) sale.status='Paid';
      else if (sale.status==='Paid') sale.status='Pending';
      allocations.push({saleId:sale.id,amount:delta<0?-portion:portion});
      remaining-=portion;
      if (remaining<0.005) break;
    }
    try { localStorage.setItem('probashi-orders',JSON.stringify(orders)); } catch { notify('Payment was saved, but the related order balance could not be updated.'); }
    return allocations;
  }

  function updateAccountBalance(account, delta) {
    try {
      const balances=JSON.parse(localStorage.getItem('probashi-balances')||'{"cash":0,"bank":0}');
      balances[account]=Number(balances[account]||0)+Number(delta||0);
      accountBalances[account]=balances[account];
      localStorage.setItem('probashi-balances',JSON.stringify(balances));
    } catch { notify('Payment was saved, but the account balance could not be updated.'); }
  }

  function migrateSales() {
    let changed = false, profilesChanged = false;
    for (const sale of orders) {
      if (sale.status === 'Cancelled') continue;
      const cid = saleCustomerKey(sale);
      if (cid && profiles[cid]?.archived && sale.id && !profiles[cid].archivedOrderIds?.includes(sale.id)) {
        profiles[cid].archived = false;
        delete profiles[cid].archivedOrderIds;
        profilesChanged = true;
      }
      if (!cid || !sale.id || ledger.some(entry => entry.saleId === sale.id && entry.type === 'due')) continue;
      const total = Math.max(0, Number(sale.total) || 0);
      const paid = Math.min(total, Math.max(0, Number(sale.paidAmount ?? (sale.status === 'Paid' ? total : 0)) || 0));
      if (sale.paidAmount === undefined) { sale.paidAmount = paid; changed = true; }
      const due = total - paid;
      if (due > 0) {
        ledger.push({id:entryId(),date:dateISO(sale.saleDate || sale.date),cid,customerName:String(sale.name || ''),type:'due',amount:due,note:'Sale invoice',saleId:sale.id});
        changed = true;
      }
    }
    if (changed) {
      try { localStorage.setItem('probashi-orders', JSON.stringify(orders)); } catch { notify('Could not save the migrated order history.'); }
      persistLedger();
    }
    if (profilesChanged) persistProfiles();
  }

  function customerRows() {
    const rows = new Map();
    const ensure = (key,name,email='') => {
      if (!rows.has(key)) rows.set(key,{key,name:name || key,email,phone:'',limit:0,due:0,orders:0,spent:0,lastDate:'',entries:[]});
      return rows.get(key);
    };
    for (const sale of orders) {
      const key = saleCustomerKey(sale);
      if (!key || sale.status === 'Cancelled') continue;
      const row = ensure(key,sale.name,/@walkin\.local$/i.test(sale.email||'')?'':sale.email);
      row.orders++;
      row.spent += Number(sale.total || 0);
      const date = dateISO(sale.saleDate || sale.date);
      if (!row.lastDate || date > row.lastDate) row.lastDate = date;
    }
    for (const entry of ledger) {
      const row = ensure(entry.cid,entry.customerName);
      row.entries.push(entry);
    }
    for (const row of rows.values()) {
      const profile = profiles[row.key] || {};
      row.name = profile.name || row.name;
      row.phone = profile.phone || '';
      row.limit = Math.max(0,Number(profile.limit) || 0);
      row.due = balanceFor(row.key);
      const dueDate = oldestUnpaidDate(row.key);
      row.oldestDue = dueDate;
      row.daysOverdue = dueDate ? Math.max(0,Math.floor((Date.now()-new Date(`${dueDate}T00:00:00`).getTime())/86400000)) : 0;
      row.archived = Boolean(profile.archived);
    }
    return [...rows.values()].filter(row => !row.archived).sort((a,b) => b.due-a.due || a.name.localeCompare(b.name));
  }

  function oldestUnpaidDate(cid) {
    const buckets = [];
    for (const entry of entriesFor(cid)) {
      let amount = entryEffect(entry);
      if (amount > 0) buckets.push({date:dateISO(entry.date),amount});
      else {
        amount = -amount;
        for (const bucket of buckets) {
          const applied = Math.min(bucket.amount,amount);
          bucket.amount -= applied;
          amount -= applied;
          if (!amount) break;
        }
      }
    }
    return buckets.find(bucket => bucket.amount > 0.01)?.date || '';
  }

  function correctionMarkup(entry) {
    if (!entry || entry.type==='adjustment') return '';
    const corrections=ledger.filter(item=>item.type==='adjustment'&&item.correctionOf===entry.id).reduce((sum,item)=>sum+Number(item.amount||0),0);
    const currentAmount=entry.type==='payment'?Number(entry.amount)-corrections:Number(entry.amount)+corrections;
    return `<form class="panel customer-inline-form" id="customer-correction-form" data-entry-id="${escapeHtml(entry.id)}"><h3>Correct ledger entry</h3><p>Original entry stays in history. Save the corrected amount and reason to add an audit adjustment.</p><label class="modal-field">Correct amount<input name="amount" type="number" min="0" step="0.01" value="${currentAmount}" required></label><label class="modal-field">Reason<input name="reason" maxlength="240" required placeholder="Why is this correction needed?"></label><div class="feature-actions"><button class="button-primary" type="submit">Save correction</button><button class="button-secondary" type="button" data-action="cancel-correction">Cancel</button></div></form>`;
  }

  function ledgerHistoryMarkup(row) {
    let running=0;
    const lines=entriesFor(row.key).map(entry=>{
      running+=entryEffect(entry);
      const due=entry.type==='due'?money(entry.amount):'—',payment=entry.type==='payment'?money(entry.amount):'—',adjustment=entry.type==='adjustment'?money(entry.amount):'—';
      const label=entry.type==='due'?'Sale due':entry.type==='payment'?'Payment received':'Correction';
      const detail=`${entry.saleId?`Invoice ${escapeHtml(entry.saleId)} · `:''}${entry.correctionOf?`Corrects ${escapeHtml(entry.correctionOf)} · `:''}${escapeHtml(entry.note||'')}`;
      const correctionAction=entry.type==='adjustment'?'<span>—</span>':`<button class="row-action" data-action="correct-ledger" data-entry-id="${escapeHtml(entry.id)}">Correct</button>`;
      return `<tr><td>${escapeHtml(dateISO(entry.date))}</td><td><b>${label}</b><small>${detail}</small></td><td>${due}</td><td>${payment}</td><td>${adjustment}</td><td>${money(running)}</td><td>${correctionAction}</td></tr>`;
    }).join('');
    return `<section class="panel table-panel customer-ledger-panel"><div class="table-title"><h3>Ledger history</h3><span class="subtle-count">Running balance</span></div><div class="customer-ledger-scroll"><table class="data-table"><thead><tr><th>DATE</th><th>DESCRIPTION</th><th>DUE</th><th>PAYMENT</th><th>ADJUSTMENT</th><th>BALANCE</th><th></th></tr></thead><tbody>${lines||'<tr><td colspan="7">No ledger entries yet.</td></tr>'}</tbody></table></div></section>`;
  }

  function customerEditPage(row) {
    return `<div class="page-heading"><div><span class="section-kicker">CUSTOMER PROFILE</span><h1>Edit customer</h1><p>Update this customer's contact details and credit limit.</p></div><button class="button-secondary" data-action="customer-edit-cancel">Cancel</button></div><section class="summary-cards"><article class="panel summary-card"><small>Current due</small><strong class="${row.due>0?'due-amount':''}">${money(row.due)}</strong></article><article class="panel summary-card"><small>Credit limit</small><strong>${row.limit?money(row.limit):'No limit'}</strong></article></section><section class="panel customer-edit-panel"><form class="customer-inline-form" id="customer-profile-form" data-customer-key="${escapeHtml(row.key)}"><h3>Customer information</h3><label class="modal-field">Name<input name="name" maxlength="100" value="${escapeHtml(row.name)}" required></label><label class="modal-field">Phone<input name="phone" maxlength="40" value="${escapeHtml(row.phone)}"></label><label class="modal-field">Credit limit<input name="limit" type="number" min="0" step="0.01" value="${row.limit || ''}" placeholder="Optional"></label><div class="feature-actions"><button class="button-primary" type="submit">Save profile</button>${row.due <= 0 ? `<button class="button-secondary" type="button" data-action="archive-customer" data-customer-key="${escapeHtml(row.key)}">Archive customer</button>` : '<span class="subtle-count">Cannot archive while due remains</span>'}</div></form></section>${correctionMarkup(ledger.find(entry=>entry.id===correctionTarget))}${ledgerHistoryMarkup(row)}`;
  }

  function customerDetail(row) {
    const entries = entriesFor(row.key);
    let running = 0;
    const lines = entries.map(entry => {
      running += entryEffect(entry);
      const due = entry.type === 'due' ? money(entry.amount) : '—';
      const payment = entry.type === 'payment' ? money(entry.amount) : '—';
      const adjustment = entry.type === 'adjustment' ? money(entry.amount) : '—';
      const typeLabel = entry.type === 'due' ? 'Sale due' : entry.type === 'payment' ? 'Payment received' : 'Correction';
      const detail = `${entry.saleId?`Invoice ${escapeHtml(entry.saleId)} · `:''}${entry.correctionOf ? `Corrects ${escapeHtml(entry.correctionOf)} · ${escapeHtml(entry.note || '')}` : escapeHtml(entry.note || '')}`;
      const correctionAction=entry.type==='adjustment'?'<span>—</span>':`<button class="row-action" data-action="correct-ledger" data-entry-id="${escapeHtml(entry.id)}">Correct</button>`;
      return `<tr><td>${escapeHtml(dateISO(entry.date))}</td><td><b>${typeLabel}</b><small>${detail}</small></td><td>${due}</td><td>${payment}</td><td>${adjustment}</td><td>${money(running)}</td><td>${correctionAction}</td></tr>`;
    }).join('');
    return `<div class="page-heading"><div><span class="section-kicker">CUSTOMER LEDGER</span><h1>${escapeHtml(row.name)}</h1><p>${escapeHtml(row.phone || row.email || 'No phone saved')}</p></div><button class="button-secondary" data-action="customer-back">Back to customers</button></div><section class="summary-cards"><article class="panel summary-card"><small>Current due</small><strong class="${row.due > 0 ? 'due-amount' : ''}">${money(row.due)}</strong></article><article class="panel summary-card"><small>Credit limit</small><strong>${row.limit ? money(row.limit) : 'No limit'}</strong></article><article class="panel summary-card"><small>Overdue since</small><strong>${row.oldestDue ? `${row.daysOverdue} days` : '—'}</strong></article></section><section class="customer-detail-grid"><form class="panel customer-inline-form" id="customer-payment-form" data-customer-key="${escapeHtml(row.key)}"><h3>Record payment</h3><p>Each receipt is saved as a separate dated ledger entry.</p><label class="modal-field">Amount<input name="amount" type="number" min="0.01" max="${Math.max(0,row.due)}" step="0.01" required></label><label class="modal-field">Date<input name="date" type="date" value="${new Date().toISOString().slice(0,10)}" required></label><label class="modal-field">Account<select name="account"><option>Cash</option><option>Bank</option></select></label><label class="modal-field">Note<input name="note" maxlength="240" placeholder="Receipt or reference"></label><div class="feature-actions"><button class="button-primary" type="submit" ${row.due <= 0 ? 'disabled' : ''}>Record payment</button></div></form></section>${correctionMarkup(ledger.find(entry=>entry.id===correctionTarget))}<section class="panel table-panel customer-ledger-panel"><div class="table-title"><h3>Ledger history</h3><span class="subtle-count">Running balance</span></div><div class="customer-ledger-scroll"><table class="data-table"><thead><tr><th>DATE</th><th>DESCRIPTION</th><th>DUE</th><th>PAYMENT</th><th>ADJUSTMENT</th><th>BALANCE</th><th></th></tr></thead><tbody>${lines || '<tr><td colspan="7">No ledger entries yet.</td></tr>'}</tbody></table></div></section>`;
  }

  function customersPage() {
    const rows = customerRows();
    const edited = rows.find(row => row.key === editingCustomer);
    if (edited) return customerEditPage(edited);
    const selected = rows.find(row => row.key === selectedCustomer);
    if (selected) return customerDetail(selected);
    const totalDue = rows.reduce((sum,row)=>sum+Math.max(0,row.due),0);
    const body = rows.map(row => `<tr data-customer-search="${escapeHtml(`${row.name} ${row.phone} ${row.email}`.toLowerCase())}"><td><span class="customer-name-label">${escapeHtml(row.name)}</span><small>${escapeHtml(row.phone || row.email || '')}</small></td><td>${row.orders}</td><td>${money(row.spent)}</td><td class="${row.due>0?'due-amount':''}">${money(row.due)}</td><td class="${row.daysOverdue>30?'overdue':''}">${row.oldestDue ? `${row.daysOverdue} days` : '—'}</td><td><button class="customer-edit-button" data-action="customer-edit" data-customer-key="${escapeHtml(row.key)}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m13.5 3.5 3 3M4 16l3.6-.7L16 7a2.12 2.12 0 0 0-3-3l-8.4 8.4L4 16Z"/></svg><span>Edit</span></button></td></tr>`).join('');
    return `<div class="page-heading"><div><span class="section-kicker">CUSTOMER BOOK</span><h1>Customers</h1><p>Customer balances and an auditable payment ledger.</p></div><div class="heading-actions"><button class="button-secondary" data-action="backup-download">Download backup</button><button class="button-secondary" data-action="backup-upload">Upload backup</button><input id="customer-backup-file" type="file" accept="application/json,.json" hidden></div></div><section class="summary-cards"><article class="panel summary-card"><small>Total customer due</small><strong class="due-amount">${money(totalDue)}</strong></article><article class="panel summary-card"><small>Customers</small><strong>${rows.length}</strong></article><article class="panel summary-card"><small>Open overdue accounts</small><strong>${rows.filter(row=>row.daysOverdue>30).length}</strong></article></section><section class="panel table-panel customer-list-panel"><div class="table-title"><h3>Due ledger <span class="subtle-count">Highest due first</span></h3><label class="customer-search"><span>Search</span><input id="customer-search" type="search" placeholder="Name or phone"></label></div><div class="customer-ledger-scroll"><table class="data-table"><thead><tr><th>CUSTOMER</th><th>ORDERS</th><th>SPENT</th><th>CURRENT DUE</th><th>OLDEST DUE</th><th>ACTIONS</th></tr></thead><tbody>${body || '<tr><td colspan="6">No customers found.</td></tr>'}</tbody></table></div></section><section class="panel customer-top-list"><div class="table-title"><h3>Highest outstanding balances</h3></div><ol>${rows.filter(row=>row.due>0).slice(0,3).map(row=>`<li><button data-action="customer-detail" data-customer-key="${escapeHtml(row.key)}">${escapeHtml(row.name)}</button><strong>${money(row.due)}</strong></li>`).join('') || '<li>No outstanding balances.</li>'}</ol></section>`;
  }

  function dashboardDuePanel() {
    const rows = customerRows();
    const top = rows.filter(row=>row.due>0).slice(0,3);
    const total = rows.reduce((sum,row)=>sum+Math.max(0,row.due),0);
    return `<section class="panel customer-top-list dashboard-due-panel"><div class="table-title"><h3>Customer due ledger</h3><a class="text-link" href="#customers">Open ledger</a></div><div class="due-total-strip"><span>Total customer due</span><strong>${money(total)}</strong></div><ol>${top.map(row=>`<li><button data-action="customer-detail" data-customer-key="${escapeHtml(row.key)}">${escapeHtml(row.name)}</button><strong>${money(row.due)}</strong></li>`).join('') || '<li>No outstanding balances.</li>'}</ol></section>`;
  }

  function dueForSale(customer, excludingSaleId='') {
    return customerRows().find(row=>row.key===customer)?.due || 0;
  }
  function checkCreditLimit(key, amount) {
    const limit = Math.max(0,Number(profiles[key]?.limit)||0);
    const projected = dueForSale(key) + Math.max(0,Number(amount)||0);
    const english=isEnglish();
    return !limit || projected <= limit || confirm(english ? `This sale will exceed the customer's credit limit. Current due: ${money(dueForSale(key))}. New due: ${money(projected)}. Continue?` : `এই বিক্রির পর বাকি কাস্টমারের নির্ধারিত সীমা ছাড়াবে। বর্তমান বাকি: ${money(dueForSale(key))}। নতুন বাকি: ${money(projected)}। তবুও বিক্রি সংরক্ষণ করবেন?`);
  }
  function syncSalesToLedger() { migrateSales(); }

  const baseDashboard = pages.dashboard;
  pages.dashboard = () => `${baseDashboard()}${dashboardDuePanel()}`;
  const baseAccounts = pages.accounts;
  pages.accounts = () => {
    const due=customerRows().reduce((sum,row)=>sum+Math.max(0,row.due),0);
    return baseAccounts().replace(/(<span>Customer dues<\/span>[\s\S]*?<div class="metric-value">)[^<]*/,`$1${money(due)}`);
  };
  pages.customers = customersPage;
  migrateSales();

  pageContent.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'customer-detail') { editingCustomer='';selectedCustomer = button.dataset.customerKey || ''; correctionTarget=''; renderPage('customers'); }
    if (action === 'customer-edit') { const key=button.dataset.customerKey||'';editReturnTo=selectedCustomer===key?'detail':'list';editingCustomer=key;correctionTarget='';renderPage('customers'); }
    if (action === 'customer-edit-cancel') { editingCustomer='';if(editReturnTo==='list')selectedCustomer='';correctionTarget='';renderPage('customers'); }
    if (action === 'customer-back') { selectedCustomer='';editingCustomer='';correctionTarget=''; renderPage('customers'); }
    if (action === 'correct-ledger') { correctionTarget=button.dataset.entryId || ''; renderPage('customers'); }
    if (action === 'cancel-correction') { correctionTarget=''; renderPage('customers'); }
    if (action === 'archive-customer') {
      const key=button.dataset.customerKey||editingCustomer||selectedCustomer;
      const row=customerRows().find(item=>item.key===key);
      if (!row) return;
      if (row.due>0) { notify('বাকি থাকা অবস্থায় কাস্টমার মুছতে পারবেন না।'); return; }
      if (!confirm(isEnglish() ? 'Archive this customer? Transaction history stays in the ledger and backup.' : 'কাস্টমার আর্কাইভ করবেন? লেনদেনের ইতিহাস খাতা ও ব্যাকআপে থাকবে।')) return;
      profiles[row.key]={...(profiles[row.key]||{}),archived:true,archivedOrderIds:orders.filter(sale=>saleCustomerKey(sale)===row.key).map(sale=>sale.id)};persistProfiles();selectedCustomer='';editingCustomer='';renderPage('customers');
    }
    if (action === 'backup-download') {
      const data={};
      try { for (const key of BACKUP_KEYS) { const raw=localStorage.getItem(key); if(raw!==null)data[key]=JSON.parse(raw); } }
      catch { notify('Backup could not be created from browser storage.'); return; }
      const blob=new Blob([JSON.stringify({app:'Probashi Store',version:1,exportedAt:new Date().toISOString(),data},null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`probashi-backup-${new Date().toISOString().slice(0,10)}.json`;link.click();URL.revokeObjectURL(url);
    }
    if (action === 'backup-upload') pageContent.querySelector('#customer-backup-file')?.click();
  });

  pageContent.addEventListener('input', event => {
    if (event.target.id !== 'customer-search') return;
    const query=event.target.value.trim().toLowerCase();
    pageContent.querySelectorAll('[data-customer-search]').forEach(row=>{row.hidden=!row.dataset.customerSearch.includes(query)});
  });

  pageContent.addEventListener('change', event => {
    if (event.target.id !== 'customer-backup-file' || !event.target.files?.[0]) return;
    const file=event.target.files[0],reader=new FileReader();
    reader.onload=()=>{
      let backup;
      try { backup=JSON.parse(String(reader.result)); } catch { notify('Backup file is not valid JSON.'); return; }
      if (!backup?.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) { notify('Backup format is not supported.'); return; }
      const arrayKeys=['probashi-orders','probashi-products','probashi-expenses','probashi-purchases',LEDGER_KEY];
      if (arrayKeys.some(key=>Object.hasOwn(backup.data,key)&&!Array.isArray(backup.data[key]))) { notify('Backup format is not supported.'); return; }
      if (Object.hasOwn(backup.data,LEDGER_KEY)&&backup.data[LEDGER_KEY].some(item=>!item||typeof item!=='object'||typeof item.cid!=='string'||!['due','payment','adjustment'].includes(item.type)||!Number.isFinite(Number(item.amount)))) { notify('Backup format is not supported.'); return; }
      for (const key of ['probashi-balances','probashi-store-settings',PROFILE_KEY]) if (Object.hasOwn(backup.data,key)&&(!backup.data[key]||typeof backup.data[key]!=='object'||Array.isArray(backup.data[key]))) { notify('Backup format is not supported.'); return; }
      if (!confirm(isEnglish() ? 'Import this backup? Current browser data for this app will be replaced.' : 'এই ব্যাকআপ আনবেন? এই অ্যাপের বর্তমান ব্রাউজার ডেটা প্রতিস্থাপিত হবে।')) return;
      const previous={};
      try { for (const key of BACKUP_KEYS) previous[key]=localStorage.getItem(key); } catch { notify('Could not access browser storage.'); return; }
      try {
        for (const key of BACKUP_KEYS) {
          if (Object.hasOwn(backup.data,key)) localStorage.setItem(key,JSON.stringify(backup.data[key]));
          else localStorage.removeItem(key);
        }
        location.reload();
      } catch {
        try { for (const key of BACKUP_KEYS) previous[key]===null?localStorage.removeItem(key):localStorage.setItem(key,previous[key]); } catch {}
        notify('Backup could not be imported. Browser storage may be full.');
      }
    };
    reader.onerror=()=>notify('Could not read the backup file.');
    reader.readAsText(file);
  });

  pageContent.addEventListener('submit', event => {
    const form=event.target;
    if (form.id==='customer-payment-form') {
      event.preventDefault();
      const data=new FormData(form),cid=form.dataset.customerKey,customer=customerRows().find(row=>row.key===cid),amount=Number(data.get('amount'));
      if (!customer || !Number.isFinite(amount) || amount<=0 || amount>customer.due) { notify('Enter a payment amount up to the current due.'); return; }
      const account=String(data.get('account')||'Cash').toLowerCase();
      const entry=pushEntry({cid,customerName:customer.name,type:'payment',amount,note:String(data.get('note')||'Payment received'),date:data.get('date'),account});
      if (!entry) return;
      applyPaymentToSales(cid,amount);
      updateAccountBalance(account,amount);
      selectedCustomer=cid;correctionTarget='';renderPage('customers');notify('Payment recorded in the customer ledger.');
      return;
    }
    if (form.id==='customer-profile-form') {
      event.preventDefault();
      const data=new FormData(form),cid=form.dataset.customerKey,name=String(data.get('name')||'').trim(),phone=String(data.get('phone')||'').trim(),limit=Math.max(0,Number(data.get('limit'))||0);
      if (!name) { notify('Customer name is required.'); return; }
      const previous=profiles[cid];profiles[cid]={...(previous||{}),name,phone,limit};
      if (!persistProfiles()) { if(previous)profiles[cid]=previous;else delete profiles[cid]; return; }
      selectedCustomer=editReturnTo==='detail'?cid:'';editingCustomer='';renderPage('customers');notify('Customer profile saved.');
      return;
    }
    if (form.id==='customer-correction-form') {
      event.preventDefault();
      const original=ledger.find(entry=>entry.id===form.dataset.entryId),data=new FormData(form),rawAmount=Number(data.get('amount')),newAmount=Math.max(0,rawAmount||0),reason=String(data.get('reason')||'').trim();
      if (!original || !reason) { notify('Enter a correction reason.'); return; }
      const linkedCorrections=ledger.filter(entry=>entry.type==='adjustment'&&entry.correctionOf===original.id).reduce((sum,entry)=>sum+Number(entry.amount||0),0);
      const currentAmount=original.type==='payment'?Number(original.amount)-linkedCorrections:Number(original.amount)+linkedCorrections;
      const sign=original.type==='payment'?-1:1,delta=(newAmount-currentAmount)*sign;
      if (Math.abs(delta)<0.005) { notify('No amount change to record.'); return; }
      const adjustment=pushEntry({cid:original.cid,customerName:original.customerName,type:'adjustment',amount:delta,note:reason,date:new Date().toISOString().slice(0,10),correctionOf:original.id});
      if (!adjustment) return;
      if (original.type==='payment') {
        applyPaymentToSales(original.cid,newAmount-currentAmount);
        updateAccountBalance(original.account || 'cash',newAmount-currentAmount);
      } else if (original.type==='due' && original.saleId) {
        const sale=orders.find(item=>item.id===original.saleId);
        if (sale) {
          const total=Math.max(0,Number(sale.total)||0),paid=Number(sale.paidAmount??(sale.status==='Paid'?total:0));
          sale.paidAmount=Math.min(total,Math.max(0,paid+currentAmount-newAmount));
          if (sale.paidAmount>=total) sale.status='Paid'; else if (sale.status==='Paid') sale.status='Pending';
          try { localStorage.setItem('probashi-orders',JSON.stringify(orders)); } catch { notify('Correction was saved, but the related order could not be updated.'); }
        }
      }
      correctionTarget='';selectedCustomer=original.cid;renderPage('customers');notify('Correction saved as a new audit entry.');
    }
  });

  pageContent.addEventListener('submit', event => {
    const form=event.target;
    if (form.id==='pos-form') {
      const data=new FormData(form),product=products[Number(data.get('product'))],name=String(data.get('customer')||'').trim(),email=String(data.get('email')||'').trim(),key=saleCustomerKey({name,email});
      if (product && key) {
        const gross=Number(product.price)*Number(data.get('qty')||0),owed=Math.max(0,gross-Math.min(gross,Number(data.get('discount')||0))-Number(data.get('paid')||0));
        if (!checkCreditLimit(key,owed)) { event.preventDefault();event.stopImmediatePropagation();return; }
      }
      queueMicrotask(syncSalesToLedger);
    }
  },true);
  document.addEventListener('submit', event => {
    if (event.target.id==='record-form' && modalMode==='order-edit') {
      event.preventDefault();event.stopImmediatePropagation();
      const sale=orders[modalRecordIndex];if(!sale)return;
      const data=new FormData(event.target),name=String(data.get('customer')||'').trim(),email=String(data.get('email')||'').trim()||`${name.toLowerCase().replace(/[^a-z0-9]+/g,'.')}@walkin.local`,total=Number(data.get('total')),items=Math.max(1,Math.floor(Number(data.get('items'))||1));
      if(!name||!Number.isFinite(total)||total<=0){notify('Enter a customer name and a valid order total.');return;}
      const oldKey=saleCustomerKey(sale),newKey=saleCustomerKey({name,email}),paid=Math.min(Math.max(0,Number(sale.paidAmount)||0),total),oldDue=sale.status==='Cancelled'?0:Math.max(0,Number(sale.total||0)-Math.min(Math.max(0,Number(sale.paidAmount)||0),Number(sale.total||0))),newDue=sale.status==='Cancelled'?0:Math.max(0,total-paid),sameCustomer=oldKey===newKey;
      if(!sameCustomer&&oldDue>0&&!pushEntry({cid:oldKey,customerName:sale.name,type:'adjustment',amount:-oldDue,note:'Order customer changed · previous due cleared',date:todayISO()})){notify('Could not update the previous customer balance.');return;}
      if((sameCustomer&&newDue!==oldDue||!sameCustomer&&newDue>0)&&!pushEntry({cid:newKey,customerName:name,type:sameCustomer?'adjustment':'due',amount:sameCustomer?newDue-oldDue:newDue,note:'Edited order balance',date:todayISO(),saleId:sale.id})){notify('Could not update the customer balance.');return;}
      sale.name=name;sale.email=email;sale.initials=initial(name);sale.items=items;sale.total=total;sale.paidAmount=paid;
      try{localStorage.setItem('probashi-orders',JSON.stringify(orders));}catch{notify('Could not save the edited order. Browser storage may be full or unavailable.');return;}
      closeModal();renderPage('orders');notify('Order updated successfully.');return;
    }
    if (event.target.id==='record-form' && modalMode==='order') {
      event.preventDefault();event.stopImmediatePropagation();
      const data=new FormData(event.target),name=String(data.get('customer')||'').trim(),providedEmail=String(data.get('email')||'').trim(),email=providedEmail||`${name.toLowerCase().replace(/[^a-z0-9]+/g,'.')}@walkin.local`,key=saleCustomerKey({name,email}),amount=Number(data.get('total')),items=Math.max(1,Math.floor(Number(data.get('items'))||1));
      if (!name || !Number.isFinite(amount) || amount<=0) { notify('Enter a customer name and a valid order total.'); return; }
      if (!checkCreditLimit(key,amount)) return;
      const next=Math.max(1040,...orders.map(order=>Number(String(order.id).replace(/\D/g,''))||0))+1;
      const sale={id:`#PS-${next}`,name,email,initials:initial(name),color:'#eee8d8',date:prettyDate(todayISO()),saleDate:todayISO(),items,total:amount,paidAmount:0,status:'Pending'};
      try {
        orders.unshift(sale);
        localStorage.setItem('probashi-orders',JSON.stringify(orders));
      } catch {
        const index=orders.indexOf(sale);if(index>=0)orders.splice(index,1);
        notify('Could not save the order. Browser storage may be full or unavailable.');return;
      }
      if (amount>0) pushEntry({cid:key,customerName:name,type:'due',amount,note:'Sale invoice',date:sale.saleDate,saleId:sale.id});
      closeModal();renderPage('orders');notify('Order created successfully.');
    }
  },true);

  modal.addEventListener('change', event => {
    if(event.target.id==='detail-order-status'){
      const sale=orders[modalRecordIndex];if(sale)priorOrderStatus.set(sale.id,sale.status);
    }
  },true);
  modal.addEventListener('change', event => {
    if (event.target.id !== 'detail-order-status') return;
    const sale=orders[modalRecordIndex];if(!sale)return;
    const cid=saleCustomerKey(sale),previous=priorOrderStatus.get(sale.id),total=Math.max(0,Number(sale.total)||0),paid=Math.min(total,Math.max(0,Number(sale.paidAmount)||0)),remaining=total-paid,english=isEnglish();
    priorOrderStatus.delete(sale.id);
    if(previous==='Cancelled'&&event.target.value!=='Cancelled'&&remaining>0){
      if(!pushEntry({cid,customerName:sale.name,type:'due',amount:remaining,note:'Reopened cancelled invoice',date:todayISO(),saleId:sale.id})){sale.status='Cancelled';try{localStorage.setItem('probashi-orders',JSON.stringify(orders));}catch{}renderPage('orders');openOrderDetails(modalRecordIndex);return;}
    }
    if(event.target.value==='Paid'&&remaining>0){
      const ok=confirm(english?`Record the remaining ${money(remaining)} as a cash payment?`:`বাকি ${money(remaining)} নগদ জমা হিসেবে খাতায় লিখবেন?`);
      if(!ok){sale.status=previous||'Pending';try{localStorage.setItem('probashi-orders',JSON.stringify(orders));}catch{}renderPage('orders');openOrderDetails(modalRecordIndex);return;}
      const entry=pushEntry({cid,customerName:sale.name,type:'payment',amount:remaining,note:'Payment received · order marked paid',date:todayISO(),account:'cash'});
      if(!entry){sale.status=previous||'Pending';try{localStorage.setItem('probashi-orders',JSON.stringify(orders));}catch{}renderPage('orders');openOrderDetails(modalRecordIndex);return;}
      sale.paidAmount=total;updateAccountBalance('cash',remaining);
    }
    if(event.target.value==='Cancelled'&&remaining>0){
      const ok=confirm(english?'Cancel this order and clear its remaining customer due?':'অর্ডারটি বাতিল করে অবশিষ্ট বাকি খাতা থেকে সমন্বয় করবেন?');
      if(!ok){sale.status=previous||'Pending';try{localStorage.setItem('probashi-orders',JSON.stringify(orders));}catch{}renderPage('orders');openOrderDetails(modalRecordIndex);return;}
      if(!pushEntry({cid,customerName:sale.name,type:'adjustment',amount:-remaining,note:'Cancelled invoice · remaining due cleared',date:todayISO()})){sale.status=previous||'Pending';try{localStorage.setItem('probashi-orders',JSON.stringify(orders));}catch{}renderPage('orders');openOrderDetails(modalRecordIndex);return;}
    }
    try{localStorage.setItem('probashi-orders',JSON.stringify(orders));}catch{notify('Could not save the updated order status.');}
    renderPage(location.hash.slice(1)||'dashboard');openOrderDetails(modalRecordIndex);
  });

  window.addEventListener('storage', event => {
    if (event.key===LEDGER_KEY || event.key==='probashi-orders') { ledger=read(LEDGER_KEY,[]);migrateSales();if(!pageContent.closest('.hidden'))renderPage(location.hash.slice(1)||'dashboard'); }
  });
  if (!appView.classList.contains('hidden')) renderPage(location.hash.slice(1)||'dashboard');
})();
