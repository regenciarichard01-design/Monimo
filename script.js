/* Monimo - script.js
   Transactions + Inventory + Inventory Logs (localStorage)
*/

// STORAGE KEYS
const STORAGE_KEY = 'monimo_transactions';
const INV_KEY = 'inventoryData';
const LOG_KEY = 'inventoryLogs';

// App state
let transactions = [];
let inventory = [];
let logs = []; // overall logs
let editId = null; // transaction currently editing
let editingInventoryId = null; // inventory item editing flag

// --- helpers ---
function formatCurrency(num){
  return '₱' + Number(num || 0).toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2});
}
function uid(){ return Date.now().toString() + Math.floor(Math.random()*1000); }
function nowISO(){ return new Date().toISOString(); }

// --- load / save ---
function loadAll(){
  const raw = localStorage.getItem(STORAGE_KEY);
  transactions = raw ? JSON.parse(raw) : [];
  const rawInv = localStorage.getItem(INV_KEY);
  inventory = rawInv ? JSON.parse(rawInv) : [];
  const rawLogs = localStorage.getItem(LOG_KEY);
  logs = rawLogs ? JSON.parse(rawLogs) : [];
}
function saveAll(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
  localStorage.setItem(INV_KEY, JSON.stringify(inventory));
  localStorage.setItem(LOG_KEY, JSON.stringify(logs));
}

// --- logging ---
/*
 log entry:
 { id, timestamp, itemId, itemName, action, qtyChange, balanceAfter, note }
 action: 'sale' (deduct), 'purchase' (add), 'restore' (reverted from edit/delete), 'manual' (stock adjustments), 'edit' (edit adjustment)
*/
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
  logs.unshift(entry); // newest first
  saveAll();
  renderOverallLog(); // refresh UI
}

// --- transactions UI + behavior ---
function updateDashboard(){
  const revenue = transactions.filter(t => t.type === 'revenue').reduce((s,t)=> s + Number(t.amount), 0);
  const expense = transactions.filter(t => t.type === 'expense').reduce((s,t)=> s + Number(t.amount), 0);
  const profit = revenue - expense;
  document.getElementById('totalRevenue').textContent = formatCurrency(revenue);
  document.getElementById('totalExpense').textContent = formatCurrency(expense);
  document.getElementById('profit').textContent = formatCurrency(profit);
}

