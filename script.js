/* Monimo - script.js (Merged & Fixed)
   Transactions + Inventory + Inventory Logs (localStorage)
   JOURNALS: Purchases, Sales, Cash Receipts, Cash Disbursements, General
   NEW:
     - One-time Trial Reset (wipes old data once so you can start fresh)
     - Editable purchases, partial payments (AR/AP), customer & supplier, business name
     - Color accents, modern UI, expenses exclude inventory purchases in cards/summary
     - Purchases appear in Purchases Journal, Cash Disbursements (if cash), and General Journal
     - Sales (partial/full) payments now reflected in General Journal
     - Edit/Delete cascades to all affected journals
     - Removed misleading +qty log on edit
     - Purchase edit/delete moved from Purchases Journal to Inventory Tab per-item log
*/

/* =========================
   STORAGE KEYS + APP STATE
   ========================= */
const STORAGE_KEY = 'monimo_transactions';
const INV_KEY = 'inventoryData';
const LOG_KEY = 'inventoryLogs';

// journal + settings keys
const PURCHASES_KEY = 'purchasesJournal';
const SALES_KEY = 'salesJournal';
const RECEIPTS_KEY = 'cashReceipts';
const DISB_KEY = 'cashDisbursements';
const SETTINGS_KEY = 'monimo_settings';

// App state
let transactions = [];
let inventory = [];
let logs = []; // overall inventory logs
let purchasesJournal = [];
let salesJournal = [];
let cashReceipts = [];
let cashDisbursements = [];

let editId = null; // transaction currently editing
let editingInventoryId = null; // inventory item editing flag
let originalTxnSnapshot = null;

let settings = {
  businessName: 'Monimo',
  theme: 'light',
  accent: 'blue'
};

/* =========================
   ONE-TIME TRIAL RESET
   (Deletes existing local data once so you start clean,
    then preserves all new entries going forward)
   ========================= */
function trialResetIfNeeded() {
  const FLAG = 'monimo_trial_cleared_v1';
  if (!localStorage.getItem(FLAG)) {
    // Keep settings; wipe journals, transactions, inventory, logs
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(INV_KEY);
    localStorage.removeItem(LOG_KEY);
    localStorage.removeItem(PURCHASES_KEY);
    localStorage.removeItem(SALES_KEY);
    localStorage.removeItem(RECEIPTS_KEY);
    localStorage.removeItem(DISB_KEY);
    // Mark as cleared so we don’t wipe again
    localStorage.setItem(FLAG, '1');
  }
}

/* =========================
   HELPERS
   ========================= */
function formatCurrency(num){
  return '₱' + Number(num || 0).toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2});
}
function uid(){ return Date.now().toString() + Math.floor(Math.random()*1000); }
function nowISO(){ return new Date().toISOString(); }

/** Compute a transaction's Inventory Cost (COGS) safely */
function getTxnInventoryCost(t){
  if(!t) return 0;
  if(typeof t.invCost === 'number' && !isNaN(t.invCost)) return Number(t.invCost);
  if(t.type === 'revenue' && t.invId && t.invQty){
    const inv = inventory.find(i=>i.id === t.invId);
    const unit = inv ? Number(inv.unitPrice || 0) : 0;
    return Number(t.invQty) * unit; // fallback if older txns lack invCost
  }
  return 0;
}

/* =========================
   LOAD / SAVE
   ========================= */
