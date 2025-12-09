// --- 1. CONFIGURATION ---
// Motor House OS v29.2 core logic. This file implements a number of
// robustness improvements over v29.1, including global invoice number
// sequencing via Firestore transactions, schema version tagging on all
// documents, improved data validation, and clearer backup semantics.

// Schema version for documents. Increment this when the structure of
// saved documents changes so legacy data can be migrated if needed.
const SCHEMA_VERSION = 1;

const COMPANY = {
  name: "Motorhouse Beds LTD",
  address: "87 High Street, Clapham, Bedford MK41 6AQ",
  phone: "01234 225570",
  email: "sales@motorhouse-beds.co.uk",
  vat: "444016621",
  bank: {
    name: "MOTORHOUSEBEDSLTD",
    sort: "20-18-15",
    acc: "73419029"
  }
};

// Terms line used on all invoices (edit this text to change everywhere)
const TERMS_TEXT = "Payment due within 14 days from invoice date. Please quote the invoice number on all payments.";

const FB_CONFIG = {
  apiKey: "AIzaSyAZq49d8HxmGO_ERZqB6LC2o8ToT1GczbU",
  authDomain: "motorhouse-af894.firebaseapp.com",
  databaseURL: "https://motorhouse-af894-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "motorhouse-af894",
  storageBucket: "motorhouse-af894.firebasestorage.app",
  messagingSenderId: "491547998232",
  appId: "1:491547998232:web:a86795a4755ca59709eb6d"
};

const VHC_ITEMS = [
  "NSF Tyre", "OSF Tyre", "NSR Tyre", "OSR Tyre",
  "Front Brakes", "Rear Brakes", "Brake Fluid",
  "Oil Level", "Coolant", "Screenwash", "Lights",
  "Wipers", "Suspension", "Exhaust", "Battery"
];

// --- 2. STATE ---
let db = null;
let offline = true;
let unsubscribers = []; // track Firestore listeners so we can clean them up
let DATA = { invoices: [], fleet: [], bookings: [], customers: [], vhc: [] };
let currentView = 'dashboard';
let invoiceItems = [];
let editingId = null;
let editTarget = null;
let currentVHC = {};
let isSidebarCollapsed = false;
let loanTargetId = null;
let editingFleetId = null;
let editingBookingId = null;
let currentPrintInvoiceId = null;
let invoiceListLimit = 50; // pagination limit for invoice history

// Command palette state and commands. The palette allows quick access to
// common actions (e.g., navigating between views) via a Ctrl/⌘+K
// shortcut. When open, users can type to filter available commands
// and press Enter to execute.
let cmdPaletteOpen = false;
let cmdSelectedIndex = 0;
let cmdCommands = [];

// Workshop view mode: 'list' shows bookings in a simple list, 'timeline'
// groups bookings by date for a chronological view.
let workshopViewMode = 'list';

// Chart instances for dashboard analytics. Chart.js will write into
// these references; if not null they should be destroyed before re-
// rendering to prevent memory leaks and duplicated canvases.
let revenueChart = null;
let jobStatusChart = null;

// --- 3. INIT ---
function appInit() {
  lucide.createIcons();
  setInterval(updateClock, 1000);
  updateClock();

  try {
    if (typeof firebase !== 'undefined') {
      firebase.initializeApp(FB_CONFIG);
      db = firebase.firestore();
      startSync();
    } else {
      console.warn("Firebase SDK not found");
      goOffline();
    }
  } catch (e) {
    console.error("Firebase Error", e);
    goOffline();
  }

  renderMenu();
  renderView('dashboard');

  // Initialise the command palette once (Ctrl+K / Cmd+K overlay). This
  // ensures that the global keyboard shortcuts are active and the
  // palette is ready when the user presses the hotkey. Without
  // initialisation here, the command palette functions will not be
  // registered and the overlay will never appear.
  initCommandPaletteOnce();
}

// --- 4. NAVIGATION & SIDEBAR ---
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  isSidebarCollapsed = !isSidebarCollapsed;

  if (isSidebarCollapsed) {
    sb.classList.add('collapsed');
  } else {
    sb.classList.remove('collapsed');
  }

  setTimeout(() => lucide.createIcons(), 300);
}

function renderMenu() {
  const menu = document.getElementById('nav-menu');
  const items = [
    { id: 'dashboard', icon: 'layout-dashboard', label: 'Dashboard' },
    { id: 'workshop', icon: 'wrench', label: 'Workshop' },
    { id: 'vhc_list', icon: 'clipboard-check', label: 'Health Checks' },
    { id: 'create', icon: 'plus-circle', label: 'New Invoice', action: 'startNewInvoice' },
    { id: 'invoices', icon: 'file-text', label: 'History' },
    { id: 'fleet', icon: 'car', label: 'Fleet' },
    { id: 'customers', icon: 'users', label: 'Customers' }
  ];

  menu.innerHTML = items.map(i => `
<div
  class="nav-item ${currentView === i.id ? 'active' : ''}"
  onclick="${i.action ? i.action + '()' : `nav('${i.id}')`}"
  title="${i.label}"
>
  <i data-lucide="${i.icon}"></i>
  <span class="nav-text">${i.label}</span>
</div>
`).join('');

  lucide.createIcons();
}

window.nav = function (view) {
  currentView = view;
  renderMenu();
  const titleEl = document.getElementById('view-title');
  if (titleEl) {
    titleEl.innerText = view.replace('_', ' ').toUpperCase();
  }

  if (view !== 'create') {
    editingId = null;
    editTarget = null;
  }

  renderView(view);
};

function renderView(view) {
  const content = document.getElementById('content');
  if (!content) return;
  content.innerHTML = '';

  if (view === 'dashboard') renderDashboard(content);
  if (view === 'fleet') renderFleet(content);
  if (view === 'workshop') renderWorkshop(content);
  if (view === 'invoices') renderInvoices(content);
  if (view === 'create') renderCreateInvoice(content);
  if (view === 'customers') renderCustomers(content);
  if (view === 'vhc_list') renderVHCList(content);
  if (view === 'vhc_create') renderVHCCreator(content);
  if (view === 'settings') renderSettings(content);

  lucide.createIcons();
}

// --- 5. DATA SYNC ---
function startSync() {
  if (!db) return;

  // Clear any existing Firestore listeners to avoid duplicates
  unsubscribers.forEach(fn => typeof fn === 'function' && fn());
  unsubscribers = [];

  const cols = ['invoices', 'fleet', 'bookings', 'customers', 'vhc'];

  cols.forEach(c => {
    const unsub = db.collection(c)
      .orderBy('createdAt', 'desc')
      .onSnapshot(snap => {
        DATA[c] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        goOnline();

        if (
          currentView === c ||
          currentView === 'dashboard' ||
          currentView === 'workshop' ||
          currentView === 'vhc_list' ||
          currentView === 'fleet'
        ) {
          renderView(currentView);
        }
      }, err => {
        console.error(err);
        goOffline();
      });

    unsubscribers.push(unsub);
  });
}

function goOnline() {
  offline = false;
  const status = document.getElementById('status');
  if (status) {
    status.innerHTML = `
<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
<span class="text-emerald-400 font-bold">ONLINE</span>
`;
  }
}

function goOffline() {
  offline = true;
  const status = document.getElementById('status');
  if (status) {
    status.innerHTML = `
<span class="w-2 h-2 rounded-full bg-red-500"></span>
<span class="text-red-500 font-bold">OFFLINE</span>
`;
  }
  try {
    const l = localStorage.getItem('mh_db_v29');
    if (l) DATA = JSON.parse(l);
  } catch (e) { }

  // Stop Firestore listeners to avoid duplicate subscriptions
  if (Array.isArray(unsubscribers)) {
    unsubscribers.forEach(fn => typeof fn === 'function' && fn());
    unsubscribers = [];
  }
}

function saveData(coll, item) {
  const id = item.id || crypto.randomUUID();
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    ...item,
    id,
    createdAt: item.createdAt || new Date().toISOString()
  };

  const idx = DATA[coll].findIndex(x => x.id === id);
  if (idx > -1) DATA[coll][idx] = payload;
  else DATA[coll].unshift(payload);

  localStorage.setItem('mh_db_v29', JSON.stringify(DATA));

  if (!offline && db) {
    db.collection(coll).doc(id).set(payload, { merge: true }).catch(e => alert(e.message));
  }

  renderView(currentView);
}

function deleteData(coll, id) {
  if (!confirm("Delete?")) return;
  DATA[coll] = DATA[coll].filter(x => x.id !== id);
  localStorage.setItem('mh_db_v29', JSON.stringify(DATA));
  if (!offline && db) db.collection(coll).doc(id).delete();
  renderView(currentView);
}

