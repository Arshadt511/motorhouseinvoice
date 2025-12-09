
// --- 1. CONFIGURATION ---
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
let invoiceListLimit = 50;

// --- 3. INIT ---
function appInit() {
if (window.lucide) lucide.createIcons();
setInterval(updateClock, 1000);
updateClock();
renderMenu();
renderView('dashboard');
}

// --- 4. NAV ---
function renderMenu() {
const menu = document.getElementById('nav-menu');
const items = [
{ id: 'dashboard', label: 'Dashboard' },
{ id: 'workshop', label: 'Workshop' },
{ id: 'vhc_list', label: 'Health Checks' },
{ id: 'create', label: 'New Invoice ' },
{ id: 'invoices', label: 'History' },
{ id: 'fleet', label: 'Fleet' },
{ id: 'customers', label: 'Customers' }
];
menu.innerHTML = items.map(i => `
<div class="nav-item" onclick="nav('${i.id}')">
<span class="nav-text">${i.label}</span>
</div>
`).join('');
}

window.nav = function (view) {
currentView = view;
renderMenu();
document.getElementById('view-title').innerText = view.toUpperCase();
renderView(view);
};

function renderView(view) {
const content = document.getElementById('content');
content.innerHTML = '<h1>'+view+' Loaded ✅</h1>';
}

function updateClock() {
const now = new Date();
const el = document.getElementById('clock');
if (el) el.innerText = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

window.onerror = function (msg, src, line) {
alert("SYSTEM ERROR:\n" + msg + "\nLine: " + line);
};