function loadAll(){
  const raw = localStorage.getItem(STORAGE_KEY);
  transactions = raw ? JSON.parse(raw) : [];
  const rawInv = localStorage.getItem(INV_KEY);
  inventory = rawInv ? JSON.parse(rawInv) : [];
  const rawLogs = localStorage.getItem(LOG_KEY);
  logs = rawLogs ? JSON.parse(rawLogs) : [];

  // journals
  purchasesJournal = JSON.parse(localStorage.getItem(PURCHASES_KEY) || '[]');
  salesJournal = JSON.parse(localStorage.getItem(SALES_KEY) || '[]');
  cashReceipts = JSON.parse(localStorage.getItem(RECEIPTS_KEY) || '[]');
  cashDisbursements = JSON.parse(localStorage.getItem(DISB_KEY) || '[]');

  // settings
  settings = Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
}
function saveAll(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
  localStorage.setItem(INV_KEY, JSON.stringify(inventory));
  localStorage.setItem(LOG_KEY, JSON.stringify(logs));
  localStorage.setItem(PURCHASES_KEY, JSON.stringify(purchasesJournal));
  localStorage.setItem(SALES_KEY, JSON.stringify(salesJournal));
  localStorage.setItem(RECEIPTS_KEY, JSON.stringify(cashReceipts));
  localStorage.setItem(DISB_KEY, JSON.stringify(cashDisbursements));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/* =========================
   LOGGING
   ========================= */
function addLog(itemId, action, qtyChange, note){
  const item = inventory.find(i => i.id === itemId);
  const balance = item ? Number(item.quantity) : null;
  const entry = {
    id: uid(),
    timestamp: nowISO(),
    itemId: itemId || null,
    itemName: item ? item.name : (note || ''),
    action,
    qtyChange,
    balanceAfter: balance,
    note: note || ''
  };
  logs.unshift(entry);
  saveAll();
  renderOverallLog();
}

/* =========================
   DASHBOARD & SUMMARY
   (Expenses EXCLUDE inventory purchases)
   ========================= */
function updateDashboard(){
  const revenue = transactions.filter(t => t.type === 'revenue').reduce((s,t)=> s + Number(t.amount), 0);

  // exclude expense transactions that are inventory purchases (have invId)
  const expenseNonInventory = transactions
    .filter(t => t.type === 'expense' && !t.invId)
    .reduce((s,t)=> s + Number(t.amount), 0);

  const inventoryCost = transactions.reduce((s,t)=> s + getTxnInventoryCost(t), 0);
  const profit = revenue - inventoryCost - expenseNonInventory;

  el('#totalRevenue').textContent = formatCurrency(revenue);
  el('#totalExpense').textContent = formatCurrency(expenseNonInventory);
  el('#totalInventoryCost').textContent = formatCurrency(inventoryCost);
  el('#profit').textContent = formatCurrency(profit);
}

/* =========================
   RENDER TRANSACTIONS
   ========================= */
function renderTransactions(filterFrom, filterTo){
  const tbody = qs('#transactionsTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';

  let filtered = transactions;
  if(filterFrom || filterTo){
    filtered = transactions.filter(t=>{
      const d = new Date(t.date);
      if(filterFrom && d < new Date(filterFrom)) return false;
      if(filterTo){
        const toD = new Date(filterTo); toD.setHours(23,59,59,999);
        if(d > toD) return false;
      }
      return true;
    });
  }

  filtered.slice().reverse().forEach(t=>{
    const tr = document.createElement('tr');
    const extra = [
      t.invName ? `Item: ${t.invName} ×${t.invQty}` : '',
      t.paymentMethod ? `Method: ${t.paymentMethod}` : '',
      (t.customer && t.type==='revenue') ? `Customer: ${t.customer}` : '',
      (t.supplier && t.type==='expense' && t.invId) ? `Supplier: ${t.supplier}` : ''
    ].filter(Boolean).map(s=>`<div class="muted">${s}</div>`).join('');

    tr.innerHTML = `
      <td>${new Date(t.date).toLocaleString()}</td>
      <td>${t.description}${extra}</td>
      <td>${t.type}</td>
      <td>${formatCurrency(t.amount)}</td>
      <td>
        <button class="edit-btn" data-id="${t.id}">Edit</button>
        <button class="del-btn" data-id="${t.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.del-btn').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const id = e.target.dataset.id;
      if(!confirm('Delete this transaction? This also reverts any linked inventory and removes related journal entries.')) return;
      deleteTransaction(id);
    });
  });

  tbody.querySelectorAll('.edit-btn').forEach(btn=>{
    btn.addEventListener('click', e=> startEditTransaction(e.target.dataset.id));
  });
}

/* =========================
   INVENTORY HELPERS
   ========================= */
function revertTransactionInventory(txn){
  if(!txn || !txn.invId) return { ok: true };
  const inv = inventory.find(i=>i.id === txn.invId);
  if(!inv) return { error:true, msg: 'Inventory item no longer exists' };

  const qty = Number(txn.invQty || 0);
  if(txn.type === 'revenue'){ // sale deducted stock -> restore
    inv.quantity = Number(inv.quantity) + qty;
    addLog(inv.id, 'restore', +qty, `Restore from revert of sale tx ${txn.id}`);
    saveAll();
    return { ok:true };
  } else if(txn.type === 'expense'){ // purchase added stock -> revert by subtracting
    inv.quantity = Number(inv.quantity) - qty;
    addLog(inv.id, 'restore', -qty, `Restore (remove) from revert of purchase tx ${txn.id}`);
    saveAll();
    return { ok:true };
  }
  return { ok:true };
}

function applyTransactionInventory(txn){
  if(!txn || !txn.invId) { txn.invCost = 0; return { ok:true }; }
  const inv = inventory.find(i=>i.id === txn.invId);
  if(!inv) return { error:true, msg: 'Inventory item not found' };
  const qty = Number(txn.invQty || 0);
  if(txn.type === 'revenue'){ // sale -> decrease & record COGS
    if(inv.quantity < qty) return { error:true, msg: `Not enough stock for "${inv.name}". Available: ${inv.quantity}` };
    inv.quantity = Number(inv.quantity) - qty;
    txn.invCost = Number(inv.unitPrice || 0) * qty;
    addLog(inv.id, 'sale', -qty, `Sale tx ${txn.id}`);
  } else if(txn.type === 'expense'){ // purchase -> increase
    inv.quantity = Number(inv.quantity) + qty;
    txn.invCost = 0;
    addLog(inv.id, 'purchase', +qty, `Purchase tx ${txn.id}`);
  }
  saveAll();
  return { ok:true };
}

/* =========================
   JOURNALS: creation, updates, linking
   ========================= */
function createJournalFromTransaction(txn){
  if(!txn || !txn.id) return;

  // remove duplicates first
  removeJournalEntriesForTxn(txn.id);

  if(txn.type === 'revenue'){
    const entry = {
      id: uid(),
      txnId: txn.id,
      date: txn.date,
      description: txn.description,
      amount: Number(txn.amount),
      invId: txn.invId || null,
      invQty: txn.invQty || null,
      paymentMethod: txn.paymentMethod || 'Cash',
      customer: txn.customer || '',
      paidAmount: (txn.paymentMethod === 'Cash') ? Number(txn.amount) : 0,
      paid: (txn.paymentMethod === 'Cash')
    };
    salesJournal.unshift(entry);
    saveAll();
    renderSalesJournal();

    // If cash sale, mirror into Receipts (for visibility)
    if(entry.paid){
      const receipt = {
        id: uid(),
        date: txn.date,
        from: entry.customer || entry.description || 'Customer',
        amount: Number(txn.amount),
        saleId: entry.id,
        note: 'Cash sale (paid in full)'
      };
      cashReceipts.unshift(receipt);
      saveAll();
      renderCashReceipts();
    }

  } else if(txn.type === 'expense'){
    if(txn.invId){
      // Inventory Purchase -> Purchases Journal
      const entry = {
        id: uid(),
        txnId: txn.id,
        date: txn.date,
        description: txn.description,
        amount: Number(txn.amount),
        invId: txn.invId,
        invQty: txn.invQty,
        paymentMethod: txn.paymentMethod || 'Cash',
        supplier: txn.supplier || '',
        paidAmount: (txn.paymentMethod === 'Cash') ? Number(txn.amount) : 0,
        paid: (txn.paymentMethod === 'Cash')
      };
      purchasesJournal.unshift(entry);
      saveAll();
      renderPurchasesJournal();

      // If cash purchase, mirror into Disbursements
      if(entry.paid){
        const disb = {
          id: uid(),
          date: txn.date,
          description: entry.supplier || entry.description || 'Purchase',
          amount: Number(txn.amount),
          txnId: entry.txnId,
          note: 'Cash purchase (paid in full)'
        };
        cashDisbursements.unshift(disb);
        saveAll();
        renderCashDisbursements();
      }
    } else {
      // Regular expense -> Cash Disbursement
      const entry = {
        id: uid(),
        txnId: txn.id,
        date: txn.date,
        description: txn.description,
        amount: Number(txn.amount),
        note: ''
      };
      cashDisbursements.unshift(entry);
      saveAll();
      renderCashDisbursements();
    }
  }

  renderGeneralJournal();
}

// Remove linked journal entries for a txn id (cleanup on delete/edit)
function removeJournalEntriesForTxn(txnId){
  let changed = false;
  const beforeP = purchasesJournal.length;
  purchasesJournal = purchasesJournal.filter(j => j.txnId !== txnId);
  if(purchasesJournal.length !== beforeP) changed = true;

  const beforeS = salesJournal.length;
  salesJournal = salesJournal.filter(j => j.txnId !== txnId);
  if(salesJournal.length !== beforeS) changed = true;

  const beforeD = cashDisbursements.length;
  cashDisbursements = cashDisbursements.filter(j => j.txnId !== txnId);
  if(cashDisbursements.length !== beforeD) changed = true;

  // Receipts linked by saleId — if sale removed, drop receipts too (handled in deleteTransaction when we know sale.id)
  if(changed) saveAll();
  renderPurchasesJournal();
  renderSalesJournal();
  renderCashDisbursements();
  renderGeneralJournal();
}

// Update journal entry when transaction is edited
function updateJournalFromTxn(txn){
  if(!txn || !txn.id) return;

  // Purchases
  purchasesJournal.forEach(j=>{
    if(j.txnId === txn.id){
      j.date = txn.date;
      j.description = txn.description;
      j.amount = Number(txn.amount);
      j.invQty = txn.invQty || null;
      j.invId = txn.invId || null;
      j.paymentMethod = txn.paymentMethod || j.paymentMethod || 'Cash';
      j.supplier = txn.supplier || j.supplier || '';

      // Recompute paid flag if amount changed
      j.paidAmount = Number(j.paidAmount || 0);
      j.paid = j.paidAmount >= j.amount;

      // If switched/kept as Cash and not yet fully paid, auto-record the difference
      if(j.paymentMethod === 'Cash' && !j.paid){
        const payLeft = Math.max(0, Number(j.amount) - Number(j.paidAmount || 0));
        if(payLeft > 0){
          j.paidAmount = Number(j.amount);
          j.paid = true;
          // record disbursement for the difference
          cashDisbursements.unshift({
            id: uid(), date: txn.date,
            description: j.supplier || j.description || 'Purchase',
            amount: payLeft, txnId: j.txnId,
            note: 'Marked paid on edit (diff)'
          });
        }
      } else {
        // If paidAmount > amount after reducing amount, clamp
        if(j.paidAmount > j.amount) j.paidAmount = j.amount;
        j.paid = j.paidAmount >= j.amount;
      }
    }
  });

  // Sales
  salesJournal.forEach(j=>{
    if(j.txnId === txn.id){
      j.date = txn.date;
      j.description = txn.description;
      j.amount = Number(txn.amount);
      j.invQty = txn.invQty || null;
      j.invId = txn.invId || null;
      j.paymentMethod = txn.paymentMethod || j.paymentMethod || 'Cash';
      j.customer = txn.customer || j.customer || '';

      // Recompute paid if amount changed
      j.paidAmount = Number(j.paidAmount || 0);
      j.paid = j.paidAmount >= j.amount;

      // If it's Cash and not fully paid, auto-record the difference as receipt
      if(j.paymentMethod === 'Cash' && !j.paid){
        const payLeft = Math.max(0, Number(j.amount) - Number(j.paidAmount || 0));
        if(payLeft > 0){
          j.paidAmount = Number(j.amount);
          j.paid = true;
          cashReceipts.unshift({
            id: uid(), date: txn.date,
            from: j.customer || j.description || 'Customer',
            amount: payLeft, saleId: j.id,
            note: 'Marked paid on edit (diff)'
          });
        }
      } else {
        // Clamp if amount decreased below paidAmount
        if(j.paidAmount > j.amount) j.paidAmount = j.amount;
        j.paid = j.paidAmount >= j.amount;
      }
    }
  });

  // Disbursements (regular expense)
  cashDisbursements.forEach(d=>{
    if(d.txnId === txn.id){
      d.date = txn.date;
      d.description = txn.description;
      d.amount = Number(txn.amount);
    }
  });

  saveAll();
  renderPurchasesJournal();
  renderSalesJournal();
  renderCashDisbursements();
  renderCashReceipts();
  renderGeneralJournal();
}

/* =========================
   RENDER JOURNAL VIEWS
   ========================= */
function renderPurchasesJournal(){
  const tb = qs('#purchasesTable tbody');
  if(!tb) return;
  tb.innerHTML = '';
  purchasesJournal.forEach(p=>{
    const itemName = inventory.find(i=>i.id===p.invId)?.name || p.description || '';
    const remaining = Math.max(0, Number(p.amount) - Number(p.paidAmount || 0));
    const paidStr = `${formatCurrency(p.paidAmount || 0)} / ${formatCurrency(p.amount)}${remaining>0 ? ` (Rem: ${formatCurrency(remaining)})` : ''}`;

    // NOTE: Per request, we moved Edit/Delete to Inventory Tab per-item log — so actions here are only payments.
    const actions = `
      ${p.paymentMethod === 'Credit' && remaining > 0 ? `
        <button class="pay-supplier-btn" data-id="${p.id}">Pay</button>
        <button class="partial-btn pay-supplier-partial" data-id="${p.id}">Partial</button>` : ''}
    `;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(p.date).toLocaleString()}</td>
                    <td>${itemName}</td>
                    <td>${p.invQty ?? ''}</td>
                    <td>${formatCurrency(p.amount)}</td>
                    <td>${p.paymentMethod || ''}</td>
                    <td>${p.supplier || ''}</td>
                    <td>${paidStr}</td>
                    <td>${p.txnId || ''}</td>
                    <td>${actions}</td>`;
    tb.appendChild(tr);
  });

  // pay supplier full
  tb.querySelectorAll('.pay-supplier-btn').forEach(b=>{
    b.addEventListener('click', e=> paySupplier(e.target.dataset.id, null));
  });
  // partial pay supplier
  tb.querySelectorAll('.pay-supplier-partial').forEach(b=>{
    b.addEventListener('click', e=>{
      const id = e.target.dataset.id;
      const p = purchasesJournal.find(x=>x.id===id);
      if(!p) return;
      const rem = Math.max(0, Number(p.amount) - Number(p.paidAmount||0));
      let amt = prompt(`Enter partial payment amount (Remaining: ${formatCurrency(rem)})`, rem>0? (rem/2).toFixed(2): '0.00');
      if(amt===null) return;
      amt = parseFloat(amt);
      if(isNaN(amt) || amt<=0){ alert('Invalid amount'); return; }
      paySupplier(id, amt);
    });
  });
}

function renderSalesJournal(){
  const tb = qs('#salesTable tbody');
  if(!tb) return;
  tb.innerHTML = '';
  salesJournal.forEach(s=>{
    const remaining = Math.max(0, Number(s.amount) - Number(s.paidAmount || 0));
    const paidStr = `${formatCurrency(s.paidAmount || 0)} / ${formatCurrency(s.amount)}${remaining>0 ? ` (Rem: ${formatCurrency(remaining)})` : ''}`;
    const actions = `
      ${(s.paymentMethod==='Credit' && remaining>0) ? `
        <button class="mark-paid-btn" data-id="${s.id}">Pay in Full</button>
        <button class="partial-btn mark-partial-btn" data-id="${s.id}">Partial</button>` : ''}
    `;
    const tr = document.createElement('tr');
    tr.dataset.saleId = s.id;
    tr.innerHTML = `<td>${new Date(s.date).toLocaleString()}</td>
                    <td>${s.description}</td>
                    <td>${s.customer || ''}</td>
                    <td>${inventory.find(i=>i.id===s.invId)?.name || (s.invId ? s.invId : '')}</td>
                    <td>${s.invQty ?? ''}</td>
                    <td>${formatCurrency(s.amount)}</td>
                    <td>${s.paymentMethod || 'Cash'}</td>
                    <td>${paidStr}</td>
                    <td>${actions}</td>`;
    tb.appendChild(tr);
  });

  // Pay in full
  tb.querySelectorAll('.mark-paid-btn').forEach(b=>{
    b.addEventListener('click', e=> markSalePaid(e.target.dataset.id, null));
  });
  // Partial
  tb.querySelectorAll('.mark-partial-btn').forEach(b=>{
    b.addEventListener('click', e=>{
      const id = e.target.dataset.id;
      const sale = salesJournal.find(x=>x.id===id);
      if(!sale) return;
      const rem = Math.max(0, Number(sale.amount) - Number(sale.paidAmount||0));
      let amt = prompt(`Enter partial payment amount (Remaining: ${formatCurrency(rem)})`, rem>0? (rem/2).toFixed(2) : '0.00');
      if(amt===null) return;
      amt = parseFloat(amt);
      if(isNaN(amt) || amt<=0){ alert('Invalid amount'); return; }
      markSalePaid(id, amt);
    });
  });
}

function renderCashReceipts(){
  const tb = qs('#cashReceiptsTable tbody');
  if(!tb) return;
  tb.innerHTML = '';
  cashReceipts.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(r.date).toLocaleString()}</td>
                    <td>${r.from || r.description || ''}</td>
                    <td>${formatCurrency(r.amount)}</td>
                    <td>${r.saleId || ''}</td>
                    <td>${r.note || ''}</td>`;
    tb.appendChild(tr);
  });
}

function renderCashDisbursements(){
  const tb = qs('#cashDisbursementsTable tbody');
  if(!tb) return;
  tb.innerHTML = '';
  cashDisbursements.forEach(d=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(d.date).toLocaleString()}</td>
                    <td>${d.description || ''}</td>
                    <td>${formatCurrency(d.amount)}</td>
                    <td>${d.txnId || ''}</td>
                    <td>${d.note || ''}</td>`;
    tb.appendChild(tr);
  });
}