// --- 6. RENDERERS: DASHBOARD & SETTINGS ---
function renderDashboard(target) {
  const rev = DATA.invoices
    .filter(i => i.type !== 'Quote')
    .reduce((a, b) => a + (Number(b.total) || 0), 0);

  const loanCars = DATA.fleet.filter(f => f.status === 'On Loan').length;

  // Build the summary cards for revenue, jobs, workshop bookings and loaned vehicles.
  let html = `
<div class="grid grid-cols-1 md:grid-cols-4 gap-6">
  <div class="bg-slate-800 p-6 rounded-xl border border-white/10">
    <p class="text-xs text-cyber font-bold tracking-widest">REVENUE</p>
    <h3 class="text-3xl font-bold mt-1">£${rev.toLocaleString(undefined, { minimumFractionDigits: 2 })}</h3>
  </div>
  <div class="bg-slate-800 p-6 rounded-xl border border-white/10">
    <p class="text-xs text-purple-400 font-bold tracking-widest">JOBS</p>
    <h3 class="text-3xl font-bold mt-1">${DATA.invoices.length}</h3>
  </div>
  <div class="bg-slate-800 p-6 rounded-xl border border-white/10">
    <p class="text-xs text-amber-400 font-bold tracking-widest">WORKSHOP</p>
    <h3 class="text-3xl font-bold mt-1">${DATA.bookings.length}</h3>
  </div>
  <div class="bg-slate-800 p-6 rounded-xl border border-white/10">
    <p class="text-xs text-blue-400 font-bold tracking-widest">ON LOAN</p>
    <h3 class="text-3xl font-bold mt-1">${loanCars}</h3>
  </div>
</div>
`;
  // Append analytics charts containers for revenue and job status. These canvases
  // will be populated by Chart.js in renderCharts().
  html += `
  <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
    <div class="bg-slate-800 p-6 rounded-xl border border-white/10">
      <p class="text-xs text-cyan-400 font-bold tracking-widest">REVENUE ANALYTICS</p>
      <canvas id="revenueChart" height="200"></canvas>
    </div>
    <div class="bg-slate-800 p-6 rounded-xl border border-white/10">
      <p class="text-xs text-cyan-400 font-bold tracking-widest">JOB STATUS</p>
      <canvas id="jobStatusChart" height="200"></canvas>
    </div>
  </div>
  `;
  // Inject built HTML into the target element.
  target.innerHTML = html;
  // After inserting canvases, render charts based on current data.
  renderCharts();
}

function renderSettings(target) {
  target.innerHTML = `
<div class="max-w-2xl mx-auto bg-slate-800 border border-white/10 rounded-xl p-8">
  <h3 class="text-xl font-bold text-white mb-6">DATA MANAGEMENT</h3>
  <div class="space-y-4">
    <div class="p-4 bg-black/20 rounded-lg flex justify-between items-center border border-white/5">
      <div>
        <h4 class="font-bold text-cyber">BACKUP DATA</h4>
        <p class="text-xs text-slate-400">Download a full backup of all system data.</p>
      </div>
      <button onclick="downloadBackup()" class="btn btn-primary">DOWNLOAD</button>
    </div>
    <div class="p-4 bg-black/20 rounded-lg flex justify-between items-center border border-white/5">
      <div>
        <h4 class="font-bold text-purple-400">RESTORE DATA</h4>
        <p class="text-xs text-slate-400">Upload a previously saved backup file.</p>
      </div>
      <label class="btn btn-secondary">
        <input type="file" class="hidden" onchange="restoreBackup(this)">UPLOAD
      </label>
    </div>
    <div class="p-4 bg-red-900/10 rounded-lg flex justify-between items-center border border-red-500/20 mt-8">
      <div>
        <h4 class="font-bold text-red-400">FACTORY RESET</h4>
        <p class="text-xs text-slate-400">Wipe all local data. (Cannot be undone)</p>
      </div>
      <button onclick="hardReset()" class="btn btn-danger">RESET</button>
    </div>
    <div class="mt-8 pt-4 border-t border-white/10">
      <button onclick="toggleOffline()" class="btn w-full bg-slate-700 text-white">
        ${offline ? 'GO ONLINE' : 'GO OFFLINE'}
      </button>
    </div>
  </div>
</div>
`;
}

// --- BACKUP/RESTORE LOGIC ---
// Push restored backup into Firestore so cloud matches local data.
async function applyBackupToFirestore(backup) {
  if (!db || offline) return;

  const collections = ['invoices', 'fleet', 'bookings', 'customers', 'vhc'];

  for (const coll of collections) {
    const arr = Array.isArray(backup[coll]) ? backup[coll] : [];

    for (const rawItem of arr) {
      const id = rawItem.id || crypto.randomUUID();
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        ...rawItem,
        id,
        createdAt: rawItem.createdAt || new Date().toISOString()
      };

      await db.collection(coll).doc(id).set(payload, { merge: true });
    }
  }
}

function downloadBackup() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(DATA));
  const dlAnchorElem = document.createElement('a');
  dlAnchorElem.setAttribute("href", dataStr);
  dlAnchorElem.setAttribute("download", "motorhouse_backup_" + new Date().toISOString().slice(0, 10) + ".json");
  document.body.appendChild(dlAnchorElem);
  dlAnchorElem.click();
  dlAnchorElem.remove();
}

async function restoreBackup(input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const backup = JSON.parse(e.target.result);

      if (!backup || typeof backup !== 'object') {
        alert("Invalid backup file.");
        return;
      }

      // Enhanced confirmation message explaining merge behaviour
      const confirmMsg = (!offline && db)
        ? "This will overwrite your current local data and merge changes into the cloud. Note: records present in the cloud but not in this backup will remain. Continue?"
        : "This will overwrite your current local data (cloud will NOT be updated because you are offline). Continue?";

      if (!confirm(confirmMsg)) return;

      // Apply locally
      DATA = backup;
      localStorage.setItem('mh_db_v29', JSON.stringify(DATA));

      // Push to Firestore if online
      if (!offline && db) {
        await applyBackupToFirestore(backup);
      }

      alert("Restored successfully. The page will reload.");
      location.reload();
    } catch (err) {
      console.error(err);
      alert("Invalid backup file.");
    }
  };
  reader.readAsText(file);
}

function hardReset() {
  if (confirm("WARNING: This will wipe all data from this device. Are you sure?")) {
    localStorage.removeItem('mh_db_v29');
    location.reload();
  }
}

// --- Invoice number helpers ---
// Local fallback invoice number generator. Produces INV-YYYY-XXXX sequences using localStorage.
function generateInvoiceNumberLocal() {
  const today = new Date();
  const year = today.getFullYear();
  const key = 'mh_inv_counter_' + year;
  let counter = Number(localStorage.getItem(key) || '0');
  counter += 1;
  localStorage.setItem(key, String(counter));
  const padded = String(counter).padStart(4, '0');
  return `INV-${year}-${padded}`;
}

// Retrieve the next invoice number using a Firestore transaction to avoid
// collisions across multiple devices. Returns null if the transaction
// fails or Firestore is not available.
async function getNextInvoiceNumberFromCloud() {
  if (!db) return null;
  const year = new Date().getFullYear();
  const docRef = db.collection('meta').doc(`invCounter_${year}`);
  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      let current = 0;
      if (snap.exists && typeof snap.data().value === 'number') {
        current = snap.data().value;
      }
      const next = current + 1;
      tx.set(docRef, { value: next }, { merge: true });
      return next;
    });
    const padded = String(result).padStart(4, '0');
    return `INV-${year}-${padded}`;
  } catch (err) {
    console.error('Invoice counter transaction failed', err);
    return null;
  }
}

// --- COURTESY CAR LOAN LOGIC ---
window.openLoanModal = function (id) {
  loanTargetId = id;
  document.getElementById('loan-modal').classList.remove('hidden');
  const now = new Date();
  document.getElementById('loan_date').value = now.toISOString().split('T')[0];
  document.getElementById('loan_time').value = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('loan_customer').value = '';
  document.getElementById('loan_customer').focus();
};

window.confirmLoan = function () {
  const car = DATA.fleet.find(c => c.id === loanTargetId);
  const customer = document.getElementById('loan_customer').value;
  const date = document.getElementById('loan_date').value;
  const time = document.getElementById('loan_time').value;
  if (!customer) return alert("Customer Name Required");

  const updatedCar = {
    ...car,
    status: 'On Loan',
    loanDetails: { customer, dateOut: date, timeOut: time }
  };

  saveData('fleet', updatedCar);
  document.getElementById('loan-modal').classList.add('hidden');
};

window.returnCar = function (id) {
  if (!confirm("Confirm vehicle return?")) return;
  const car = DATA.fleet.find(c => c.id === id);
  const updatedCar = { ...car, status: 'Available', loanDetails: null };
  saveData('fleet', updatedCar);
};

// --- RENDERERS: FLEET ---
function renderFleet(target) {
  target.innerHTML = `
<div class="flex justify-between mb-6">
  <button onclick="openVehicleModal()" class="btn btn-primary">
    <i data-lucide="plus"></i> Add Vehicle
  </button>
  <label class="btn bg-slate-700 hover:bg-slate-600">
    <i data-lucide="upload"></i> CSV Import
    <input type="file" class="hidden" onchange="handleCSV(this)">
  </label>
</div>
<input
  onkeyup="filterFleet(this.value)"
  placeholder="Search Make, Model, VRM..."
  class="mb-6 p-4 bg-black/40 border border-white/10 rounded-xl text-white w-full"
/>
<div id="fleet-list" class="grid grid-cols-1 md:grid-cols-3 gap-6"></div>
`;
  renderFleetGrid();
}