function renderTransactions(filterFrom, filterTo){
  const tbody = document.querySelector('#transactionsTable tbody');
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
    tr.innerHTML = `
      <td>${new Date(t.date).toLocaleString()}</td>
      <td>${t.description}${t.invName ? `<div class="muted">Item: ${t.invName} ×${t.invQty}</div>` : ''}</td>
      <td>${t.type}</td>
      <td>${formatCurrency(t.amount)}</td>
      <td>
        <button class="edit-btn" data-id="${t.id}">Edit</button>
        <button class="del-btn" data-id="${t.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // handlers
  tbody.querySelectorAll('.del-btn').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const id = e.target.dataset.id;
      if(!confirm('Delete this transaction? This will also restore/revert inventory linked to it.')) return;
      deleteTransaction(id);
    });
  });

  tbody.querySelectorAll('.edit-btn').forEach(btn=>{
    btn.addEventListener('click', e=>{
      startEditTransaction(e.target.dataset.id);
    });
  });
}

// --- inventory application helpers ---
// revert effect of a transaction (used for edit/delete). Returns object {ok:true} or {error:true, msg}
function revertTransactionInventory(txn){
  if(!txn || !txn.invId) return { ok: true };
  const inv = inventory.find(i=>i.id === txn.invId);
  if(!inv) return { error:true, msg: 'Inventory item no longer exists' };

  const qty = Number(txn.invQty || 0);
  if(txn.type === 'revenue'){ // originally a sale that deducted stock -> restore by adding qty
    inv.quantity = Number(inv.quantity) + qty;
    addLog(inv.id, 'restore', +qty, `Restore from revert of sale tx ${txn.id}`);
    saveAll();
    return { ok:true };
  } else if(txn.type === 'expense'){ // originally a purchase that added stock -> revert by subtracting qty
    // subtracting could produce negative. warn and still perform unless user cancels earlier.
    inv.quantity = Number(inv.quantity) - qty;
    addLog(inv.id, 'restore', -qty, `Restore (remove) from revert of purchase tx ${txn.id}`);
    saveAll();
    return { ok:true };
  }
  return { ok:true };
}

// apply transaction inventory effect (for new or edited txn). If not enough stock on sale -> return error
function applyTransactionInventory(txn){
  if(!txn || !txn.invId) return { ok:true };
  const inv = inventory.find(i=>i.id === txn.invId);
  if(!inv) return { error:true, msg: 'Inventory item not found' };
  const qty = Number(txn.invQty || 0);
  if(txn.type === 'revenue'){ // sale -> decrease
    if(inv.quantity < qty) return { error:true, msg: `Not enough stock for "${inv.name}". Available: ${inv.quantity}` };
    inv.quantity = Number(inv.quantity) - qty;
    addLog(inv.id, 'sale', -qty, `Sale tx ${txn.id}`);
  } else if(txn.type === 'expense'){ // purchase -> increase
    inv.quantity = Number(inv.quantity) + qty;
    addLog(inv.id, 'purchase', +qty, `Purchase tx ${txn.id}`);
  }
  saveAll();
  return { ok:true };
}

// --- transaction flows: add / edit / delete ---
// add new transaction (already validated before calling)
function addTransaction(txn){
  transactions.push(txn);
  saveAll();
  updateDashboard();
  renderTransactions();
  renderInventory();
  fillInventorySelects();
  updateMonthlySummary();
}

// delete transaction: revert inventory then remove txn and log
function deleteTransaction(id){
  const idx = transactions.findIndex(t=>t.id===id);
  if(idx === -1) return;
  const txn = transactions[idx];

  // revert inventory effect
  if(txn.invId){
    const inv = inventory.find(i => i.id === txn.invId);
    if(inv){
      // compute what will be the new quantity if we revert
      let newQty = inv.quantity;
      if(txn.type === 'revenue') newQty = Number(inv.quantity) + Number(txn.invQty || 0);
      else if(txn.type === 'expense') newQty = Number(inv.quantity) - Number(txn.invQty || 0);

      if(txn.type === 'expense' && newQty < 0){
        // warning: reverting this purchase will make stock negative (because purchases were previously consumed)
        const ok = confirm(`Reverting this purchase will make "${inv.name}" negative (${newQty}). Continue?`);
        if(!ok) return; // abort deletion
      }
      // apply revert
      const res = revertTransactionInventory(txn);
      if(res.error){
        alert('Error reverting inventory: ' + res.msg);
        return;
      }
    }
  }

  // remove txn
  transactions.splice(idx,1);
  saveAll();
  renderTransactions();
  updateDashboard();
  updateMonthlySummary();
  renderInventory();
  fillInventorySelects();
}

// start editing: populate form and keep original snapshot
let originalTxnSnapshot = null;
function startEditTransaction(id){
  const t = transactions.find(x=>x.id===id);
  if(!t) return;
  // keep original snapshot to revert later
  originalTxnSnapshot = JSON.parse(JSON.stringify(t));
  document.getElementById('description').value = t.description;
  document.getElementById('amount').value = t.amount;
  document.getElementById('type').value = t.type;
  document.getElementById('inventorySelect').value = t.invId || '';
  document.getElementById('quantity').value = t.invQty || '';
  editId = id;
  document.getElementById('addBtn').textContent = 'Update';
}

// handle submit from form: add new or commit edit
function commitTransactionForm(){
  const description = document.getElementById('description').value.trim();
  const amount = parseFloat(document.getElementById('amount').value);
  const type = document.getElementById('type').value;
  const invId = document.getElementById('inventorySelect').value || '';
  const invQty = document.getElementById('quantity').value ? parseInt(document.getElementById('quantity').value,10) : 0;

  if(!description || isNaN(amount) || amount <= 0){ alert('Enter a valid description and amount.'); return; }
  if(invId && (!invQty || invQty <= 0)){ alert('Enter a valid quantity for the selected inventory item.'); return; }

  if(editId){
    // editing existing transaction
    const txn = transactions.find(x=>x.id === editId);
    if(!txn){ alert('Transaction not found'); return; }

    // Step 1: revert originalTxnSnapshot inventory (if it had inv)
    if(originalTxnSnapshot && originalTxnSnapshot.invId){
      const revertRes = revertTransactionInventory(originalTxnSnapshot);
      if(revertRes.error){
        alert('Unable to revert original transaction: ' + revertRes.msg);
        return;
      }
    }

    // Step 2: apply new inventory effect (if any)
    const newTxn = {
      id: txn.id,
      description,
      amount,
      type,
      invId: invId || null,
      invQty: invId ? invQty : null,
      invName: invId ? (inventory.find(i=>i.id===invId)?.name || '') : null,
      date: new Date().toISOString()
    };

    const applyRes = applyTransactionInventory(newTxn);
    if(applyRes.error){
      // rollback: re-apply original txn effect (to keep inventory consistent)
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
      originalTxnSnapshot = null;
      editId = null;
      resetTransactionForm();
      renderTransactions();
      renderInventory();
      fillInventorySelects();
      updateDashboard();
      updateMonthlySummary();
      return;
    }

    // Step 3: store new txn values
    txn.description = newTxn.description;
    txn.amount = newTxn.amount;
    txn.type = newTxn.type;
    txn.invId = newTxn.invId;
    txn.invQty = newTxn.invQty;
    txn.invName = newTxn.invName;
    txn.date = newTxn.date;

    // add log entry specifically for edit (reason)
    if(newTxn.invId){
      addLog(newTxn.invId, 'edit', Number(newTxn.invQty || 0), `Edited tx ${txn.id}`);
    }
    saveAll();
    originalTxnSnapshot = null;
    editId = null;
    resetTransactionForm();
    renderTransactions();
    renderInventory();
    fillInventorySelects();
    updateDashboard();
    updateMonthlySummary();
    return;
  }

  // New transaction flow
  const newTxn = {
    id: uid(),
    description,
    amount,
    type,
    invId: invId || null,
    invQty: invId ? invQty : null,
    invName: invId ? (inventory.find(i=>i.id===invId)?.name || '') : null,
    date: new Date().toISOString()
  };

  // apply inventory effect if linked
  if(newTxn.invId){
    const applyRes = applyTransactionInventory(newTxn);
    if(applyRes.error){
      alert(applyRes.msg);
      return;
    }
  }

  addTransaction(newTxn);
  saveAll();
  resetTransactionForm();
}

// reset transaction form
function resetTransactionForm(){
  document.getElementById('description').value = '';
  document.getElementById('amount').value = '';
  document.getElementById('type').value = 'revenue';
  document.getElementById('inventorySelect').value = '';
  document.getElementById('quantity').value = '';
  editId = null;
  originalTxnSnapshot = null;
  document.getElementById('addBtn').textContent = 'Add';
}

// --- inventory UI + actions ---
function renderInventory(){
  const tbody = document.querySelector('#inventoryTable tbody');
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
        <button class="inv-edit" data-id="${item.id}">Edit</button>
        <button class="inv-del" data-id="${item.id}">Delete</button>
        <button class="inv-log-toggle" data-id="${item.id}">Show Log</button>
      </td>
    `;
    tbody.appendChild(tr);

    // per-item log placeholder row (hidden)
    const logRow = document.createElement('tr');
    logRow.className = 'item-log-row hidden';
    logRow.dataset.for = item.id;
    logRow.innerHTML = `<td colspan="7"><div class="item-log-wrapper"><strong>Log for ${item.name}</strong>
      <table class="small-log-table"><thead><tr><th>Date</th><th>Action</th><th>Qty Change</th><th>Balance</th><th>Note</th></tr></thead><tbody></tbody></table></div></td>`;
    tbody.appendChild(logRow);
  });

  // handlers
  tbody.querySelectorAll('.inv-del').forEach(b=>{
    b.addEventListener('click', e=>{
      const id = e.target.dataset.id;
      if(!confirm('Delete inventory item? This will NOT change past transactions but will remove current stock records and logs. Continue?')) return;
      // remove logs for this item
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
    b.addEventListener('click', e=>{
      const id = e.target.dataset.id;
      startEditInventory(id);
    });
  });

  tbody.querySelectorAll('.inv-log-toggle').forEach(b=>{
    b.addEventListener('click', e=>{
      const id = e.target.dataset.id;
      togglePerItemLog(id);
      // update button text
      const btn = e.target;
      btn.textContent = btn.textContent === 'Show Log' ? 'Hide Log' : 'Show Log';
    });
  });

  updateInventoryValue();
  renderOverallLog(); // keep log up to date
}

// inventory total value
function updateInventoryValue(){
  const total = inventory.reduce((s,i)=> s + (Number(i.quantity) * Number(i.unitPrice || 0)), 0);
  document.getElementById('inventoryValue').textContent = formatCurrency(total);
}

// fill inventory dropdowns
function fillInventorySelects(){
  const invSelect = document.getElementById('inventorySelect');
  const stockSelect = document.getElementById('stockItemSelect');
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

// per-item log toggle
function togglePerItemLog(itemId){
  const tbody = document.querySelector('#inventoryTable tbody');
  const rows = Array.from(tbody.querySelectorAll('tr.item-log-row'));
  rows.forEach(r=>{
    if(r.dataset.for === itemId){
      r.classList.toggle('hidden');
      // render logs into this row
      const tb = r.querySelector('tbody');
      tb.innerHTML = '';
      const entries = logs.filter(l => l.itemId === itemId);
      entries.forEach(en=>{
        const rr = document.createElement('tr');
        rr.innerHTML = `<td>${new Date(en.timestamp).toLocaleString()}</td>
                        <td>${en.action}</td>
                        <td>${en.qtyChange>0? '+'+en.qtyChange: en.qtyChange}</td>
                        <td>${en.balanceAfter !== null ? en.balanceAfter : ''}</td>
                        <td>${en.note}</td>`;
        tb.appendChild(rr);
      });
    } else {
      // ensure other log rows hidden
      r.classList.add('hidden');
      const toggleBtn = tbody.querySelector(`button.inv-log-toggle[data-id="${r.dataset.for}"]`);
      if(toggleBtn) toggleBtn.textContent = 'Show Log';
    }
  });
}

// overall log render
function renderOverallLog(){
  const wrap = document.getElementById('overallLogWrapper');
  if(!wrap) return;
  const tb = document.querySelector('#overallLogTable tbody');
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

// start edit inventory
function startEditInventory(id){
  const it = inventory.find(x=>x.id===id);
  if(!it) return;
  document.getElementById('itemName').value = it.name;
  document.getElementById('itemDesc').value = it.description || '';
  document.getElementById('itemCategory').value = it.category || '';
  document.getElementById('itemPrice').value = it.unitPrice;
  document.getElementById('itemQtyStart').value = it.quantity;
  editingInventoryId = id;
  window.scrollTo({top:0,behavior:'smooth'});
}

// clear inventory form
function clearInventoryForm(){
  document.getElementById('itemName').value = '';
  document.getElementById('itemDesc').value = '';
  document.getElementById('itemCategory').value = '';
  document.getElementById('itemPrice').value = '';
  document.getElementById('itemQtyStart').value = 0;
  editingInventoryId = null;
}

// handle stock adjust form (manual add/remove)
function handleStockAdjust(e){
  e.preventDefault();
  const id = document.getElementById('stockItemSelect').value;
  const qty = parseInt(document.getElementById('stockQty').value,10);
  const action = document.getElementById('stockAction').value;
  if(!id || !qty || qty <= 0){ alert('Select item and enter valid qty'); return; }
  const it = inventory.find(x=>x.id===id);
  if(!it) return;
  if(action === 'add'){ it.quantity = Number(it.quantity) + qty; addLog(it.id, 'manual', +qty, 'Manual add'); }
  else { // remove
    if(it.quantity < qty){
      if(!confirm('Removing this quantity will make stock negative. Continue?')) return;
    }
    it.quantity = Number(it.quantity) - qty;
    addLog(it.id, 'manual', -qty, 'Manual remove');
  }
  saveAll();
  renderInventory();
  fillInventorySelects();
  updateInventoryValue();
}

// --- init UI and event wiring ---
document.addEventListener('DOMContentLoaded', ()=>{

  loadAll();
  renderTransactions();
  renderInventory();
  fillInventorySelects();
  updateDashboard();
  updateMonthlySummary();
  updateInventoryValue();

  // NAV tabs
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.target;
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      document.getElementById(target).classList.add('active');
      if(target === 'inventoryView'){ renderInventory(); fillInventorySelects(); updateInventoryValue(); renderOverallLog(); }
    });
  });

  // transaction submit
  document.getElementById('transactionForm').addEventListener('submit', e=>{
    e.preventDefault();
    commitTransactionForm();
  });

  // filters
  const applyBtn = document.getElementById('applyFilter');
  if(applyBtn) applyBtn.addEventListener('click', ()=> {
    const from = document.getElementById('fromDate').value;
    const to = document.getElementById('toDate').value;
    renderTransactions(from,to);
  });
  const clearBtn = document.getElementById('clearFilter');
  if(clearBtn) clearBtn.addEventListener('click', ()=> {
    document.getElementById('fromDate').value = '';
    document.getElementById('toDate').value = '';
    renderTransactions();
  });

  // inventory form submit
  document.getElementById('inventoryForm').addEventListener('submit', e=>{
    e.preventDefault();
    const name = document.getElementById('itemName').value.trim();
    const desc = document.getElementById('itemDesc').value.trim();
    const cat = document.getElementById('itemCategory').value.trim();
    const price = parseFloat(document.getElementById('itemPrice').value);
    const qtyStart = parseInt(document.getElementById('itemQtyStart').value,10) || 0;
    if(!name || isNaN(price) || price < 0){ alert('Enter item name and valid price'); return; }

    if(editingInventoryId){
      const it = inventory.find(x=>x.id === editingInventoryId);
      if(it){
        it.name = name; it.description = desc; it.category = cat; it.unitPrice = Number(price);
        // if starting quantity changed, record manual adjustment
        if(it.quantity !== Number(qtyStart)){
          const diff = Number(qtyStart) - Number(it.quantity);
          it.quantity = Number(qtyStart);
          addLog(it.id, 'manual', diff, 'Edit item starting qty adjusted');
        }
      }
      editingInventoryId = null;
    } else {
      const id = uid();
      inventory.push({
        id,
        name,
        description: desc,
        category: cat,
        unitPrice: Number(price),
        quantity: Number(qtyStart)
      });
      if(qtyStart !== 0) addLog(id, 'manual', Number(qtyStart), 'Initial stock on item creation');
    }

    saveAll();
    clearInventoryForm();
    renderInventory();
    fillInventorySelects();
  });

  document.getElementById('inventoryClear').addEventListener('click', ()=> clearInventoryForm());
  document.getElementById('stockForm').addEventListener('submit', handleStockAdjust);

  // month picker
  const monthPicker = document.getElementById('monthPicker');
  if(monthPicker){
    const now = new Date();
    monthPicker.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    monthPicker.addEventListener('change', ()=> updateMonthlySummary());
  }

  // overall log toggle
  const toggleOverallLogBtn = document.getElementById('toggleOverallLog');
  if(toggleOverallLogBtn){
    toggleOverallLogBtn.addEventListener('click', ()=>{
      const wrap = document.getElementById('overallLogWrapper');
      if(!wrap) return;
      wrap.classList.toggle('hidden');
      toggleOverallLogBtn.textContent = wrap.classList.contains('hidden') ? 'Show Inventory Log' : 'Hide Inventory Log';
      if(!wrap.classList.contains('hidden')) renderOverallLog();
    });
  }

  // theme toggle
  const themeToggleBtn = document.getElementById('theme-toggle');
  if(localStorage.getItem('theme') === 'dark'){ document.body.classList.add('dark-mode'); if(themeToggleBtn) themeToggleBtn.textContent = '☀️ Light Mode'; }
  if(themeToggleBtn){
    themeToggleBtn.addEventListener('click', ()=> {
      document.body.classList.toggle('dark-mode');
      if(document.body.classList.contains('dark-mode')){ localStorage.setItem('theme','dark'); themeToggleBtn.textContent = '☀️ Light Mode'; }
      else { localStorage.setItem('theme','light'); themeToggleBtn.textContent = '🌙 Dark Mode'; }
    });
  }
}); // DOMContentLoaded end

// --- monthly summary (kept at bottom so functions available above) ---
function updateMonthlySummary(year, month){
  let targetYear, targetMonth;
  if(year !== undefined && month !== undefined){
    targetYear = year; targetMonth = month;
  } else {
    const picker = document.getElementById('monthPicker');
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
  const expenses = monthly.filter(t => t.type === 'expense').reduce((s,t)=> s + Number(t.amount), 0);
  const net = income - expenses;
  const monthName = start.toLocaleString('default',{month:'long',year:'numeric'});

  document.getElementById('monthIncomeLabel').textContent = `${monthName} — Income`;
  document.getElementById('monthExpenseLabel').textContent = `${monthName} — Expenses`;
  document.getElementById('monthNetLabel').textContent = `${monthName} — Net`;
  document.getElementById('monthlyIncome').textContent = formatCurrency(income);
  document.getElementById('monthlyExpense').textContent = formatCurrency(expenses);
  document.getElementById('monthlyNet').textContent = formatCurrency(net);
}

// helper to render overall log initially hidden
(function initOverallLogHidden(){
  // no-op here; overall log toggled by button
})();