/** General Journal is derived from:
  * A. Base transactions
  * B. Cash Receipts (payments on receivables)
  * C. Cash Disbursements (payments on payables or expenses)
  * This ensures edits/payments show up without needing a separate store.
  */
function renderGeneralJournal(){
  const tb = qs('#generalJournalTable tbody');
  if(!tb) return;
  tb.innerHTML = '';

  // A. Base transactions (latest first)
  transactions.slice().reverse().forEach(t=>{
    const detailBits = [];
    if(t.invName) detailBits.push(`Item: ${t.invName} ×${t.invQty}`);
    if(t.customer && t.type==='revenue') detailBits.push(`Customer: ${t.customer}`);
    if(t.supplier && t.type==='expense' && t.invId) detailBits.push(`Supplier: ${t.supplier}`);
    if(t.paymentMethod) detailBits.push(`Method: ${t.paymentMethod}`);
    const detail = detailBits.join(' — ');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(t.date).toLocaleString()}</td>
                    <td>${t.description}</td>
                    <td>${t.type}</td>
                    <td>${formatCurrency(t.amount)}</td>
                    <td>${detail}</td>`;
    tb.appendChild(tr);
  });

  // B. Cash Receipts (payments on receivables)
  cashReceipts.slice().reverse().forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(r.date).toLocaleString()}</td>
                    <td>Receivable paid — ${r.from || 'Customer'}</td>
                    <td>receipt</td>
                    <td>${formatCurrency(r.amount)}</td>
                    <td>Sale: ${r.saleId || ''} ${r.note ? '— '+r.note : ''}</td>`;
    tb.appendChild(tr);
  });

  // C. Cash Disbursements (payments on payables or expenses)
  cashDisbursements.slice().reverse().forEach(d=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(d.date).toLocaleString()}</td>
                    <td>Payment — ${d.description || ''}</td>
                    <td>disbursement</td>
                    <td>${formatCurrency(d.amount)}</td>
                    <td>${d.txnId ? 'Linked Txn: '+d.txnId : ''} ${d.note ? '— '+d.note : ''}</td>`;
    tb.appendChild(tr);
  });
}

/* =========================
   TRANSACTION FLOWS: add / edit / delete
   ========================= */
function addTransaction(txn){
  transactions.push(txn);
  saveAll();
  createJournalFromTransaction(txn);
  updateDashboard();
  renderTransactions();
  renderInventory();
  fillInventorySelects();
  updateMonthlySummary();
}

/** Delete a base transaction + revert inventory + cascade journal deletions */
function deleteTransaction(id){
  const idx = transactions.findIndex(t=>t.id===id);
  if(idx === -1) return;
  const txn = transactions[idx];

  // revert inventory effect
  if(txn.invId){
    const inv = inventory.find(i => i.id === txn.invId);
    if(inv){
      let newQty = inv.quantity;
      if(txn.type === 'revenue') newQty = Number(inv.quantity) + Number(txn.invQty || 0);
      else if(txn.type === 'expense') newQty = Number(inv.quantity) - Number(txn.invQty || 0);

      if(txn.type === 'expense' && newQty < 0){
        const ok = confirm(`Reverting this purchase will make "${inv.name}" negative (${newQty}). Continue?`);
        if(!ok) return;
      }
      const res = revertTransactionInventory(txn);
      if(res.error){
        alert('Error reverting inventory: ' + res.msg);
        return;
      }
    }
  }

  // remove linked receipts/disbursements if they point to this txn's journal entries
  // sales: find sale journal entry -> remove its receipts
  const saleJ = salesJournal.find(s=>s.txnId===id);
  if(saleJ){
    cashReceipts = cashReceipts.filter(r => r.saleId !== saleJ.id);
  }
  // purchases: find purchase journal entry -> remove linked disbursements
  const purchJ = purchasesJournal.find(p=>p.txnId===id);
  if(purchJ){
    cashDisbursements = cashDisbursements.filter(d => d.txnId !== purchJ.txnId);
  }

  // remove txn + linked journals
  transactions.splice(idx,1);
  purchasesJournal = purchasesJournal.filter(j => j.txnId !== id);
  salesJournal = salesJournal.filter(j => j.txnId !== id);
  cashDisbursements = cashDisbursements.filter(j => j.txnId !== id);

  saveAll();
  renderTransactions();
  updateDashboard();
  updateMonthlySummary();
  renderInventory();
  fillInventorySelects();
  renderPurchasesJournal();
  renderSalesJournal();
  renderCashReceipts();
  renderCashDisbursements();
  renderGeneralJournal();
}

function startEditTransaction(id){
  const t = transactions.find(x=>x.id===id);
  if(!t) return;
  originalTxnSnapshot = JSON.parse(JSON.stringify(t));
  el('#description').value = t.description;
  el('#amount').value = t.amount;
  el('#type').value = t.type;
  el('#inventorySelect').value = t.invId || '';
  el('#quantity').value = t.invQty || '';
  el('#paymentMethod').value = t.paymentMethod || 'Cash';
  el('#customerName').value = t.customer || '';
  el('#supplierName').value = t.supplier || '';
  toggleConditionalFields();
  editId = id;
  el('#addBtn').textContent = 'Update';
  window.scrollTo({top:0,behavior:'smooth'});
}

function commitTransactionForm(){
  const description = el('#description').value.trim();
  const amount = parseFloat(el('#amount').value);
  const type = el('#type').value;
  const invId = el('#inventorySelect').value || '';
  const invQty = el('#quantity').value ? parseInt(el('#quantity').value,10) : 0;
  const paymentMethod = el('#paymentMethod') ? el('#paymentMethod').value : 'Cash';
  const customer = el('#customerName').value.trim();
  const supplier = el('#supplierName').value.trim();

  if(!description || isNaN(amount) || amount <= 0){ alert('Enter a valid description and amount.'); return; }
  if(invId && (!invQty || invQty <= 0)){ alert('Enter a valid quantity for the selected inventory item.'); return; }

  if(editId){
    const txn = transactions.find(x=>x.id === editId);
    if(!txn){ alert('Transaction not found'); return; }

    // revert original inventory if needed
    if(originalTxnSnapshot && originalTxnSnapshot.invId){
      const revertRes = revertTransactionInventory(originalTxnSnapshot);
      if(revertRes.error){ alert('Unable to revert original transaction: ' + revertRes.msg); return; }
    }

    const newTxn = {
      id: txn.id,
      description,
      amount,
      type,
      invId: invId || null,
      invQty: invId ? invQty : null,
      invName: invId ? (inventory.find(i=>i.id===invId)?.name || '') : null,
      invCost: 0,
      paymentMethod,
      customer: (type==='revenue') ? customer : '',
      supplier: (type==='expense' && invId) ? supplier : '',
      date: new Date().toISOString()
    };

    const applyRes = applyTransactionInventory(newTxn);
    if(applyRes.error){
      // rollback inventory to original
      if(originalTxnSnapshot){
        const rollbackRes = applyTransactionInventory(originalTxnSnapshot);
        if(rollbackRes.error){
          alert('Critical: failed to apply changes and rollback failed: ' + rollbackRes.msg);
        } else {
          alert('Edit cancelled: ' + applyRes.msg);
        }
      } else {
        alert('Edit cancelled: ' + applyRes.msg);
      }
      originalTxnSnapshot = null; editId = null; resetTransactionForm();
      renderTransactions(); renderInventory(); fillInventorySelects();
      updateDashboard(); updateMonthlySummary();
      return;
    }

    // store new values
    Object.assign(txn, newTxn);
    txn.invCost = Number(newTxn.invCost || 0);

    // IMPORTANT: Do NOT add an extra inventory log here (to avoid misleading +qty after edit).
    // Inventory effects are already captured by revertTransactionInventory + applyTransactionInventory.

    saveAll();
    updateJournalFromTxn(txn);

    originalTxnSnapshot = null; editId = null;
    resetTransactionForm();
    renderTransactions(); renderInventory(); fillInventorySelects();
    updateDashboard(); updateMonthlySummary();
    return;
  }

  // New transaction
  const newTxn = {
    id: uid(),
    description,
    amount,
    type,
    invId: invId || null,
    invQty: invId ? invQty : null,
    invName: invId ? (inventory.find(i=>i.id===invId)?.name || '') : null,
    invCost: 0,
    paymentMethod,
    customer: (type==='revenue') ? customer : '',
    supplier: (type==='expense' && invId) ? supplier : '',
    date: new Date().toISOString()
  };

  if(newTxn.invId){
    const applyRes = applyTransactionInventory(newTxn);
    if(applyRes.error){ alert(applyRes.msg); return; }
  } else newTxn.invCost = 0;

  addTransaction(newTxn);
  saveAll();
  resetTransactionForm();
}

function resetTransactionForm(){
  el('#description').value = '';
  el('#amount').value = '';
  el('#type').value = 'revenue';
  el('#inventorySelect').value = '';
  el('#quantity').value = '';
  el('#paymentMethod').value = 'Cash';
  el('#customerName').value = '';
  el('#supplierName').value = '';
  toggleConditionalFields();
  editId = null;
  originalTxnSnapshot = null;
  el('#addBtn').textContent = 'Add';
}

/* =========================
   INVENTORY UI + ACTIONS
   ========================= */
function renderInventory(){
  const tbody = qs('#inventoryTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';

  inventory.forEach(item=>{
    const tr = document.createElement('tr');
    tr.className = item.quantity <= 5 ? 'low-stock' : '';
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.description || ''}</td>
      <td>${item.category || ''}</td>
      <td>${item.quantity}</td>
      <td>${formatCurrency(item.unitPrice)}</td>
      <td>${formatCurrency(item.quantity * item.unitPrice)}</td>
      <td>
        <button class="inv-edit edit-btn" data-id="${item.id}">Edit</button>
        <button class="inv-del del-btn" data-id="${item.id}">Delete</button>
        <button class="inv-log-toggle ghost" data-id="${item.id}">Show Log</button>
      </td>
    `;
    tbody.appendChild(tr);

    // Per-item log row with Actions column for editing/deleting purchase transactions (moved here)
    const logRow = document.createElement('tr');
    logRow.className = 'item-log-row hidden';
    logRow.dataset.for = item.id;
    logRow.innerHTML = `<td colspan="7"><div class="item-log-wrapper">
      <strong>Log for ${item.name}</strong>
      <table class="small-log-table">
        <thead>
          <tr><th>Date</th><th>Action</th><th>Qty Change</th><th>Balance</th><th>Note</th><th>Actions</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </div></td>`;
    tbody.appendChild(logRow);
  });

  tbody.querySelectorAll('.inv-del').forEach(b=>{
    b.addEventListener('click', e=>{
      const id = e.target.dataset.id;
      if(!confirm('Delete inventory item? This will NOT change past transactions but will remove current stock records and logs. Continue?')) return;
      logs = logs.filter(l => l.itemId !== id);
      inventory = inventory.filter(x=>x.id !== id);
      saveAll();
      renderInventory();
      fillInventorySelects();
      updateInventoryValue();
      renderOverallLog();
    });
  });

  tbody.querySelectorAll('.inv-edit').forEach(b=>{
    b.addEventListener('click', e=> startEditInventory(e.target.dataset.id));
  });

  tbody.querySelectorAll('.inv-log-toggle').forEach(b=>{
    b.addEventListener('click', e=>{
      const id = e.target.dataset.id;
      togglePerItemLog(id);
      const btn = e.target;
      btn.textContent = btn.textContent === 'Show Log' ? 'Hide Log' : 'Show Log';
    });
  });

  // Delegate edit/delete of purchase transactions from the per-item log
  tbody.addEventListener('click', (e)=>{
    const editBtn = e.target.closest('.log-edit-txn');
    if(editBtn){
      const txnId = editBtn.dataset.txn;
      if(txnId) startEditTransaction(txnId);
    }
    const delBtn = e.target.closest('.log-delete-txn');
    if(delBtn){
      const txnId = delBtn.dataset.txn;
      if(!txnId) return;
      if(!confirm('Delete this linked purchase transaction? This will revert inventory and cascade journal updates.')) return;
      deleteTransaction(txnId);
    }
  });

  updateInventoryValue();
  renderOverallLog();
}