function renderFleetGrid(search = '') {
  const list = document.getElementById('fleet-list');
  if (!list) return;
  const s = search.toLowerCase();

  const items = DATA.fleet.filter(c =>
    (c.make + ' ' + (c.model || '')).toLowerCase().includes(s) ||
    (c.vrm || '').includes(s.toUpperCase())
  );

  list.innerHTML = items.map(c => `
<div class="bg-slate-800 border border-white/10 p-5 rounded-xl hover:border-cyber transition relative group">
  <div class="flex justify-between items-start mb-2">
    <div>
      <h3 class="font-bold text-lg">${c.make || '-'}</h3>
      <p class="text-slate-400 text-sm">${c.model || ''}</p>
    </div>
    <span class="bg-yellow-400 text-black font-mono font-bold px-2 py-1 rounded text-sm">
      ${c.vrm || ''}
    </span>
  </div>
  <div class="text-sm text-slate-500 mb-2">
    ${(c.mileage || '0')} miles •
    <span class="text-cyber font-bold">£${c.price || '0'}</span>
  </div>
  ${
    c.status === 'On Loan'
      ? `<div class="bg-red-500/10 text-red-400 border border-red-500/20 p-2 rounded text-xs text-center font-bold mb-2">
          ON LOAN: ${c.loanDetails?.customer || ''}
        </div>`
      : `<div class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 p-2 rounded text-xs text-center font-bold mb-2">
          AVAILABLE
        </div>`
  }
  <div class="flex gap-2 justify-end">
    ${
      c.status === 'On Loan'
        ? `<button onclick="returnCar('${c.id}')" class="btn btn-warning text-xs">RETURN</button>`
        : `<button onclick="openLoanModal('${c.id}')" class="btn btn-secondary text-xs">LOAN</button>`
    }
    <button onclick="sellVehicle('${c.id}')" class="p-2 bg-emerald-500/20 text-emerald-400 rounded" title="Invoice">
      <i data-lucide="file-text" width="16"></i>
    </button>
    <button onclick="openVehicleModal('${c.id}')" class="p-2 bg-blue-500/20 text-blue-400 rounded">
      <i data-lucide="pencil" width="16"></i>
    </button>
    <button onclick="deleteData('fleet','${c.id}')" class="p-2 bg-red-500/20 text-red-400 rounded">
      <i data-lucide="trash-2" width="16"></i>
    </button>
  </div>
</div>
`).join('');

  lucide.createIcons();
}

window.filterFleet = renderFleetGrid;