function updateInventoryValue(){
  const total = inventory.reduce((s,i)=> s + (Number(i.quantity) * Number(i.unitPrice || 0)), 0);
  el('#inventoryValue').textContent = formatCurrency(total);
}

function fillInventorySelects(){
  const invSelect = el('#inventorySelect');
  const stockSelect = el('#stockItemSelect');
  [invSelect, stockSelect].forEach(sel=>{
    if(!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">— None —</option>';
    inventory.forEach(it=>{
      const opt = document.createElement('option');
      opt.value = it.id; opt.textContent = `${it.name} (qty:${it.quantity})`;
      sel.appendChild(opt);
    });
    if(cur) sel.value = cur;
  });
}

function togglePerItemLog(itemId){
  const tbody = qs('#inventoryTable tbody');
  const rows = Array.from(tbody.querySelectorAll('tr.item-log-row'));
  rows.forEach(r=>{
    if(r.dataset.for === itemId){
      r.classList.toggle('hidden');
      const tb = r.querySelector('tbody'); tb.innerHTML = '';
      const entries = logs.filter(l => l.itemId === itemId);
      entries.forEach(en=>{
        // Try to extract txnId from note "Purchase tx XXX" or "Sale tx XXX"
        let linkedTxn = null;
        const m = /(?:Purchase|Sale) tx (\w+)/i.exec(en.note || '');
        if(m) linkedTxn = m[1];

        const rr = document.createElement('tr');
        rr.innerHTML = `<td>${new Date(en.timestamp).toLocaleString()}</td>
                        <td>${en.action}</td>
                        <td>${en.qtyChange>0? '+'+en.qtyChange: en.qtyChange}</td>
                        <td>${en.balanceAfter !== null ? en.balanceAfter : ''}</td>
                        <td>${en.note}</td>
                        <td>
                          ${(en.action === 'purchase' && linkedTxn) ? `
                            <button class="log-edit-txn" data-txn="${linkedTxn}">Edit Txn</button>
                            <button class="log-delete-txn" data-txn="${linkedTxn}">Delete Txn</button>` : ''}
                        </td>`;
        tb.appendChild(rr);
      });
    } else {
      r.classList.add('hidden');
      const toggleBtn = tbody.querySelector(`button.inv-log-toggle[data-id="${r.dataset.for}"]`);
      if(toggleBtn) toggleBtn.textContent = 'Show Log';
    }
  });
}

function renderOverallLog(){
  const wrap = el('#overallLogWrapper');
  if(!wrap) return;
  const tb = qs('#overallLogTable tbody');
  if(!tb) return;
  tb.innerHTML = '';
  logs.forEach(en=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(en.timestamp).toLocaleString()}</td>
                    <td>${en.itemName || ''}</td>
                    <td>${en.action}</td>
                    <td>${en.qtyChange>0? '+'+en.qtyChange: en.qtyChange}</td>
                    <td>${en.balanceAfter !== null ? en.balanceAfter : ''}</td>
                    <td>${en.note}</td>`;
    tb.appendChild(tr);
  });
}

function startEditInventory(id){
  const it = inventory.find(x=>x.id===id);
  if(!it) return;
  el('#itemName').value = it.name;
  el('#itemDesc').value = it.description || '';
  el('#itemCategory').value = it.category || '';
  el('#itemPrice').value = it.unitPrice;
  el('#itemQtyStart').value = it.quantity;
  editingInventoryId = id;
  window.scrollTo({top:0,behavior:'smooth'});
}

function clearInventoryForm(){
  el('#itemName').value = '';
  el('#itemDesc').value = '';
  el('#itemCategory').value = '';
  el('#itemPrice').value = '';
  el('#itemQtyStart').value = 0;
  editingInventoryId = null;
}

// stock adjust form
function handleStockAdjust(e){
  e.preventDefault();
  const id = el('#stockItemSelect').value;
  const qty = parseInt(el('#stockQty').value,10);
  const action = el('#stockAction').value;
  const paymentMethod = el('#stockPaymentMethod') ? el('#stockPaymentMethod').value : 'Cash';
  if(!id || !qty || qty <= 0){ alert('Select item and enter valid qty'); return; }
  const it = inventory.find(x=>x.id===id);
  if(!it) return;

  if(action === 'add'){
    const unit = Number(it.unitPrice || 0);
    const amount = unit * qty;
    const newTxn = {
      id: uid(),
      description: `Purchase - ${it.name}`,
      amount: amount,
      type: 'expense',
      invId: it.id,
      invQty: qty,
      invName: it.name,
      invCost: 0,
      paymentMethod: paymentMethod,
      supplier: '', // can be edited later
      date: new Date().toISOString()
    };
    const applyRes = applyTransactionInventory(newTxn);
    if(applyRes.error){ alert(applyRes.msg); return; }
    addTransaction(newTxn);
    saveAll();
    return;
  } else {
    if(it.quantity < qty){
      if(!confirm('Removing this quantity will make stock negative. Continue?')) return;
    }
    it.quantity = Number(it.quantity) - qty;
    addLog(it.id, 'manual', -qty, 'Manual remove');
    saveAll();
    renderInventory(); fillInventorySelects(); updateInventoryValue();
    return;
  }
}

/* =========================
   PAYMENTS: ACCOUNTS RECEIVABLE / PAYABLE
   ========================= */
// Sales: mark as paid (full or partial)
function markSalePaid(saleId, amount){
  const sale = salesJournal.find(s => s.id === saleId);
  if(!sale){ alert('Sale record not found'); return; }
  const remaining = Math.max(0, Number(sale.amount) - Number(sale.paidAmount || 0));
  let payAmt = amount;
  if(payAmt === null || payAmt === undefined) payAmt = remaining; // full
  payAmt = Math.min(payAmt, remaining);
  if(payAmt <= 0){ alert('Nothing to pay.'); return; }

  sale.paidAmount = Number(sale.paidAmount || 0) + payAmt;
  sale.paid = sale.paidAmount >= Number(sale.amount);

  const receipt = {
    id: uid(),
    date: new Date().toISOString(),
    from: sale.customer || sale.description || 'Customer',
    amount: Number(payAmt),
    saleId: sale.id,
    note: sale.paid ? 'Paid in full' : 'Partial payment'
  };
  cashReceipts.unshift(receipt);
  saveAll();
  renderSalesJournal();
  renderCashReceipts();
  renderGeneralJournal();
}

// Purchases: pay supplier (full or partial)
function paySupplier(purchaseId, amount){
  const p = purchasesJournal.find(x=>x.id===purchaseId);
  if(!p){ alert('Purchase record not found'); return; }
  const remaining = Math.max(0, Number(p.amount) - Number(p.paidAmount || 0));
  let payAmt = amount;
  if(payAmt === null || payAmt === undefined) payAmt = remaining; // full
  payAmt = Math.min(payAmt, remaining);
  if(payAmt <= 0){ alert('Nothing to pay.'); return; }

  p.paidAmount = Number(p.paidAmount || 0) + payAmt;
  p.paid = p.paidAmount >= Number(p.amount);

  const disb = {
    id: uid(),
    date: new Date().toISOString(),
    description: p.supplier || p.description || 'Supplier',
    amount: Number(payAmt),
    txnId: p.txnId,
    note: p.paid ? 'Paid in full' : 'Partial payment'
  };
  cashDisbursements.unshift(disb);
  saveAll();
  renderPurchasesJournal();
  renderCashDisbursements();
  renderGeneralJournal();
}

/* =========================
   INIT UI AND EVENTS
   ========================= */
document.addEventListener('DOMContentLoaded', ()=>{
  // One-time wipe so we start fresh for this trial, but keep new data afterwards
  trialResetIfNeeded();

  loadAll();

  // settings + theme
  applySettingsUI();

  renderTransactions();
  renderInventory();
  fillInventorySelects();
  updateDashboard();
  updateMonthlySummary();
  updateInventoryValue();

  // Journals
  renderPurchasesJournal();
  renderSalesJournal();
  renderCashReceipts();
  renderCashDisbursements();
  renderGeneralJournal();

  // NAV tabs
  qsa('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      qsa('.tab-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.target;
      qsa('.view').forEach(v=>v.classList.remove('active'));
      el('#'+target).classList.add('active');
      if(target === 'inventoryView'){ renderInventory(); fillInventorySelects(); updateInventoryValue(); renderOverallLog(); }
      if(target === 'journalsView'){
        renderPurchasesJournal(); renderSalesJournal(); renderCashReceipts(); renderCashDisbursements(); renderGeneralJournal();
      }
    });
  });

  // Journals sub-tabs
  qsa('.journal-subtab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      qsa('.journal-subtab-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      qsa('.journal-subview').forEach(v=>v.classList.remove('active'));
      const target = btn.dataset.target;
      el('#'+target).classList.add('active');
      if(target === 'purchasesJournalView') renderPurchasesJournal();
      if(target === 'salesJournalView') renderSalesJournal();
      if(target === 'cashReceiptsView') renderCashReceipts();
      if(target === 'cashDisbursementsView') renderCashDisbursements();
      if(target === 'generalJournalView') renderGeneralJournal();
    });
  });

  // transaction submit
  el('#transactionForm').addEventListener('submit', e=>{
    e.preventDefault();
    commitTransactionForm();
  });
  el('#resetTxnBtn').addEventListener('click', resetTransactionForm);

  // filters
  on('#applyFilter','click', ()=>{
    const from = el('#fromDate').value;
    const to = el('#toDate').value;
    renderTransactions(from,to);
  });
  on('#clearFilter','click', ()=>{
    el('#fromDate').value = '';
    el('#toDate').value = '';
    renderTransactions();
  });

  // inventory form submit
  el('#inventoryForm').addEventListener('submit', e=>{
    e.preventDefault();
    const name = el('#itemName').value.trim();
    const desc = el('#itemDesc').value.trim();
    const cat = el('#itemCategory').value.trim();
    const price = parseFloat(el('#itemPrice').value);
    const qtyStart = parseInt(el('#itemQtyStart').value,10) || 0;
    if(!name || isNaN(price) || price < 0){ alert('Enter item name and valid price'); return; }

    if(editingInventoryId){
      const it = inventory.find(x=>x.id === editingInventoryId);
      if(it){
        it.name = name; it.description = desc; it.category = cat; it.unitPrice = Number(price);
        if(it.quantity !== Number(qtyStart)){
          const diff = Number(qtyStart) - Number(it.quantity);
          it.quantity = Number(qtyStart);
          addLog(it.id, 'manual', diff, 'Edit item starting qty adjusted');
        }
      }
      editingInventoryId = null;
    } else {
      const id = uid();
      inventory.push({ id, name, description: desc, category: cat, unitPrice: Number(price), quantity: Number(qtyStart) });
      if(qtyStart !== 0) addLog(id, 'manual', Number(qtyStart), 'Initial stock on item creation');
    }

    saveAll();
    clearInventoryForm();
    renderInventory();
    fillInventorySelects();
  });

  on('#inventoryClear','click', clearInventoryForm);
  on('#stockForm','submit', handleStockAdjust);

  // month picker
  const monthPicker = el('#monthPicker');
  if(monthPicker){
    const now = new Date();
    monthPicker.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    monthPicker.addEventListener('change', ()=> updateMonthlySummary());
  }

  // purchases log toggle
  const toggleOverallLogBtn = el('#toggleOverallLog');
  if(toggleOverallLogBtn){
    toggleOverallLogBtn.addEventListener('click', ()=>{
      const wrap = el('#overallLogWrapper');
      if(!wrap) return;
      wrap.classList.toggle('hidden');
      toggleOverallLogBtn.textContent = wrap.classList.contains('hidden') ? 'Show Purchases Log' : 'Hide Purchases Log';
      if(!wrap.classList.contains('hidden')) renderOverallLog();
    });
  }

  // theme toggle (dark)
  const themeToggleBtn = el('#theme-toggle');
  if(settings.theme === 'dark'){ document.body.classList.add('dark-mode'); themeToggleBtn.textContent = '☀️ Light Mode'; }
  if(themeToggleBtn){
    themeToggleBtn.addEventListener('click', ()=>{
      document.body.classList.toggle('dark-mode');
      settings.theme = document.body.classList.contains('dark-mode') ? 'dark' : 'light';
      saveAll();
      themeToggleBtn.textContent = (settings.theme==='dark') ? '☀️ Light Mode' : '🌙 Dark Mode';
    });
  }

  // accent picker
  qsa('.accent-dot').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const accent = btn.dataset.accent;
      document.body.classList.remove('theme-blue','theme-green','theme-lavender');
      document.body.classList.add(`theme-${accent}`);
      settings.accent = accent;
      saveAll();
    });
  });

  // edit business
  on('#editBizBtn','click', ()=>{
    const name = prompt('Enter business name:', settings.businessName || 'Monimo');
    if(name===null) return;
    settings.businessName = name.trim() || 'Monimo';
    saveAll();
    applySettingsUI();
  });

  // show/hide conditional fields on type/select change
  el('#type').addEventListener('change', toggleConditionalFields);
  el('#inventorySelect').addEventListener('change', toggleConditionalFields);
  toggleConditionalFields();
}); // DOMContentLoaded

/* =========================
   MONTHLY SUMMARY (Exclude inventory purchase expenses)
   ========================= */
function updateMonthlySummary(year, month){
  let targetYear, targetMonth;
  if(year !== undefined && month !== undefined){
    targetYear = year; targetMonth = month;
  } else {
    const picker = el('#monthPicker');
    if(picker && picker.value){
      const parts = picker.value.split('-'); targetYear = parseInt(parts[0],10); targetMonth = parseInt(parts[1],10)-1;
    } else {
      const now = new Date(); targetYear = now.getFullYear(); targetMonth = now.getMonth();
    }
  }

  const start = new Date(targetYear, targetMonth, 1);
  const end = new Date(targetYear, targetMonth+1, 0, 23,59,59,999);
  const monthly = transactions.filter(t => {
    const d = new Date(t.date); return d >= start && d <= end;
  });

  const income = monthly.filter(t => t.type === 'revenue').reduce((s,t)=> s + Number(t.amount), 0);
  const expensesExInv = monthly.filter(t => t.type === 'expense' && !t.invId).reduce((s,t)=> s + Number(t.amount), 0);
  const invCost = monthly.reduce((s,t)=> s + getTxnInventoryCost(t), 0);
  const net = income - invCost - expensesExInv;
  const monthName = start.toLocaleString('default',{month:'long',year:'numeric'});

  el('#monthIncomeLabel').textContent = `${monthName} — Income`;
  el('#monthInvCostLabel').textContent = `${monthName} — Inventory Cost`;
  el('#monthExpenseLabel').textContent = `${monthName} — Expenses`;
  el('#monthNetLabel').textContent = `${monthName} — Net`;
  el('#monthlyIncome').textContent = formatCurrency(income);
  el('#monthlyInvCost').textContent = formatCurrency(invCost);
  el('#monthlyExpense').textContent = formatCurrency(expensesExInv);
  el('#monthlyNet').textContent = formatCurrency(net);
}

/* =========================
   UI HELPERS
   ========================= */
function el(sel){ return document.querySelector(sel); }
function qs(sel){ return document.querySelector(sel); }
function qsa(sel){ return Array.from(document.querySelectorAll(sel)); }
function on(sel, ev, fn){ const n=el(sel); if(n) n.addEventListener(ev, fn); }

function applySettingsUI(){
  // business name
  const h = el('#bizName');
  if(h) h.textContent = settings.businessName || 'Monimo';
  document.title = `${settings.businessName || 'Monimo'} — Dashboard`;

  // accent
  document.body.classList.remove('theme-blue','theme-green','theme-lavender');
  document.body.classList.add(`theme-${settings.accent || 'blue'}`);

  // theme
  if(settings.theme === 'dark') document.body.classList.add('dark-mode');
  else document.body.classList.remove('dark-mode');
}

// Show/hide conditional fields
function toggleConditionalFields(){
  const type = el('#type').value;
  const hasInv = !!el('#inventorySelect').value;
  const custField = document.querySelector('.field-customer');
  const suppField = document.querySelector('.field-supplier');

  if(custField) custField.style.display = (type==='revenue') ? 'flex' : 'none';
  if(suppField) {
    // supplier shown only for expense with inventory (purchases)
    suppField.style.display = (type==='expense' && hasInv) ? 'flex' : 'none';
  }
}