// ADD / EDIT VEHICLE MODAL
window.openVehicleModal = (id = null) => {
  editingFleetId = id || null;
  const existing = id ? DATA.fleet.find(v => v.id === id) : null;

  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-content').innerHTML = `
<h2 class="text-xl font-bold mb-4 text-white">
  ${id ? 'EDIT VEHICLE' : 'ADD VEHICLE'}
</h2>
<div class="space-y-4">
  <input id="m_make" placeholder="Make" value="${existing?.make || ''}">
  <input id="m_model" placeholder="Model" value="${existing?.model || ''}">
  <input id="m_vrm" placeholder="VRM" class="uppercase" value="${existing?.vrm || ''}">
  <input id="m_mile" placeholder="Mileage" value="${existing?.mileage || ''}">
  <input id="m_price" placeholder="Price" value="${existing?.price || ''}">
  <button onclick="saveVehicle()" class="btn btn-primary w-full justify-center">SAVE</button>
</div>
`;
};

window.saveVehicle = () => {
  const existing = editingFleetId ? DATA.fleet.find(v => v.id === editingFleetId) : null;

  saveData('fleet', {
    id: existing?.id,
    make: document.getElementById('m_make').value,
    model: document.getElementById('m_model').value,
    vrm: document.getElementById('m_vrm').value.toUpperCase(),
    mileage: document.getElementById('m_mile').value,
    price: document.getElementById('m_price').value,
    status: existing?.status || 'Available',
    loanDetails: existing?.loanDetails || null
  });

  editingFleetId = null;
  closeModal();
};

window.editVehicle = openVehicleModal;

window.sellVehicle = (id) => {
  const c = DATA.fleet.find(x => x.id === id);
  editingId = null;
  editTarget = {
    vrm: c.vrm,
    make: c.make,
    model: c.model,
    mileage: c.mileage,
    items: []
  };
  nav('create');
};

window.handleCSV = (input) => {
  const r = new FileReader();
  r.onload = (e) => {
    const l = e.target.result.split('\n');
    let c = 0;
    l.forEach(x => {
      const cols = x.split(',');
      if (cols.length > 2) {
        const vrm = (cols[2] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (vrm.length > 2) {
          saveData('fleet', {
            make: cols[0],
            model: cols[1],
            vrm,
            mileage: cols[4],
            price: cols[5]
          });
          c++;
        }
      }
    });
    alert('Imported ' + c);
    nav('fleet');
  };
  r.readAsText(input.files[0]);
};

// --- RENDERERS: WORKSHOP / BOOKINGS ---
function renderWorkshop(target) {
  // Build a header with booking button and view mode toggles
  target.innerHTML = `
    <div class="flex justify-between items-center mb-6">
      <button onclick="openBookingModal()" class="btn btn-primary">
        <i data-lucide="plus"></i> Book In Vehicle
      </button>
      <div class="flex gap-2">
        <button onclick="setWorkshopViewMode('list')" class="btn ${workshopViewMode === 'list' ? 'btn-secondary' : 'bg-slate-700 text-white'}">List</button>
        <button onclick="setWorkshopViewMode('timeline')" class="btn ${workshopViewMode === 'timeline' ? 'btn-secondary' : 'bg-slate-700 text-white'}">Timeline</button>
      </div>
    </div>
    <div id="workshop-container"></div>
  `;

  // Render the appropriate view (list or timeline) into the container
  const container = document.getElementById('workshop-container');
  if (workshopViewMode === 'timeline') {
    renderWorkshopTimeline(container);
  } else {
    renderWorkshopList(container);
  }

  // Refresh icons for the new dynamic content
  lucide.createIcons();
}

// ADD / EDIT BOOKING MODAL
window.openBookingModal = (id = null) => {
  editingBookingId = id || null;
  const existing = id ? DATA.bookings.find(b => b.id === id) : null;

  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-content').innerHTML = `
<h2 class="text-white font-bold mb-4">${id ? 'EDIT BOOKING' : 'BOOK IN'}</h2>
<input id="b_vrm" placeholder="VRM" class="mb-2 uppercase" value="${existing?.vrm || ''}">
<input id="b_cust" placeholder="Customer" class="mb-2" value="${existing?.customer || ''}">
<input id="b_desc" placeholder="Work description" class="mb-2" value="${existing?.description || ''}">
<input id="b_date" type="date" class="mb-2"
  value="${existing?.date || (existing?.createdAt ? existing.createdAt.split('T')[0] : new Date().toISOString().split('T')[0])}">
<button onclick="saveBook()" class="btn btn-primary w-full">SAVE</button>
`;
};

window.saveBook = () => {
  const existing = editingBookingId ? DATA.bookings.find(b => b.id === editingBookingId) : null;
  const dateValue = document.getElementById('b_date').value || new Date().toISOString().split('T')[0];

  saveData('bookings', {
    id: existing?.id,
    vrm: document.getElementById('b_vrm').value.toUpperCase(),
    customer: document.getElementById('b_cust').value,
    description: document.getElementById('b_desc').value || existing?.description || '',
    date: dateValue,
    status: existing?.status || 'Booked',
    createdAt: existing?.createdAt || new Date().toISOString()
  });

  editingBookingId = null;
  closeModal();
};

window.editBooking = openBookingModal;

window.updateBookingStatus = (id, val) => {
  const b = DATA.bookings.find(x => x.id === id);
  if (b) saveData('bookings', { ...b, status: val });
};

window.invoiceFromBooking = (id) => {
  const b = DATA.bookings.find(x => x.id === id);
  if (!b) return;

  // Try to enrich booking with vehicle details from fleet by VRM
  const stock = DATA.fleet.find(c => c.vrm === b.vrm);

  const make = b.make || stock?.make || '';
  const model = b.model || stock?.model || '';
  const mileage = stock?.mileage || '';

  editingId = null;
  editTarget = {
    customer: b.customer,
    vrm: b.vrm,
    make,
    model,
    mileage,
    items: [
      {
        id: Date.now(),
        desc: b.description,
        qty: 1,
        price: 0
      }
    ]
  };
  nav('create');
};

// --- RENDERERS: INVOICES ---
function renderInvoices(target) {
  // reset pagination when entering view
  invoiceListLimit = 50;

  target.innerHTML = `
<div class="flex gap-2 mb-4">
  <input
    onkeyup="filterInvoices(this.value)"
    placeholder="Search..."
    class="w-full p-3 bg-slate-900 border border-white/10 rounded-lg text-white"
  />
</div>
<div id="inv-list" class="space-y-3"></div>
<div id="inv-more" class="mt-4"></div>
`;
  renderInvoiceList();
}

function renderInvoiceList(search = '') {
  const list = document.getElementById('inv-list');
  const more = document.getElementById('inv-more');
  if (!list) return;
  if (more) more.innerHTML = '';

  const s = (search || '').toLowerCase();

  const items = DATA.invoices.filter(i =>
    (i.customer || '').toLowerCase().includes(s) ||
    (i.vrm || i.details?.vrm || '').includes(s.toUpperCase())
  );

  let visibleItems = items;
  // Only paginate when there is no search text
  if (!s) {
    visibleItems = items.slice(0, invoiceListLimit);
  }

  list.innerHTML = visibleItems.map(inv => {
    const payStatus = inv.paymentStatus || 'Unpaid';
    let payClass =
      'border-amber-300 text-amber-200 bg-amber-500/10';
    if (payStatus === 'Paid') {
      payClass = 'border-emerald-400 text-emerald-200 bg-emerald-500/10';
    } else if (payStatus === 'Overdue') {
      payClass = 'border-red-400 text-red-200 bg-red-500/10';
    }

    return `
<div onclick="openPreview('${inv.id}')" class="bg-slate-800 p-4 rounded-xl flex justify-between items-center border border-white/10 hover:border-cyber cursor-pointer group">
  <div>
    <h4 class="font-bold text-white">${inv.customer}</h4>
    <p class="text-xs text-slate-400 mt-1">
      ${inv.displayId} • ${inv.vrm || inv.details?.vrm || 'NO REG'} • ${inv.date}
    </p>
  </div>
  <div class="flex items-center gap-4">
    <div class="flex flex-col items-end gap-1">
      <span class="font-bold text-cyber text-lg">£${Number(inv.total).toFixed(2)}</span>
      <div class="flex gap-2 items-center">
        <span class="text-[10px] px-2 py-0.5 rounded-full border ${payClass}">
          ${payStatus.toUpperCase()}
        </span>
        <select
          onchange="event.stopPropagation(); updatePaymentStatus('${inv.id}', this.value)"
          class="text-[10px] bg-slate-900 border border-white/20 rounded px-1 py-0.5"
        >
          <option ${payStatus === 'Unpaid' ? 'selected' : ''}>Unpaid</option>
          <option ${payStatus === 'Paid' ? 'selected' : ''}>Paid</option>
          <option ${payStatus === 'Overdue' ? 'selected' : ''}>Overdue</option>
        </select>
      </div>
    </div>
    <div class="flex gap-2">
      <button onclick="event.stopPropagation(); editInv('${inv.id}')" class="text-blue-400 hover:bg-blue-500/20 p-2 rounded">
        <i data-lucide="pencil" width="18"></i>
      </button>
      <button onclick="event.stopPropagation(); deleteData('invoices','${inv.id}')" class="text-red-400 hover:bg-red-500/20 p-2 rounded">
        <i data-lucide="trash-2" width="18"></i>
      </button>
    </div>
  </div>
</div>
`;
  }).join('');

  if (!s && items.length > invoiceListLimit && more) {
    more.innerHTML = `
<button onclick="loadMoreInvoices()" class="btn btn-secondary w-full">
  LOAD MORE
</button>
`;
  }

  lucide.createIcons();
}

window.filterInvoices = renderInvoiceList;

window.loadMoreInvoices = () => {
  invoiceListLimit += 50;
  renderInvoiceList('');
};

// CREATE / EDIT INVOICE
function renderCreateInvoice(target) {
  const d = editTarget || { customer: '', items: [] };
  const existingDateStr = d.date || d.serviceDate || '';
  const dateValue = existingDateStr
    ? (existingDateStr.includes('/')
        ? existingDateStr.split('/').reverse().join('-')
        : existingDateStr)
    : new Date().toISOString().split('T')[0];

  // Ensure we always have at least one line item row
  const hasItemsArray = Array.isArray(d.items) && d.items.length > 0;
  const hasDetailsItemsArray =
    d.details && Array.isArray(d.details.items) && d.details.items.length > 0;

  invoiceItems = hasItemsArray
    ? d.items
    : hasDetailsItemsArray
      ? d.details.items
      : [
          {
            id: Date.now(),
            desc: '',
            qty: 1,
            price: 0
          }
        ];

  target.innerHTML = `
<div class="max-w-6xl mx-auto space-y-6">
  <div class="flex justify-between items-center">
    <h2 class="text-2xl font-bold text-white">${editingId ? 'EDIT' : 'NEW'} INVOICE</h2>
    <button onclick="nav('invoices')" class="text-red-400 hover:text-white">Cancel</button>
  </div>

  <div class="grid lg:grid-cols-2 gap-6">
    <div class="bg-slate-800 p-6 rounded-xl border border-white/10">
      <h3 class="text-cyber font-bold mb-4">VEHICLE</h3>
      <div class="flex gap-2 mb-4">
        <input id="inv_vrm" value="${d.vrm || ''}" class="uppercase font-mono text-lg" placeholder="ENTER VRM">
        <button onclick="lookupVRM()" class="bg-cyber/20 text-cyber px-4 rounded hover:bg-cyber/30">
          <i data-lucide="search"></i>
        </button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <input id="inv_make" value="${d.vehicleMake || d.make || ''}" placeholder="Make">
        <input id="inv_model" value="${d.vehicleModel || d.model || ''}" placeholder="Model">
        <input id="inv_mileage" value="${d.mileage || (d.details ? d.details.mileage : '')}" placeholder="Mileage">
        <input id="inv_date" type="date" value="${dateValue}">
      </div>
    </div>

    <div class="bg-slate-800 p-6 rounded-xl border border-white/10">
      <h3 class="text-purple-400 font-bold mb-4">CUSTOMER</h3>
      <div class="space-y-3">
        <input id="inv_cust" value="${d.customer || d.customerName || ''}" placeholder="Name">
        <input id="inv_email" value="${d.email || d.customerEmail || ''}" placeholder="Email">
        <input id="inv_phone" value="${d.phone || d.customerPhone || ''}" placeholder="Phone">
        <input id="inv_addr" value="${d.address || d.customerAddress || ''}" placeholder="Address">
      </div>
    </div>

    <div class="bg-slate-800 p-6 rounded-xl border border-white/10 lg:col-span-2">
      <div class="flex justify-between mb-4">
        <h3 class="font-bold">ITEMS</h3>
        <button onclick="addItemRow()" class="text-cyber font-bold hover:text-white transition">
          + ADD ITEM
        </button>
      </div>
      <div id="inv_items_list" class="space-y-2"></div>
      <div class="mt-8 flex justify-end gap-4">
        <button onclick="saveFinal('Quote')" class="btn btn-warning">QUOTE</button>
        <button onclick="saveFinal('Invoice')" class="btn btn-primary">INVOICE</button>
      </div>
    </div>
  </div>
</div>
`;

  renderItems();
}

window.startNewInvoice = () => {
  editTarget = null;
  editingId = null;
  invoiceItems = [{ id: Date.now(), desc: '', qty: 1, price: 0 }];
  nav('create');
};

window.addItemRow = function () {
  invoiceItems.push({ id: Date.now(), desc: '', qty: 1, price: 0 });
  renderItems();
};

window.renderItems = function () {
  const list = document.getElementById('inv_items_list');
  if (!list) return;

  list.innerHTML = invoiceItems.map(i => `
<div class="grid grid-cols-12 gap-2 items-center">
  <div class="col-span-6">
    <input
      oninput="updateRow(${i.id},'desc',this.value)"
      value="${i.desc || i.description || ''}"
      class="bg-black/30 w-full"
      placeholder="Description"
    >
  </div>
  <div class="col-span-2">
    <input
      type="number"
      min="0"
      step="1"
      oninput="updateRow(${i.id},'qty',this.value)"
      value="${i.qty}"
      class="bg-black/30 w-full text-center"
    >
  </div>
  <div class="col-span-3">
    <input
      type="number"
      min="0"
      step="0.01"
      oninput="updateRow(${i.id},'price',this.value)"
      value="${i.price}"
      class="bg-black/30 w-full"
    >
  </div>
  <div class="col-span-1 text-right">
    <button onclick="deleteRow(${i.id})" class="text-red-400">✕</button>
  </div>
</div>
`).join('');
};

window.updateRow = (id, f, v) => {
  const i = invoiceItems.find(x => x.id === id);
  if (i) i[f] = v;
};

window.deleteRow = (id) => {
  invoiceItems = invoiceItems.filter(x => x.id !== id);
  renderItems();
};

// Save final invoice or quote
window.saveFinal = async function (type) {
  const dateInput = document.getElementById('inv_date').value;
  const customerName = document.getElementById('inv_cust').value.trim();
  const vrmValue = document.getElementById('inv_vrm').value.trim();

  // Basic validation
  const errors = [];
  if (!customerName) errors.push('Customer name is required.');
  if (!dateInput) errors.push('Invoice date is required.');

  // Map and filter valid line items with strong validation
  const validItems = invoiceItems
    .map(it => {
      const desc = (it.desc || it.description || '').trim();
      const qty = Math.max(0, parseInt(it.qty, 10) || 0);
      const price = Math.max(0, parseFloat(it.price) || 0);
      return { id: it.id, desc, qty, price };
    })
    .filter(it => it.desc !== '' && it.qty > 0);

  if (validItems.length === 0) {
    errors.push('Please add at least one line item with a description and quantity greater than 0.');
  }

  if (errors.length) {
    alert('Please correct the following:\n\n- ' + errors.join('\n- '));
    return;
  }

  const totalExVat = validItems.reduce(
    (a, b) => a + (Number(b.qty) * Number(b.price)), 0
  );
  const totalIncVat = totalExVat * 1.2;

  const existingPaymentStatus = editTarget?.paymentStatus || 'Unpaid';

  // Determine invoice number: if editing existing, reuse; otherwise
  // attempt to get a global sequence from Firestore, falling back to local
  let displayId;
  if (editingId) {
    const existingInv = DATA.invoices.find(i => i.id === editingId);
    displayId = existingInv ? existingInv.displayId : await getNextInvoiceNumberFromCloud() || generateInvoiceNumberLocal();
  } else {
    const cloudId = (!offline && db) ? await getNextInvoiceNumberFromCloud() : null;
    displayId = cloudId || generateInvoiceNumberLocal();
  }

  const data = {
    id: editingId,
    vrm: vrmValue,
    make: document.getElementById('inv_make').value,
    model: document.getElementById('inv_model').value,
    customer: customerName,
    date: new Date(dateInput || new Date().toISOString()).toLocaleDateString('en-GB'),
    type: type,
    status: type === 'Quote' ? 'Draft' : 'Pending',
    paymentStatus: existingPaymentStatus,
    items: validItems,
    total: totalIncVat,
    displayId: displayId,
    details: {
      customerEmail: document.getElementById('inv_email').value,
      customerPhone: document.getElementById('inv_phone').value,
      customerAddress: document.getElementById('inv_addr').value,
      mileage: document.getElementById('inv_mileage').value,
      vrm: vrmValue
    }
  };

  // Create new customer record if needed
  if (data.customer) {
    const exists = DATA.customers.find(
      c => c.name.toLowerCase() === data.customer.toLowerCase()
    );
    if (!exists) {
      saveData('customers', {
        name: data.customer,
        email: data.details.customerEmail,
        phone: data.details.customerPhone,
        address: data.details.customerAddress
      });
    }
  }

  await saveData('invoices', data);
  editingId = null;
  nav('invoices');
};

// Update payment status from History list
window.updatePaymentStatus = (id, status) => {
  const inv = DATA.invoices.find(i => i.id === id);
  if (!inv) return;
  saveData('invoices', { ...inv, paymentStatus: status });
};

// -------- Shared function for invoice HTML (preview + print) --------
function buildInvoiceDocHtml(inv) {
  const items = (inv.items || inv.details?.items || []);
  const rowsHtml = items.map(i => `
<tr>
  <td>${i.desc || i.description || ''}</td>
  <td>${i.qty}</td>
  <td>£${Number(i.price).toFixed(2)}</td>
  <td>£${(Number(i.qty) * Number(i.price)).toFixed(2)}</td>
</tr>
`).join('');

  const gross = Number(inv.total || 0);
  const net = Math.round((gross / 1.2) * 100) / 100;
  const vat = Math.round((gross - net) * 100) / 100;

  const addrLine = inv.details?.customerAddress ? '\n' + inv.details.customerAddress : '';
  const contactLine = [
    inv.details?.customerEmail ? 'Email: ' + inv.details.customerEmail : '',
    inv.details?.customerPhone ? 'Tel: ' + inv.details.customerPhone : ''
  ].filter(Boolean).join('\n');

  const vehicleLines = [
    inv.vrm || inv.details?.vrm || 'N/A',
    (inv.make || inv.model) ? (inv.make || '') + ' ' + (inv.model || '') : '',
    inv.details?.mileage ? 'Mileage: ' + inv.details.mileage : ''
  ].filter(Boolean).join('\n');

  const payStatus = inv.paymentStatus || 'Unpaid';
  let chipClass = 'print-chip--unpaid';
  if (payStatus === 'Paid') chipClass = 'print-chip--paid';
  else if (payStatus === 'Overdue') chipClass = 'print-chip--overdue';

  return `
<div class="print-doc">
  <div class="print-header">
    <div>
      <div class="print-company-name">${COMPANY.name}</div>
      <div class="print-company-line">${COMPANY.address}</div>
      <div class="print-company-line">Tel: ${COMPANY.phone}</div>
      <div class="print-company-line">Email: ${COMPANY.email}</div>
      <div class="print-company-line">VAT No: ${COMPANY.vat}</div>
    </div>
    <div class="print-doc-meta">
      <div class="print-doc-title">${inv.type === 'Quote' ? 'QUOTE' : 'INVOICE'}</div>
      <div class="print-chip ${chipClass}">${payStatus.toUpperCase()}</div>
      <div class="print-doc-meta-line"><span>No.</span><span>${inv.displayId}</span></div>
      <div class="print-doc-meta-line"><span>Date</span><span>${inv.date}</span></div>
      <div class="print-doc-meta-line"><span>Doc status</span><span>${(inv.status || '').toUpperCase() || 'PENDING'}</span></div>
    </div>
  </div>

  <div class="print-section print-section--address">
    <div>
      <div class="print-section-label">Bill To</div>
      <div class="print-section-content">
        ${inv.customer || ''}${addrLine}
      </div>
    </div>
    <div>
      <div class="print-section-label">Contact</div>
      <div class="print-section-content">
        ${contactLine || '—'}
      </div>
    </div>
  </div>

  <div class="print-section">
    <div class="print-section-label">Vehicle</div>
    <div class="print-section-content">
      ${vehicleLines}
    </div>
  </div>

  <div class="print-section">
    <table class="print-table print-table--inv">
      <thead>
        <tr>
          <th>Description</th>
          <th>Qty</th>
          <th>Price</th>
          <th>Line Total</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml || '<tr><td colspan="4">No items.</td></tr>'}
      </tbody>
    </table>
  </div>

  <div class="print-section print-totals">
    <div class="print-totals-box">
      <table class="print-totals-table">
        <tr>
          <td class="print-totals-label">Net amount</td>
          <td class="print-totals-value">£${net.toFixed(2)}</td>
        </tr>
        <tr>
          <td class="print-totals-label">VAT (20%)</td>
          <td class="print-totals-value">£${vat.toFixed(2)}</td>
        </tr>
        <tr>
          <td class="print-totals-label"><strong>Total due</strong></td>
          <td class="print-totals-value"><strong>£${gross.toFixed(2)}</strong></td>
        </tr>
      </table>
    </div>
  </div>

  <div class="print-footer">
    ${TERMS_TEXT}<br>
    Bank: ${COMPANY.bank.name} &nbsp;|&nbsp;
    Sort: ${COMPANY.bank.sort} &nbsp;|&nbsp;
    Acc: ${COMPANY.bank.acc}
  </div>
</div>
`;
}

// LOOKUP / EDIT INVOICE / PREVIEW / PRINT
window.lookupVRM = () => {
  const v = document.getElementById('inv_vrm').value.toUpperCase().replace(/\s/g, '');
  const f = DATA.fleet.find(c => c.vrm === v);
  if (f) {
    document.getElementById('inv_make').value = f.make;
    document.getElementById('inv_model').value = f.model;
    document.getElementById('inv_mileage').value = f.mileage;
  } else {
    alert("Not in fleet");
  }
};

window.openPreview = (id) => {
  const inv = DATA.invoices.find(x => x.id === id);
  if (!inv) return;
  currentPrintInvoiceId = id;

  document.getElementById('modal-overlay').classList.remove('hidden');

  const docHtml = buildInvoiceDocHtml(inv);
  const showMarkPaid = (inv.type !== 'Quote' && (inv.paymentStatus || 'Unpaid') !== 'Paid');

  document.getElementById('modal-content').innerHTML = `
<div class="flex justify-between mb-4">
  <h2 class="text-xl font-bold text-white">PREVIEW</h2>
  <div class="flex gap-2">
    ${showMarkPaid
      ? `<button onclick="markInvoicePaid('${inv.id}')" class="btn btn-secondary">MARK PAID</button>`
      : ''
    }
    <button onclick="printDiv()" class="btn btn-primary">PRINT</button>
    <button onclick="editInv('${inv.id}')" class="btn bg-slate-700">EDIT</button>
  </div>
</div>
<div class="bg-slate-900/70 rounded-xl p-4 max-h-[70vh] overflow-auto">
  <div id="print-view" class="bg-white text-black p-4">
    ${docHtml}
  </div>
</div>
`;
};

// Mark as PAID from preview
window.markInvoicePaid = (id) => {
  const inv = DATA.invoices.find(i => i.id === id);
  if (!inv) return;
  saveData('invoices', { ...inv, paymentStatus: 'Paid' });
  // Re-open preview with updated status
  window.openPreview(id);
};

window.editInv = (id) => {
  const inv = DATA.invoices.find(x => x.id === id);
  closeModal();
  editingId = inv.id;
  editTarget = inv;
  nav('create');
};

// Print invoice (same A4 layout as preview)
window.printDiv = () => {
  if (!currentPrintInvoiceId) return;
  const inv = DATA.invoices.find(x => x.id === currentPrintInvoiceId);
  if (!inv) return;

  document.getElementById('print-area').innerHTML = buildInvoiceDocHtml(inv);
  window.print();
};

// --- VHC ---
window.startVHC = function (bookingId) {
  const booking = DATA.bookings.find(b => b.id === bookingId);

  let vrm = '';
  let customer = '';
  let vehicle = '';

  if (booking) {
    vrm = booking.vrm || '';
    customer = booking.customer || '';

    // Try to enrich with fleet data
    const stock = DATA.fleet.find(c => c.vrm === booking.vrm);

    const make = booking.make || stock?.make || '';
    const model = booking.model || stock?.model || '';

    vehicle = [make, model].filter(Boolean).join(' ');
  }

  currentVHC = {
    id: crypto.randomUUID(),
    bookingId: bookingId || '',
    vrm,
    customer,
    vehicle,
    items: VHC_ITEMS.map(n => ({ name: n, status: '', note: '' })),
    summary: '',
    createdAt: new Date().toISOString()
  };
  nav('vhc_create');
};

window.editVHC = function (id) {
  const v = DATA.vhc.find(x => x.id === id);
  if (v) {
    currentVHC = v;
    nav('vhc_create');
  }
};

window.setVHCStatus = function (idx, s) {
  currentVHC.items[idx].status = s;
  renderVHCCreator(document.getElementById('content'));
};

window.setVHCNote = function (idx, n) {
  currentVHC.items[idx].note = n;
};

window.saveVHC = function () {
  if (!currentVHC.vrm) return alert("Enter VRM");
  saveData('vhc', currentVHC);
  nav('vhc_list');
};

function renderVHCCreator(target) {
  target.innerHTML = `
<div class="max-w-4xl mx-auto bg-slate-800 border border-white/10 rounded-xl p-6 shadow-xl">
  <h2 class="text-2xl font-bold text-white mb-6 font-tech">VHC REPORT EDITOR</h2>
  <div class="grid grid-cols-2 gap-4 mb-6">
    <input value="${currentVHC.vrm || ''}" placeholder="VRM"
      class="bg-black/40 border border-white/10 rounded p-3 text-white uppercase"
      onchange="currentVHC.vrm=this.value">
    <input value="${currentVHC.customer || ''}" placeholder="Customer Name"
      class="bg-black/40 border border-white/10 rounded p-3 text-white"
      onchange="currentVHC.customer=this.value">
  </div>
  <div class="space-y-2">
    ${
      currentVHC.items.map((item, idx) => `
      <div class="grid grid-cols-12 gap-4 items-center bg-white/5 p-3 rounded border border-white/5">
        <div class="col-span-3 text-sm font-bold text-slate-300">${item.name}</div>
        <div class="col-span-4 flex gap-1">
          <div onclick="setVHCStatus(${idx}, 'green')" class="vhc-opt green ${item.status === 'green' ? 'active' : ''}">OK</div>
          <div onclick="setVHCStatus(${idx}, 'amber')" class="vhc-opt amber ${item.status === 'amber' ? 'active' : ''}">ADVISE</div>
          <div onclick="setVHCStatus(${idx}, 'red')" class="vhc-opt red ${item.status === 'red' ? 'active' : ''}">FAIL</div>
        </div>
        <div class="col-span-5">
          <input
            value="${item.note}"
            placeholder="Notes..."
            class="bg-black/30 border border-white/10 text-xs rounded p-2 w-full"
            onchange="setVHCNote(${idx}, this.value)"
          >
        </div>
      </div>
      `).join('')
    }
  </div>
  <div class="mt-4">
    <label class="text-xs text-cyber font-bold">TECHNICIAN'S WRITE UP</label>
    <textarea
      class="w-full bg-black/30 border border-white/10 rounded-lg p-3 text-white text-sm h-24 mt-1"
      onchange="currentVHC.summary=this.value"
    >${currentVHC.summary || ''}</textarea>
  </div>
  <div class="mt-6 flex justify-end gap-4">
    <button onclick="nav('vhc_list')" class="btn btn-danger">Cancel</button>
    <button onclick="saveVHC()" class="btn btn-primary">Save Report</button>
  </div>
</div>
`;
}

function renderVHCList(target) {
  target.innerHTML = `
<div class="flex justify-between mb-4">
  <h2 class="text-2xl font-bold text-white font-tech">HEALTH CHECK REPORTS</h2>
  <button onclick="startVHC()" class="btn btn-primary">NEW VHC</button>
</div>
<div class="space-y-4">
  ${
    DATA.vhc.length === 0
      ? '<div class="text-center text-slate-500 py-8 border border-dashed border-slate-700 rounded-xl">No reports found.</div>'
      : ''
  }
  ${
    DATA.vhc.map(v => `
    <div class="bg-slate-800 p-4 rounded-xl border border-white/10 flex justify-between items-center hover:border-cyber transition">
      <div>
        <h4 class="font-bold text-white text-lg">${v.vrm}</h4>
        <p class="text-sm text-slate-400">
          ${v.customer} • ${new Date(v.createdAt).toLocaleDateString()}
        </p>
      </div>
      <div class="flex gap-2">
        <button onclick="openVHCPreview('${v.id}')" class="btn btn-primary text-xs">VIEW</button>
        <button onclick="editVHC('${v.id}')" class="btn btn-secondary text-xs">EDIT</button>
        <button onclick="deleteData('vhc', '${v.id}')" class="btn btn-danger text-xs">
          <i data-lucide="trash-2" width="14"></i>
        </button>
      </div>
    </div>
    `).join('')
  }
</div>
`;
}

window.openVHCPreview = function (id) {
  const vhc = DATA.vhc.find(v => v.id === id);
  if (!vhc) return;

  const modal = document.getElementById('modal-content');
  document.getElementById('modal-overlay').classList.remove('hidden');

  modal.innerHTML = `
<div class="flex justify-between mb-6 border-b border-white/10 pb-4">
  <h2 class="text-2xl font-bold text-white">VHC REPORT</h2>
  <div class="flex gap-2">
    <button onclick="printVHC('${vhc.id}')" class="btn btn-primary text-xs">PRINT</button>
    <button onclick="editVHC('${vhc.id}'); closeModal();" class="btn btn-secondary text-xs">EDIT</button>
    <button onclick="closeModal()" class="btn btn-danger text-xs">CLOSE</button>
  </div>
</div>
<div class="space-y-4 max-h-[60vh] overflow-y-auto">
  <div class="grid grid-cols-2 gap-4 text-sm text-slate-300">
    <div>
      <p class="text-xs text-slate-400 font-semibold">CUSTOMER</p>
      <p>${vhc.customer}</p>
    </div>
    <div>
      <p class="text-xs text-slate-400 font-semibold">VEHICLE</p>
      <p>${vhc.vrm} ${vhc.vehicle}</p>
    </div>
  </div>
  <div class="space-y-1">
    ${
      vhc.items.map(i => `
      <div class="flex items-center gap-2 p-2 rounded border border-white/5 bg-slate-800">
        <div class="w-32 font-bold text-xs text-white">${i.name}</div>
        <div class="px-2 py-0.5 rounded text-[10px] font-bold uppercase w-20 text-center ${
          i.status === 'green'
            ? 'bg-emerald-900 text-emerald-400'
            : i.status === 'amber'
            ? 'bg-amber-900 text-amber-400'
            : i.status === 'red'
            ? 'bg-red-900 text-red-400'
            : 'bg-slate-700'
        }">
          ${i.status || '-'}
        </div>
        <div class="text-xs text-slate-400 flex-1">${i.note}</div>
      </div>
      `).join('')
    }
  </div>
  <div class="bg-slate-800 p-3 rounded border border-white/10">
    <h4 class="text-xs font-bold text-cyber mb-1">TECHNICIAN'S WRITE UP</h4>
    <p class="text-sm text-slate-300 whitespace-pre-wrap">
      ${vhc.summary || 'None'}
    </p>
  </div>
</div>
`;
};

// VHC print (A4-safe)
window.printVHC = function (id) {
  const v = DATA.vhc.find(x => x.id === id);
  if (!v) return;

  const rowsHtml = v.items.map(i => {
    let label = '';
    let cls = '';
    if (i.status === 'green') { label = 'OK'; cls = 'print-status-ok'; }
    else if (i.status === 'amber') { label = 'ADVISE'; cls = 'print-status-advise'; }
    else if (i.status === 'red') { label = 'FAIL'; cls = 'print-status-fail'; }

    return `
<tr class="${cls}">
  <td>${i.name}</td>
  <td>${label}</td>
  <td>${i.note || ''}</td>
</tr>
`;
  }).join('');

  document.getElementById('print-area').innerHTML = `
<div class="print-doc">
  <div class="print-header">
    <div>
      <div class="print-company-name">${COMPANY.name}</div>
      <div class="print-company-line">${COMPANY.address}</div>
      <div class="print-company-line">Tel: ${COMPANY.phone}</div>
      <div class="print-company-line">Email: ${COMPANY.email}</div>
    </div>
    <div class="print-doc-meta">
      <div class="print-doc-title">VEHICLE HEALTH CHECK</div>
      <div class="print-doc-meta-line"><span>Date</span><span>${new Date(v.createdAt).toLocaleDateString('en-GB')}</span></div>
      <div class="print-doc-meta-line"><span>VRM</span><span>${v.vrm}</span></div>
    </div>
  </div>

  <div class="print-section">
    <div class="print-two-col">
      <div>
        <div class="print-section-label">Customer</div>
        <div class="print-section-content">${v.customer || ''}</div>
      </div>
      <div>
        <div class="print-section-label">Vehicle</div>
        <div class="print-section-content">${v.vehicle || ''}</div>
      </div>
    </div>
  </div>

  <div class="print-section">
    <table class="print-table print-table--vhc">
      <thead>
        <tr>
          <th>Item</th>
          <th>Status</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml || '<tr><td colspan="3">No items recorded.</td></tr>'}
      </tbody>
    </table>
  </div>

  <div class="print-section">
    <div class="print-section-label">Technician's write up</div>
    <div class="print-section-content">${v.summary || 'None'}</div>
  </div>
</div>
`;

  window.print();
};

// --- CUSTOMERS (CLICKABLE CARDS + MODAL) ---
function renderCustomers(target) {
  target.innerHTML = `
<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
  ${
    DATA.customers.map(c => `
    <div
      class="bg-slate-800 p-4 rounded-xl border border-white/10 cursor-pointer hover:border-cyber transition group"
      onclick="openCustomerDetails('${c.id}')"
    >
      <h3 class="font-bold text-white mb-1">${c.name}</h3>
      <p class="text-sm text-cyber">${c.phone || ''}</p>
      <p class="text-xs text-slate-500 truncate">${c.email || ''}</p>
      <button
        onclick="event.stopPropagation(); deleteData('customers','${c.id}')"
        class="text-red-400 text-xs mt-3 opacity-80 hover:opacity-100"
      >
        Remove
      </button>
    </div>
    `).join('')
  }
</div>
`;
}

// Customer details modal
window.openCustomerDetails = (id) => {
  const c = DATA.customers.find(x => x.id === id);
  if (!c) return;

  const modal = document.getElementById('modal-content');
  document.getElementById('modal-overlay').classList.remove('hidden');

  modal.innerHTML = `
<h2 class="text-xl font-bold text-white mb-4">CUSTOMER DETAILS</h2>

<div class="space-y-4 text-sm">
  <div>
    <p class="text-xs text-slate-400 font-semibold">NAME</p>
    <p class="text-base text-white font-semibold">${c.name || ''}</p>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <div>
      <p class="text-xs text-slate-400 font-semibold">PHONE</p>
      <p class="text-sm text-cyber">${c.phone || '-'}</p>
    </div>
    <div>
      <p class="text-xs text-slate-400 font-semibold">EMAIL</p>
      <p class="text-sm break-all">
        ${
          c.email
            ? `<a href="mailto:${c.email}" class="text-sky-400 hover:text-sky-300">${c.email}</a>`
            : '-'
        }
      </p>
    </div>
  </div>

  <div>
    <p class="text-xs text-slate-400 font-semibold">ADDRESS</p>
    <p class="text-sm whitespace-pre-line">${c.address || '-'}</p>
  </div>
</div>

<div class="mt-6 flex justify-end">
  <button onclick="closeModal()" class="btn btn-primary">Close</button>
</div>
`;
};

// --- GLOBAL UTILS ---
function updateClock() {
  const now = new Date();
  const el = document.getElementById('clock');
  if (el) {
    el.innerText = now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }
}

window.toggleOffline = () => {
  offline = !offline;
  if (offline) goOffline(); else startSync();
};

window.closeModal = () => {
  const m = document.getElementById('modal-overlay');
  if (m) m.classList.add('hidden');
};

/* ------------------------------------------------------------------ */
/*                    COMMAND PALETTE & SHORTCUTS                      */
/*
 * The command palette provides a quick search interface for users to
 * jump between major sections of the application or perform common
 * actions. It is opened with Ctrl+K (Windows/Linux) or ⌘+K (macOS)
 * and closed with Esc. Commands are defined in the `cmdCommands`
 * array. Each command has a `name` (displayed text) and an `action`
 * function that executes when the command is chosen.
 */

function setupCommandPalette() {
  // Define available commands. Additional commands can be added here.
  cmdCommands = [
    { name: 'New Invoice', action: () => { startNewInvoice(); } },
    { name: 'Dashboard', action: () => { nav('dashboard'); } },
    { name: 'Fleet', action: () => { nav('fleet'); } },
    { name: 'Workshop', action: () => { nav('workshop'); } },
    { name: 'Health Checks', action: () => { nav('vhc_list'); } },
    { name: 'Invoices', action: () => { nav('invoices'); } },
    { name: 'Customers', action: () => { nav('customers'); } },
    { name: 'Settings', action: () => { nav('settings'); } }
  ];

  // Global keyboard handler for opening/closing the palette.
  document.addEventListener('keydown', (e) => {
    // Open palette with Ctrl+K or ⌘+K
    const isCmdK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';
    if (isCmdK) {
      e.preventDefault();
      toggleCmdPalette();
      return;
    }
    // Close palette with Escape
    if (cmdPaletteOpen && e.key === 'Escape') {
      e.preventDefault();
      toggleCmdPalette(false);
    }
  });

  // Input event handlers will be attached whenever the palette opens.
}

// Open or close the command palette. When opening, reset search and
// selected index; when closing, clean up event listeners.
function toggleCmdPalette(forceState) {
  const pal = document.getElementById('cmd-palette');
  const input = document.getElementById('cmd-input');
  const resultsEl = document.getElementById('cmd-results');
  if (!pal || !input || !resultsEl) return;

  // Determine new state: toggle if forceState is undefined, else set.
  cmdPaletteOpen = (typeof forceState === 'boolean') ? forceState : !cmdPaletteOpen;
  pal.classList.toggle('hidden', !cmdPaletteOpen);
  if (cmdPaletteOpen) {
    // Reset state
    cmdSelectedIndex = 0;
    input.value = '';
    updateCmdResults('');
    input.focus();

    // Attach input listeners only when palette is open to avoid
    // accumulating listeners.
    input.oninput = (e) => {
      updateCmdResults(e.target.value);
    };
    input.onkeydown = (e) => {
      // Navigate results with arrow keys
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (cmdCommandsFiltered.length > 0) {
          cmdSelectedIndex = (cmdSelectedIndex + 1) % cmdCommandsFiltered.length;
          renderCmdResults();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (cmdCommandsFiltered.length > 0) {
          cmdSelectedIndex = (cmdSelectedIndex - 1 + cmdCommandsFiltered.length) % cmdCommandsFiltered.length;
          renderCmdResults();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // Execute selected command
        if (cmdCommandsFiltered && cmdCommandsFiltered[cmdSelectedIndex]) {
          const cmd = cmdCommandsFiltered[cmdSelectedIndex];
          if (typeof cmd.action === 'function') {
            cmd.action();
          }
          // Close palette after running command
          toggleCmdPalette(false);
        }
      }
    };
  } else {
    // Clean up listeners when closing
    input.oninput = null;
    input.onkeydown = null;
  }
}

// Filter commands based on user input and render them. Filtering is
// case-insensitive and matches anywhere in the command name.
let cmdCommandsFiltered = [];
function updateCmdResults(query) {
  const resultsEl = document.getElementById('cmd-results');
  if (!resultsEl) return;
  const q = (query || '').toLowerCase();
  cmdCommandsFiltered = cmdCommands.filter(cmd => cmd.name.toLowerCase().includes(q));
  cmdSelectedIndex = 0;
  renderCmdResults();
}

// Render the list of filtered commands. Highlights the currently
// selected command for keyboard navigation.
function renderCmdResults() {
  const resultsEl = document.getElementById('cmd-results');
  if (!resultsEl) return;
  resultsEl.innerHTML = cmdCommandsFiltered.map((cmd, idx) => {
    const active = idx === cmdSelectedIndex;
    return `
      <div class="p-2 rounded ${active ? 'bg-cyber/20 text-cyber' : 'bg-slate-700/50 text-white'} cursor-pointer"
           onclick="(() => { (${cmd.action.toString()})(); toggleCmdPalette(false); })()"
      >${cmd.name}</div>
    `;
  }).join('');
}

// Initialise the command palette after the DOM has loaded. This must be
// called once from appInit().
function initCommandPaletteOnce() {
  // In case of re-initialisation (hot reload), avoid duplicating listeners
  if (initCommandPaletteOnce.initialised) return;
  initCommandPaletteOnce.initialised = true;
  setupCommandPalette();
}

/* ------------------------------------------------------------------ */
/*                   WORKSHOP TIMELINE VIEW SUPPORT                    */
/*
 * The workshop screen now supports two modes: a simple list of all
 * bookings (default), and a timeline view that groups bookings by
 * date for improved chronological browsing. Use setWorkshopViewMode()
 * to toggle between modes.
 */

function setWorkshopViewMode(mode) {
  if (mode !== 'list' && mode !== 'timeline') return;
  workshopViewMode = mode;
  renderView('workshop');
}

// Render bookings in a simple list (default). This is extracted from
// renderWorkshop to facilitate reuse when toggling between modes.
function renderWorkshopList(container) {
  // Reuse existing renderWorkshop logic: filter and sort bookings,
  // produce HTML similar to the list used previously.
  const items = DATA.bookings.slice().sort((a, b) => new Date(a.date || a.createdAt) - new Date(b.date || b.createdAt));
  if (items.length === 0) {
    container.innerHTML = '<div class="text-center text-slate-500 py-10 border border-dashed border-white/10 rounded">No active jobs</div>';
    return;
  }
  container.innerHTML = items.map(b => {
    let statusStyle = "bg-slate-700 text-slate-300 border-slate-500";
    if (b.status === 'Booked') statusStyle = "bg-red-500/10 text-red-400 border-red-500/50";
    if (b.status === 'In Progress') statusStyle = "bg-amber-500/10 text-amber-400 border-amber-500/50";
    if (b.status === 'Completed') statusStyle = "bg-emerald-500/10 text-emerald-400 border-emerald-500/50";

    const d = b.date || b.createdAt || new Date().toISOString();
    return `
      <div class="bg-slate-800 p-4 rounded-xl border border-white/10 flex flex-col md:flex-row justify-between items-center gap-4 mb-2">
        <div class="flex items-center gap-4 w-full">
          <div class="w-14 h-14 bg-black/30 rounded flex flex-col items-center justify-center font-bold border border-white/5">
            <span class="text-xl">${new Date(d).getDate()}</span>
            <span class="text-[10px] text-slate-400 uppercase">
              ${new Date(d).toLocaleString('default', { month: 'short' })}
            </span>
          </div>
          <div>
            <div class="flex gap-3 items-center">
              <h3 class="font-bold text-white text-lg">
                ${b.vrm} <span class="text-sm font-normal text-slate-400">(${b.make || ''})</span>
              </h3>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${statusStyle}">
                ${b.status}
              </span>
            </div>
            <p class="text-sm text-slate-400">
              ${b.customer} • ${b.description || ''}
            </p>
          </div>
        </div>
        <div class="flex gap-2 items-center mt-2 md:mt-0">
          <button onclick="startVHC('${b.id}')" class="p-2 bg-purple-500/20 text-purple-400 rounded" title="Health Check">
            <i data-lucide="clipboard-check" width="16"></i>
          </button>
          <select onchange="updateBookingStatus('${b.id}', this.value)" class="bg-black border border-white/20 rounded p-2 text-xs text-white">
            <option ${b.status === 'Booked' ? 'selected' : ''}>Booked</option>
            <option ${b.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
            <option ${b.status === 'Completed' ? 'selected' : ''}>Completed</option>
          </select>
          <button onclick="openBookingModal('${b.id}')" class="p-2 bg-blue-500/20 text-blue-400 rounded">
            <i data-lucide="pencil" width="16"></i>
          </button>
          <button onclick="deleteData('bookings','${b.id}')" class="p-2 bg-red-500/20 text-red-400 rounded">
            <i data-lucide="trash-2" width="16"></i>
          </button>
          ${
            b.status === 'Completed'
              ? `<button onclick="invoiceFromBooking('${b.id}')" class="p-2 bg-emerald-500/20 text-emerald-400 rounded" title="Invoice">
                  <i data-lucide="file-check" width="16"></i>
                </button>`
              : ''
          }
        </div>
      </div>
    `;
  }).join('');
}

// Render bookings grouped by date. This timeline view presents a heading
// for each date (YYYY-MM-DD) with its bookings underneath. Bookings are
// sorted within each date by time of creation/order.
function renderWorkshopTimeline(container) {
  if (DATA.bookings.length === 0) {
    container.innerHTML = '<div class="text-center text-slate-500 py-10 border border-dashed border-white/10 rounded">No active jobs</div>';
    return;
  }
  // Group bookings by date string (ISO date). Use reduce to build a map.
  const groups = DATA.bookings.reduce((acc, b) => {
    const d = new Date(b.date || b.createdAt || new Date());
    const key = d.toISOString().split('T')[0];
    if (!acc[key]) acc[key] = [];
    acc[key].push(b);
    return acc;
  }, {});
  // Sort date keys chronologically
  const sortedDates = Object.keys(groups).sort();
  // Build HTML for each date section
  let html = '';
  sortedDates.forEach(dateKey => {
    const bookings = groups[dateKey].sort((a, b) => new Date(a.createdAt || a.date) - new Date(b.createdAt || b.date));
    html += `<div class="mb-8">
      <h4 class="text-lg font-bold text-cyber mb-2">${new Date(dateKey).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</h4>`;
    bookings.forEach(b => {
      let statusStyle = "bg-slate-700 text-slate-300 border-slate-500";
      if (b.status === 'Booked') statusStyle = "bg-red-500/10 text-red-400 border-red-500/50";
      if (b.status === 'In Progress') statusStyle = "bg-amber-500/10 text-amber-400 border-amber-500/50";
      if (b.status === 'Completed') statusStyle = "bg-emerald-500/10 text-emerald-400 border-emerald-500/50";
      html += `<div class="bg-slate-800 p-4 rounded-xl border border-white/10 flex flex-col md:flex-row justify-between items-center gap-4 mb-2">
        <div class="flex items-center gap-4 w-full">
          <div class="w-14 h-14 bg-black/30 rounded flex flex-col items-center justify-center font-bold border border-white/5">
            <span class="text-xl">${new Date(b.date || b.createdAt).getDate()}</span>
            <span class="text-[10px] text-slate-400 uppercase">
              ${new Date(b.date || b.createdAt).toLocaleString('default', { month: 'short' })}
            </span>
          </div>
          <div>
            <div class="flex gap-3 items-center">
              <h3 class="font-bold text-white text-lg">
                ${b.vrm} <span class="text-sm font-normal text-slate-400">(${b.make || ''})</span>
              </h3>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${statusStyle}">
                ${b.status}
              </span>
            </div>
            <p class="text-sm text-slate-400">
              ${b.customer} • ${b.description || ''}
            </p>
          </div>
        </div>
        <div class="flex gap-2 items-center mt-2 md:mt-0">
          <button onclick="startVHC('${b.id}')" class="p-2 bg-purple-500/20 text-purple-400 rounded" title="Health Check">
            <i data-lucide="clipboard-check" width="16"></i>
          </button>
          <select onchange="updateBookingStatus('${b.id}', this.value)" class="bg-black border border-white/20 rounded p-2 text-xs text-white">
            <option ${b.status === 'Booked' ? 'selected' : ''}>Booked</option>
            <option ${b.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
            <option ${b.status === 'Completed' ? 'selected' : ''}>Completed</option>
          </select>
          <button onclick="openBookingModal('${b.id}')" class="p-2 bg-blue-500/20 text-blue-400 rounded">
            <i data-lucide="pencil" width="16"></i>
          </button>
          <button onclick="deleteData('bookings','${b.id}')" class="p-2 bg-red-500/20 text-red-400 rounded">
            <i data-lucide="trash-2" width="16"></i>
          </button>
          ${
            b.status === 'Completed'
              ? `<button onclick="invoiceFromBooking('${b.id}')" class="p-2 bg-emerald-500/20 text-emerald-400 rounded" title="Invoice">
                  <i data-lucide="file-check" width="16"></i>
                </button>`
              : ''
          }
        </div>
      </div>`;
    });
    html += '</div>';
  });
  container.innerHTML = html;
}

/* ------------------------------------------------------------------ */
/*                  DASHBOARD ANALYTICS & CHARTS                      */
/*
 * Renders interactive charts on the dashboard using Chart.js. Charts
 * visualise monthly revenue over the last 12 months and the count of
 * workshop jobs by status. The average invoice value is displayed as
 * a separate text element. Global chart instances are stored so
 * existing charts can be destroyed before re-rendering.
 */

function renderCharts() {
  // Ensure Chart.js is available
  if (typeof Chart === 'undefined') return;
  // Destroy existing charts if they exist to prevent duplicate canvases
  if (revenueChart) {
    revenueChart.destroy();
    revenueChart = null;
  }
  if (jobStatusChart) {
    jobStatusChart.destroy();
    jobStatusChart = null;
  }
  // Compute revenue per month for the last 12 months
  const now = new Date();
  const labels = [];
  const revenueData = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    labels.push(d.toLocaleString('default', { month: 'short', year: 'numeric' }));
    // Sum totals for invoices in this month (exclude quotes)
    const sum = DATA.invoices.filter(inv => {
      if (inv.type === 'Quote') return false;
      const parts = (inv.date || '').split('/'); // DD/MM/YYYY
      if (parts.length === 3) {
        const invMonth = parseInt(parts[1], 10);
        const invYear = parseInt(parts[2], 10);
        return invYear === d.getFullYear() && invMonth === (d.getMonth() + 1);
      }
      return false;
    }).reduce((a, b) => a + Number(b.total || 0), 0);
    revenueData.push(sum);
  }
  // Compute job status counts
  const statusCounts = { Booked: 0, 'In Progress': 0, Completed: 0 };
  DATA.bookings.forEach(b => {
    if (statusCounts[b.status] !== undefined) {
      statusCounts[b.status]++;
    }
  });
  // Prepare charts
  const revCtx = document.getElementById('revenueChart');
  if (revCtx) {
    revenueChart = new Chart(revCtx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Revenue (£)',
          data: revenueData,
          // colors are automatically assigned by Chart.js; avoid specifying fixed colours
          borderWidth: 1
        }]
      },
      options: {
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } }
      }
    });
  }
  const jobCtx = document.getElementById('jobStatusChart');
  if (jobCtx) {
    jobStatusChart = new Chart(jobCtx, {
      type: 'pie',
      data: {
        labels: ['Booked', 'In Progress', 'Completed'],
        datasets: [{
          label: 'Jobs',
          data: [statusCounts.Booked, statusCounts['In Progress'], statusCounts.Completed]
        }]
      },
      options: {
        plugins: { legend: { position: 'bottom' } }
      }
    });
  }
}

/* ------------------------------------------------------------------ */