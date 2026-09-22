/**
 * SpesenTracker PWA - Core Logic
 * Basiswährung: EUR
 * Features: OCR, Währungsumrechnung, Zahlungsmittel mit Karten-Endung, lokale Speicherung
 */

const DB_NAME = 'SpesenTrackerDB';
const DB_VERSION = 1;
const STORE_EXPENSES = 'expenses';
const STORE_PAYMENTS = 'paymentMethods';
const STORE_PROJECTS = 'projects';

let db = null;
let currentImageBase64 = null;
let currentRates = { EUR: 1 }; // Cache

// ========== IndexedDB ==========
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_EXPENSES)) {
        const store = database.createObjectStore(STORE_EXPENSES, { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('project', 'project', { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE_PAYMENTS)) {
        database.createObjectStore(STORE_PAYMENTS, { keyPath: 'id', autoIncrement: true });
      }
      if (!database.objectStoreNames.contains(STORE_PROJECTS)) {
        database.createObjectStore(STORE_PROJECTS, { keyPath: 'name' });
      }
    };
  });
}

function dbAdd(storeName, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.add(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(storeName, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ========== Währungskurse ==========
async function fetchRates() {
  try {
    // frankfurter.dev ist der aktuelle Endpoint (unterstützt u.a. SAR, AED)
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR');
    if (!res.ok) throw new Error('Rate fetch failed');
    const data = await res.json();
    currentRates = { EUR: 1 };
    for (const [cur, rate] of Object.entries(data.rates || {})) {
      currentRates[cur] = rate; // 1 EUR = rate CUR
    }
    console.log('Kurse geladen', currentRates);
  } catch (err) {
    console.warn('Kurse konnten nicht geladen werden, verwende Cache/Fallback', err);
    // Fallback (ca. Werte Sept 2026)
    currentRates = {
      EUR: 1, SAR: 4.05, AED: 3.95, CHF: 0.94, USD: 1.08, GBP: 0.85,
      PLN: 4.3, CZK: 25.2, HUF: 395, SEK: 11.4, NOK: 11.6, DKK: 7.46
    };
  }
}

function convertToEUR(amount, currency) {
  if (!amount || isNaN(amount)) return 0;
  if (currency === 'EUR') return Number(amount);
  const rate = currentRates[currency];
  if (!rate) return Number(amount); // Fallback
  // rate = wie viele CUR für 1 EUR → amount CUR / rate = EUR
  return Number((amount / rate).toFixed(2));
}

// ========== OCR Parsing (deutsche Quittungen / Kassenbons) ==========
// Verbesserte Regeln für typische DE-Bons (REWE, Edeka, Tankstellen, Restaurants, Amazon etc.)

function parseGermanAmount(str) {
  if (!str) return null;
  let s = String(str).replace(/\s/g, '');
  // Östliche arabische Ziffern (٠١٢٣...) → westliche
  const eastern = '٠١٢٣٤٥٦٧٨٩';
  const western = '0123456789';
  for (let i = 0; i < 10; i++) {
    s = s.replaceAll(eastern[i], western[i]);
  }
  // Deutsche Schreibweise: 1.234,56 oder 1234,56 oder 12,34
  // Auch englische: 1,234.56
  if (/\d,\d{2}$/.test(s) && !/\.\d{2}$/.test(s)) {
    // Komma als Dezimaltrenner (DE)
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // Punkt als Dezimaltrenner (EN/INT)
    s = s.replace(/,/g, '');
  }
  const num = parseFloat(s);
  return isNaN(num) ? null : num;
}

function parseReceiptText(text) {
  const result = {
    company: null,
    gross: null,
    net: null,
    vat: null,
    date: null,
    currency: null,
    cardEndings: [],
    rawAmounts: [] // Debug
  };

  if (!text) return result;

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // Normalisierter Volltext (Leerzeichen vereinheitlicht, aber Zeilenstruktur behalten für Kontext)
  const full = text.replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n');

  // ---------- 1. Firma / Händler ----------
  // Weniger streng – akzeptiert auch arabische Schrift und gemischte Zeilen
  const ignoreCompany = /^(summe|total|betrag|mwst|ust|netto|brutto|datum|uhrzeit|kasse|bon|beleg|tisch|bedient|kassierer|terminal|trace|auth|aid|vu[- ]?nr|tse|seriennr|steuernr|ust[- ]?id|tel\.?|fax|www\.|http|€|eur|sar|riyals?|amount|vat|tax|invoice|receipt|date|time|cashier)/i;

  // Kandidaten sammeln (erste 12 Zeilen)
  const candidates = [];
  for (const line of lines.slice(0, 12)) {
    const clean = line.replace(/\s{2,}/g, ' ').trim();
    if (clean.length < 2 || clean.length > 80) continue;
    if (/^[\d\s*#xX.•\-_=]+$/.test(clean)) continue;   // nur Symbole/Zahlen
    if (/^\d+[.,]\d{2}/.test(clean)) continue;          // beginnt mit Betrag
    if (/^\d{1,2}[./\-]\d{1,2}/.test(clean)) continue;  // Datum
    if (ignoreCompany.test(clean)) continue;
    // Mindestens ein Buchstabe (lateinisch oder arabisch)
    if (!/[a-zA-ZÄÖÜäöüß\u0600-\u06FF]/.test(clean)) continue;
    candidates.push(clean);
  }

  // Beste Zeile nehmen: möglichst lange, nicht nur Zahlen
  if (candidates.length > 0) {
    // Bevorzuge Zeilen mit arabischen oder lateinischen Buchstaben und mittlerer Länge
    candidates.sort((a, b) => {
      const score = (s) => {
        let sc = s.length;
        if (/[\u0600-\u06FF]/.test(s)) sc += 20; // Arabisch bevorzugen bei saudischen Bons
        if (/[A-Za-z]{3,}/.test(s)) sc += 10;
        return sc;
      };
      return score(b) - score(a);
    });
    result.company = candidates[0];
  }

  // Fallback: erste Zeile, die überhaupt Text enthält
  if (!result.company && lines.length > 0) {
    for (const line of lines.slice(0, 6)) {
      if (/[a-zA-ZÄÖÜäöüß\u0600-\u06FF]{2,}/.test(line)) {
        result.company = line.replace(/\s{2,}/g, ' ').trim().slice(0, 60);
        break;
      }
    }
  }

  // ---------- 2. Datum (DD.MM.YYYY / DD.MM.YY / DD-MM-YYYY) ----------
  const datePatterns = [
    /(\d{1,2})[./-](\d{1,2})[./-](\d{4})/,           // 22.09.2026
    /(\d{1,2})[./-](\d{1,2})[./-](\d{2})(?!\d)/,     // 22.09.26
    /(\d{4})[./-](\d{1,2})[./-](\d{1,2})/            // 2026-09-22 (selten)
  ];
  for (const pat of datePatterns) {
    const m = full.match(pat);
    if (m) {
      let d, mth, y;
      if (m[1].length === 4) { // YYYY-MM-DD
        y = m[1]; mth = m[2]; d = m[3];
      } else {
        d = m[1]; mth = m[2]; y = m[3];
        if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
      }
      const day = d.padStart(2, '0');
      const month = mth.padStart(2, '0');
      // Plausibilität
      if (parseInt(month, 10) >= 1 && parseInt(month, 10) <= 12 &&
          parseInt(day, 10) >= 1 && parseInt(day, 10) <= 31) {
        result.date = `${y}-${month}-${day}`;
        break;
      }
    }
  }

  // ---------- 3. Währung erkennen (aggressiv) ----------
  const currencyRules = [
    { code: 'SAR', re: /\bSAR\b|Saudi\s*Riyals?|\bS\.?\s*R\.?\b|ر\.?\s*س\.?|ريال(?:\s*سعودي)?|Riyal/i },
    { code: 'AED', re: /\bAED\b|Dirhams?|د\.?\s*إ\.?|درهم/i },
    { code: 'EUR', re: /\bEUR\b|€|Euros?/i },
    { code: 'USD', re: /\bUSD\b|US\s*\$|US\s*Dollars?/i },
    { code: 'CHF', re: /\bCHF\b|Fr\.|Franken/i },
    { code: 'GBP', re: /\bGBP\b|£|Pounds?/i },
    { code: 'PLN', re: /\bPLN\b|Złoty|Zloty/i },
    { code: 'CZK', re: /\bCZK\b|Kč/i },
    { code: 'DKK', re: /\bDKK\b/i },
    { code: 'SEK', re: /\bSEK\b/i },
    { code: 'NOK', re: /\bNOK\b/i }
  ];
  for (const rule of currencyRules) {
    if (rule.re.test(full)) {
      result.currency = rule.code;
      break;
    }
  }
  // Fallback: Währung direkt neben Betrag ("125.50 SAR" / "SAR 125.50")
  if (!result.currency) {
    const near = full.match(/(\d+[.,]\d{2})\s*(SAR|SR|AED|EUR|USD|CHF|GBP|€)/i)
              || full.match(/(SAR|SR|AED|EUR|USD|CHF|GBP|€)\s*(\d+[.,]\d{2})/i);
    if (near) {
      let token = (near[2] || near[1] || '').toUpperCase();
      if (token === '€') token = 'EUR';
      if (token === 'SR') token = 'SAR';
      if (['SAR', 'AED', 'EUR', 'USD', 'CHF', 'GBP'].includes(token)) {
        result.currency = token;
      }
    }
  }

  // ---------- 4. Beträge – DE + EN + internationale Formate ----------
  // DE: 1.234,56  |  EN: 1,234.56  |  schlicht: 1234.56 / 12.34 / 12,34
  const amountToken = String.raw`(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})`;

  const amountRegex = new RegExp(amountToken, 'g');
  const amounts = [];
  let am;
  while ((am = amountRegex.exec(full)) !== null) {
    const val = parseGermanAmount(am[1]);
    if (val !== null && val > 0 && val < 500000) amounts.push(val);
  }
  result.rawAmounts = [...new Set(amounts)].sort((a, b) => b - a);

  // Labels: Total / Grand Total / Amount / Summe / SAR / TOTAL …
  const grossPatterns = [
    new RegExp(String.raw`(?:grand\s*total|total\s*amount|amount\s*due|amount\s*paid|net\s*amount|gesamtbetrag|endsumme|summe|gesamt|total|brutto|zu\s*zahlen|zahlbetrag|betrag|payable|إجمالي|المجموع|المبلغ)\s*[:=]?\s*(?:SAR|SR|EUR|USD|AED|CHF|€|\$)?\s*${amountToken}`, 'i'),
    new RegExp(String.raw`(?:SAR|SR|EUR|USD|AED|€|\$)\s*${amountToken}`, 'i'),
    new RegExp(String.raw`${amountToken}\s*(?:SAR|SR|EUR|USD|AED|€|\$|ريال)`, 'i'),
    new RegExp(String.raw`${amountToken}\s*(?:gesamt|summe|total|brutto|amount)`, 'i')
  ];
  for (const pat of grossPatterns) {
    const m = full.match(pat);
    if (m) {
      const val = parseGermanAmount(m[1] || m[2]);
      if (val !== null && val > 0) { result.gross = val; break; }
    }
  }

  // Netto
  const netPatterns = [
    new RegExp(String.raw`(?:nettobetrag|netto|zwischensumme|sub\s*total|subtotal|net\s*total|قبل\s*الضريبة)\s*[:=]?\s*(?:SAR|SR|EUR|€|\$)?\s*${amountToken}`, 'i'),
    new RegExp(String.raw`${amountToken}\s*(?:netto|net|subtotal)`, 'i')
  ];
  for (const pat of netPatterns) {
    const m = full.match(pat);
    if (m) {
      const val = parseGermanAmount(m[1] || m[2]);
      if (val !== null) { result.net = val; break; }
    }
  }

  // MwSt / VAT / Tax (inkl. saudische VAT oft 15%)
  const vatPatterns = [
    new RegExp(String.raw`(?:mwst|ust|umsatzsteuer|mehrwertsteuer|vat|tax|ضريبة|ض\.?\s*ق\.?\s*م)\s*(?:\(?\s*\d{1,2}\s*%?\s*\)?)?\s*[:=]?\s*(?:SAR|SR|EUR|€)?\s*${amountToken}`, 'i'),
    new RegExp(String.raw`${amountToken}\s*(?:mwst|ust|vat|tax|ضريبة)`, 'i'),
    new RegExp(String.raw`(?:vat|tax|mwst)\s+\d{1,2}\s*%\s*[:=]?\s*${amountToken}`, 'i')
  ];
  for (const pat of vatPatterns) {
    const m = full.match(pat);
    if (m) {
      const val = parseGermanAmount(m[1] || m[2]);
      if (val !== null) { result.vat = val; break; }
    }
  }

  // Fallback: größter plausibler Betrag = Brutto
  if (result.gross == null && result.rawAmounts.length) {
    result.gross = result.rawAmounts[0];
  }

  // Netto + MwSt ergänzen
  if (result.gross != null) {
    if (result.net != null && result.vat == null) {
      const calcVat = Number((result.gross - result.net).toFixed(2));
      if (calcVat > 0) result.vat = calcVat;
    } else if (result.vat != null && result.net == null) {
      const calcNet = Number((result.gross - result.vat).toFixed(2));
      if (calcNet > 0) result.net = calcNet;
    } else if (result.net == null && result.vat == null && result.rawAmounts.length >= 2) {
      for (let i = 0; i < result.rawAmounts.length; i++) {
        for (let j = i + 1; j < result.rawAmounts.length; j++) {
          const a = result.rawAmounts[i];
          const b = result.rawAmounts[j];
          if (Math.abs(a + b - result.gross) < 0.05) {
            result.net = Math.min(a, b);
            result.vat = Math.max(a, b);
            break;
          }
        }
        if (result.net != null) break;
      }
    }
  }

  // ---------- 4. Karten-Endungen (****1234, endet auf, PAN, girocard …) ----------
  const endings = new Set();

  // Klassische Maskierungen: ****1234  XXXX1234  ####1234  ** ** 1234
  const maskPatterns = [
    /(?:\*{2,4}|x{2,4}|#{2,4}|•{2,4})\s*(\d{4})\b/gi,
    /(?:\*{2,4}|x{2,4}|#{2,4})\s*(\d{4})/gi,
    /endet\s*(?:auf|mit)?\s*(\d{4})\b/gi,
    /end[e]?t?\s*(?:auf|mit)?\s*(\d{4})\b/gi
  ];
  maskPatterns.forEach(pat => {
    let m;
    while ((m = pat.exec(full)) !== null) {
      if (m[1] && m[1].length === 4) endings.add(m[1]);
    }
  });

  // In der Nähe von Karten-Keywords
  const cardContext = /(?:karte|card|visa|mastercard|master\s*card|amex|american\s*express|girocard|ec[- ]?karte|giro[- ]?card|debit|kreditkarte|pan|zahlungsart)[^\n\d]{0,50}(\d{4})\b/gi;
  let cm;
  while ((cm = cardContext.exec(full)) !== null) {
    if (cm[1]) endings.add(cm[1]);
  }

  // Manche Bons schreiben nur die letzten 4 Ziffern nach "Karte" oder in einer eigenen Zeile
  const shortCardLine = /(?:^|\n)\s*(?:karte|visa|master|giro|ec)[^\d\n]{0,20}(\d{4})\s*(?:\n|$)/gi;
  while ((cm = shortCardLine.exec(text)) !== null) {
    if (cm[1]) endings.add(cm[1]);
  }

  result.cardEndings = [...endings];

  return result;
}

// ========== UI Helpers ==========
function $(id) { return document.getElementById(id); }
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function setToday() {
  const today = new Date().toISOString().slice(0, 10);
  $('date').value = today;
}

async function loadPaymentMethods() {
  const methods = await dbGetAll(STORE_PAYMENTS);
  const select = $('payment-method');
  select.innerHTML = '<option value="">– bitte wählen –</option>';
  methods.forEach(pm => {
    const opt = document.createElement('option');
    opt.value = pm.id;
    opt.textContent = pm.ending ? `${pm.name} (****${pm.ending})` : pm.name;
    select.appendChild(opt);
  });
  // Settings list
  const list = $('payment-methods-list');
  if (list) {
    list.innerHTML = '';
    methods.forEach(pm => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span>${pm.name}${pm.ending ? ' ****' + pm.ending : ''}</span>
        <button data-id="${pm.id}" class="btn-delete-pm">🗑</button>
      `;
      list.appendChild(li);
    });
    list.querySelectorAll('.btn-delete-pm').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Zahlungsmittel löschen?')) {
          await dbDelete(STORE_PAYMENTS, Number(btn.dataset.id));
          await loadPaymentMethods();
        }
      });
    });
  }
}

async function loadProjects() {
  const projects = await dbGetAll(STORE_PROJECTS);
  const datalist = $('project-list');
  if (datalist) {
    datalist.innerHTML = '';
    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      datalist.appendChild(opt);
    });
  }
}

async function renderExpenseList(filter = '') {
  const expenses = await dbGetAll(STORE_EXPENSES);
  const list = $('expense-list');
  const empty = $('empty-list');
  list.innerHTML = '';

  const filtered = expenses
    .filter(e => {
      if (!filter) return true;
      const q = filter.toLowerCase();
      return (e.company || '').toLowerCase().includes(q) ||
             (e.project || '').toLowerCase().includes(q) ||
             (e.note || '').toLowerCase().includes(q);
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  if (filtered.length === 0) {
    show(empty);
    return;
  }
  hide(empty);

  filtered.forEach(exp => {
    const card = document.createElement('div');
    card.className = 'expense-item';
    card.innerHTML = `
      <div class="expense-main">
        <div class="expense-title">${exp.company || 'Unbekannt'}</div>
        <div class="expense-meta">${exp.date || '–'} · ${exp.project || 'kein Projekt'} · ${exp.paymentName || '–'}</div>
        <div class="expense-amounts">
          <span class="gross">${Number(exp.amountEUR).toFixed(2)} €</span>
          ${exp.currency !== 'EUR' ? `<span class="orig">(${Number(exp.gross).toFixed(2)} ${exp.currency})</span>` : ''}
        </div>
      </div>
      <div class="expense-actions">
        ${exp.image ? `<button class="icon-btn view-img" data-id="${exp.id}">🖼</button>` : ''}
        <button class="icon-btn delete-exp" data-id="${exp.id}">🗑</button>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('.delete-exp').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('Spese wirklich löschen?')) {
        await dbDelete(STORE_EXPENSES, Number(btn.dataset.id));
        renderExpenseList($('search-list').value);
      }
    });
  });

  list.querySelectorAll('.view-img').forEach(btn => {
    btn.addEventListener('click', async () => {
      const expenses = await dbGetAll(STORE_EXPENSES);
      const exp = expenses.find(e => e.id === Number(btn.dataset.id));
      if (exp && exp.image) {
        const w = window.open('');
        w.document.write(`<img src="${exp.image}" style="max-width:100%">`);
      }
    });
  });
}

// ========== Event Handlers ==========
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'list') renderExpenseList();
    });
  });
}

// ========== Google Cloud Vision OCR ==========
function getVisionApiKey() {
  return localStorage.getItem('spesen_vision_api_key') || '';
}

function setVisionApiKey(key) {
  if (key) localStorage.setItem('spesen_vision_api_key', key.trim());
  else localStorage.removeItem('spesen_vision_api_key');
  updateVisionStatusUI();
}

function updateVisionStatusUI() {
  const el = $('vision-status');
  if (!el) return;
  if (getVisionApiKey()) {
    el.textContent = 'Status: Google Cloud Vision aktiv ✓';
    el.style.color = 'var(--success, #22c55e)';
  } else {
    el.textContent = 'Status: Tesseract (lokal)';
    el.style.color = '';
  }
}

/** Google Cloud Vision – DOCUMENT_TEXT_DETECTION (besser für Belege) */
async function runVisionOCR(dataUrl) {
  const apiKey = getVisionApiKey();
  if (!apiKey) throw new Error('Kein Vision API-Key hinterlegt');

  // data:image/jpeg;base64,xxxx → nur den Base64-Teil
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

  const body = {
    requests: [{
      image: { content: base64 },
      features: [
        { type: 'DOCUMENT_TEXT_DETECTION' }  // besser für strukturierte Belege als TEXT_DETECTION
      ],
      imageContext: {
        languageHints: ['ar', 'en', 'de']   // Arabisch, Englisch, Deutsch
      }
    }]
  };

  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    let msg = `Vision API Fehler (${res.status})`;
    try {
      const j = JSON.parse(errText);
      if (j.error?.message) msg = j.error.message;
    } catch (_) {}
    throw new Error(msg);
  }

  const data = await res.json();
  const annotation = data.responses?.[0];

  if (annotation?.error) {
    throw new Error(annotation.error.message || 'Vision-Fehler');
  }

  // fullTextAnnotation hat den kompletten Text (inkl. Arabisch)
  const text = annotation?.fullTextAnnotation?.text
            || annotation?.textAnnotations?.[0]?.description
            || '';

  return text;
}

/**
 * Beleg aufbereiten: skalieren, Inhaltsbereich zuschneiden,
 * Graustufen + starker Kontrast → besser lesbar für Archiv & OCR
 */
function preprocessImage(dataUrl, opts = {}) {
  const forArchive = opts.forArchive !== false;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        // 1) Auf sinnvolle Größe skalieren
        const maxSide = forArchive ? 1800 : 1600;
        let w = img.width;
        let h = img.height;
        if (w > maxSide || h > maxSide) {
          const scale = maxSide / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        let imageData = ctx.getImageData(0, 0, w, h);
        let d = imageData.data;

        // 2) Graustufen + Kontrast
        const contrast = 1.55;
        const intercept = 128 * (1 - contrast);
        for (let i = 0; i < d.length; i += 4) {
          let gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          gray = contrast * gray + intercept;
          // Leichte Aufhellung dunkler Flächen (Thermobons)
          if (gray < 40) gray = gray * 0.5;
          gray = Math.max(0, Math.min(255, gray));
          d[i] = d[i + 1] = d[i + 2] = gray;
        }

        // 3) Auto-Crop: Inhaltsbereich finden (Pixel die nicht fast weiß sind)
        const threshold = 245;
        let minX = w, minY = h, maxX = 0, maxY = 0;
        const step = Math.max(1, Math.floor(Math.min(w, h) / 400));
        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const idx = (y * w + x) * 4;
            if (d[idx] < threshold) {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }

        // Padding und Plausibilität
        const pad = Math.round(Math.min(w, h) * 0.02);
        minX = Math.max(0, minX - pad);
        minY = Math.max(0, minY - pad);
        maxX = Math.min(w - 1, maxX + pad);
        maxY = Math.min(h - 1, maxY + pad);

        const cropW = maxX - minX;
        const cropH = maxY - minY;
        const areaRatio = (cropW * cropH) / (w * h);

        // Nur croppen wenn sinnvoll (nicht fast leer / nicht winzig)
        if (cropW > 40 && cropH > 40 && areaRatio > 0.08 && areaRatio < 0.98) {
          const cropped = ctx.getImageData(minX, minY, cropW, cropH);
          canvas.width = cropW;
          canvas.height = cropH;
          ctx.putImageData(cropped, 0, 0);
        } else {
          ctx.putImageData(imageData, 0, 0);
        }

        resolve(canvas.toDataURL('image/jpeg', 0.9));
      } catch (e) {
        console.warn('preprocess failed', e);
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function setupUpload() {
  const input = $('receipt-input');
  const area = $('upload-area');
  const placeholder = $('upload-placeholder');
  const preview = $('receipt-preview');

  area.addEventListener('click', () => input.click());

  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const originalDataUrl = ev.target.result;
      currentImageBase64 = originalDataUrl;
      preview.src = currentImageBase64;
      preview.classList.remove('hidden');
      placeholder.classList.add('hidden');

      // OCR starten
      show($('ocr-status'));
      let text = '';
      try {
        // Beleg aufbereiten (Zuschneiden, Graustufen, Kontrast) – wird gespeichert
        $('ocr-text').textContent = 'Beleg wird aufbereitet…';
        const processed = await preprocessImage(originalDataUrl, { forArchive: true });
        currentImageBase64 = processed; // Archiv-Version speichern
        preview.src = processed;        // Vorschau aktualisieren

        const hasVision = !!getVisionApiKey();

        if (hasVision) {
          $('ocr-text').textContent = 'Google Vision analysiert…';
          // Vision: Original oft besser (Farbe/Detail), Fallback auf processed
          try {
            text = await runVisionOCR(originalDataUrl);
          } catch (visionErr) {
            console.warn('Vision mit Original fehlgeschlagen, versuche aufbereitetes Bild', visionErr);
            text = await runVisionOCR(processed);
          }
        } else {
          $('ocr-text').textContent = 'Analysiere mit Tesseract…';
          const result = await Tesseract.recognize(processed, 'ara+eng+deu', {
            logger: m => {
              if (m.status === 'recognizing text') {
                $('ocr-text').textContent = `Tesseract… ${Math.round(m.progress * 100)}%`;
              } else if (m.status === 'loading language traineddata') {
                $('ocr-text').textContent = 'Lade Sprachmodell…';
              }
            }
          });
          text = result?.data?.text || '';
        }
        console.log('OCR Text:', text);

        // Rohtext anzeigen
        const rawBox = $('ocr-raw-box');
        const rawPre = $('ocr-raw-text');
        if (rawBox && rawPre) {
          rawPre.textContent = text?.trim() || '(kein brauchbarer Text erkannt)';
          show(rawBox);
        }

        const parsed = parseReceiptText(text || '');

        if (parsed.company) $('company').value = parsed.company;
        if (parsed.gross) $('amount-gross').value = parsed.gross.toFixed(2);
        if (parsed.net) $('amount-net').value = parsed.net.toFixed(2);
        if (parsed.vat) $('amount-vat').value = parsed.vat.toFixed(2);
        if (parsed.date) $('date').value = parsed.date;
        if (parsed.currency) {
          const curSelect = $('currency');
          // Option anlegen falls noch nicht vorhanden
          if (curSelect && ![...curSelect.options].some(o => o.value === parsed.currency)) {
            const opt = document.createElement('option');
            opt.value = parsed.currency;
            opt.textContent = parsed.currency;
            curSelect.appendChild(opt);
          }
          if (curSelect) curSelect.value = parsed.currency;
        }

        updateEUR();

        // Hinweis wenn fast nichts erkannt wurde
        const useful = (text || '').replace(/[\s*#\-_=xX.]+/g, '').length;
        if (useful < 15) {
          $('ocr-text').textContent = 'Wenig Text erkannt – bitte manuell eingeben';
        }

        // Karten-Vorschlag
        if (parsed.cardEndings.length > 0) {
          const methods = await dbGetAll(STORE_PAYMENTS);
          const match = methods.find(pm => parsed.cardEndings.includes(pm.ending));
          if (match) {
            $('suggested-card').textContent = `${match.name} (****${match.ending})`;
            $('card-suggestion').dataset.pmId = match.id;
            show($('card-suggestion'));
          } else {
            $('suggested-card').textContent = `****${parsed.cardEndings[0]} (noch nicht gespeichert)`;
            $('card-suggestion').dataset.ending = parsed.cardEndings[0];
            show($('card-suggestion'));
          }
        }
      } catch (err) {
        console.error('OCR Fehler', err);
        $('ocr-text').textContent = 'OCR fehlgeschlagen – bitte manuell eingeben';
        const rawBox = $('ocr-raw-box');
        const rawPre = $('ocr-raw-text');
        if (rawBox && rawPre) {
          rawPre.textContent = 'Fehler: ' + (err.message || err);
          show(rawBox);
        }
      } finally {
        setTimeout(() => hide($('ocr-status')), 2500);
      }
    };
    reader.readAsDataURL(file);
  });
}

function updateEUR() {
  const gross = parseFloat($('amount-gross').value) || 0;
  const currency = $('currency').value;
  const eur = convertToEUR(gross, currency);
  $('amount-eur').value = eur.toFixed(2);
}

async function handleSave(e) {
  e.preventDefault();

  const paymentSelect = $('payment-method');
  let paymentId = paymentSelect.value;
  let paymentName = paymentSelect.options[paymentSelect.selectedIndex]?.text || '';

  // Falls Custom (über Modal neu angelegt, sollte schon in DB sein)

  const projectName = $('project').value.trim();
  if (projectName) {
    await dbPut(STORE_PROJECTS, { name: projectName });
  }

  const expense = {
    company: $('company').value.trim(),
    date: $('date').value,
    gross: parseFloat($('amount-gross').value) || 0,
    net: parseFloat($('amount-net').value) || null,
    vat: parseFloat($('amount-vat').value) || null,
    currency: $('currency').value,
    amountEUR: parseFloat($('amount-eur').value) || 0,
    project: projectName || null,
    paymentId: paymentId ? Number(paymentId) : null,
    paymentName: paymentName,
    category: $('category').value,
    note: $('note').value.trim(),
    image: currentImageBase64,
    createdAt: new Date().toISOString()
  };

  await dbAdd(STORE_EXPENSES, expense);

  // Reset Form
  $('expense-form').reset();
  setToday();
  currentImageBase64 = null;
  $('receipt-preview').classList.add('hidden');
  $('upload-placeholder').classList.remove('hidden');
  hide($('card-suggestion'));
  updateEUR();

  alert('Spese gespeichert!');
  // Zur Liste wechseln
  document.querySelector('.tab[data-tab="list"]').click();
}

function setupPaymentModals() {
  $('btn-add-payment')?.addEventListener('click', () => {
    $('pm-name').value = '';
    $('pm-ending').value = '';
    $('pm-type').value = 'card';
    show($('payment-modal'));
  });
  $('btn-new-payment')?.addEventListener('click', () => {
    $('pm-name').value = '';
    $('pm-ending').value = '';
    $('pm-type').value = 'card';
    show($('payment-modal'));
  });
  $('btn-close-payment')?.addEventListener('click', () => hide($('payment-modal')));
  $('btn-save-payment')?.addEventListener('click', async () => {
    const name = $('pm-name').value.trim();
    if (!name) return alert('Name erforderlich');
    const ending = $('pm-ending').value.trim().replace(/\D/g, '').slice(-4) || null;
    await dbAdd(STORE_PAYMENTS, {
      name,
      ending,
      type: $('pm-type').value
    });
    await loadPaymentMethods();
    hide($('payment-modal'));
  });

  // Card suggestion accept/reject
  $('btn-accept-card')?.addEventListener('click', async () => {
    const suggestion = $('card-suggestion');
    if (suggestion.dataset.pmId) {
      $('payment-method').value = suggestion.dataset.pmId;
    } else if (suggestion.dataset.ending) {
      // Neues anlegen
      const ending = suggestion.dataset.ending;
      const name = prompt('Name für diese Karte:', `Karte ****${ending}`);
      if (name) {
        const id = await dbAdd(STORE_PAYMENTS, { name, ending, type: 'card' });
        await loadPaymentMethods();
        $('payment-method').value = id;
      }
    }
    hide(suggestion);
  });
  $('btn-reject-card')?.addEventListener('click', () => hide($('card-suggestion')));
}

function setupSettings() {
  $('btn-settings')?.addEventListener('click', () => {
    // Keys in Felder laden
    const visionKey = getVisionApiKey();
    if ($('vision-api-key') && visionKey) $('vision-api-key').value = visionKey;
    updateVisionStatusUI();
    show($('settings-modal'));
  });
  $('btn-close-settings')?.addEventListener('click', () => hide($('settings-modal')));

  $('btn-save-vision-key')?.addEventListener('click', () => {
    const key = ($('vision-api-key')?.value || '').trim();
    setVisionApiKey(key);
    if (key) {
      alert('Vision API-Key gespeichert. Nächster Scan nutzt Google Cloud Vision.');
    } else {
      alert('Key gelöscht. Es wird wieder Tesseract verwendet.');
    }
  });
}

/** Erzeugt einen sicheren Dateinamen für den Bon */
function makeArchiveFilename(exp, index) {
  const date = exp.date || 'ohne-datum';
  const company = (exp.company || 'Unbekannt')
    .replace(/[^\wÄÖÜäöüß\- ]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 30);
  const amount = Number(exp.amountEUR || exp.gross || 0).toFixed(2).replace('.', ',');
  const prefix = String(index + 1).padStart(3, '0');
  return `${prefix}_${date}_${company}_${amount}EUR`;
}

/** Filtert Spesen nach dem gewählten Zeitraum */
async function getFilteredExpenses() {
  const expenses = await dbGetAll(STORE_EXPENSES);
  const from = $('export-from').value;
  const to = $('export-to').value;
  let filtered = expenses;
  if (from) filtered = filtered.filter(e => e.date >= from);
  if (to) filtered = filtered.filter(e => e.date <= to);
  filtered.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return filtered;
}

function setupExport() {
  // ---- PDF ----
  $('btn-generate-pdf')?.addEventListener('click', async () => {
    const filtered = await getFilteredExpenses();
    if (filtered.length === 0) {
      alert('Keine Spesen im gewählten Zeitraum.');
      return;
    }

    const from = $('export-from').value;
    const to = $('export-to').value;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let y = 20;

    doc.setFontSize(16);
    doc.text('Spesenabrechnung', 14, y);
    y += 8;
    doc.setFontSize(10);
    doc.text(`Zeitraum: ${from || 'Anfang'} – ${to || 'Ende'}`, 14, y);
    y += 6;
    doc.text(`Erstellt am: ${new Date().toLocaleDateString('de-DE')}`, 14, y);
    y += 12;

    let totalEUR = 0;

    filtered.forEach((exp, idx) => {
      if (y > 270) {
        doc.addPage();
        y = 20;
      }
      doc.setFontSize(11);
      doc.setFont(undefined, 'bold');
      doc.text(`${idx + 1}. ${exp.company || 'Unbekannt'}`, 14, y);
      y += 6;
      doc.setFont(undefined, 'normal');
      doc.setFontSize(9);
      doc.text(`Datum: ${exp.date || '–'}  |  Projekt: ${exp.project || '–'}  |  ${exp.paymentName || '–'}`, 14, y);
      y += 5;
      doc.text(`Brutto: ${Number(exp.gross).toFixed(2)} ${exp.currency}  →  ${Number(exp.amountEUR).toFixed(2)} EUR`, 14, y);
      if (exp.net || exp.vat) {
        y += 5;
        doc.text(`Netto: ${exp.net != null ? Number(exp.net).toFixed(2) : '–'}  |  MwSt: ${exp.vat != null ? Number(exp.vat).toFixed(2) : '–'}`, 14, y);
      }
      if (exp.note) {
        y += 5;
        doc.text(`Notiz: ${exp.note}`, 14, y);
      }
      y += 10;
      totalEUR += Number(exp.amountEUR) || 0;
    });

    y += 6;
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text(`Gesamtsumme: ${totalEUR.toFixed(2)} EUR`, 14, y);

    doc.save(`Spesen_${from || 'alle'}_${to || 'bis_heute'}.pdf`);
  });

  // ---- Automatisierte Bon-Archivierung (ZIP) ----
  $('btn-archive-zip')?.addEventListener('click', async () => {
    const filtered = await getFilteredExpenses();
    if (filtered.length === 0) {
      alert('Keine Spesen im gewählten Zeitraum.');
      return;
    }

    if (typeof JSZip === 'undefined') {
      alert('JSZip konnte nicht geladen werden. Bitte Seite neu laden.');
      return;
    }

    const btn = $('btn-archive-zip');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Archiv wird erstellt…';

    try {
      const zip = new JSZip();
      const folder = zip.folder('Bons');
      const meta = [];

      for (let i = 0; i < filtered.length; i++) {
        const exp = filtered[i];
        const baseName = makeArchiveFilename(exp, i);

        // Bild speichern (falls vorhanden)
        if (exp.image) {
          // data:image/jpeg;base64,... → reines Base64
          const base64Data = exp.image.split(',')[1] || exp.image;
          const ext = exp.image.includes('image/png') ? 'png' : 'jpg';
          folder.file(`${baseName}.${ext}`, base64Data, { base64: true });
        }

        // Metadaten für CSV/JSON
        meta.push({
          nr: i + 1,
          datei: exp.image ? `${baseName}.jpg` : '',
          datum: exp.date || '',
          firma: exp.company || '',
          brutto: exp.gross != null ? Number(exp.gross).toFixed(2) : '',
          netto: exp.net != null ? Number(exp.net).toFixed(2) : '',
          mwst: exp.vat != null ? Number(exp.vat).toFixed(2) : '',
          waehrung: exp.currency || 'EUR',
          betrag_eur: exp.amountEUR != null ? Number(exp.amountEUR).toFixed(2) : '',
          projekt: exp.project || '',
          zahlungsmittel: exp.paymentName || '',
          kategorie: exp.category || '',
          notiz: exp.note || '',
          erfasst_am: exp.createdAt || ''
        });
      }

      // JSON-Metadaten
      zip.file('metadaten.json', JSON.stringify(meta, null, 2));

      // CSV (deutsch, Semikolon)
      const csvHeader = 'Nr;Datei;Datum;Firma;Brutto;Netto;MwSt;Waehrung;Betrag_EUR;Projekt;Zahlungsmittel;Kategorie;Notiz;Erfasst_am';
      const csvRows = meta.map(m =>
        [m.nr, m.datei, m.datum, m.firma, m.brutto, m.netto, m.mwst, m.waehrung, m.betrag_eur, m.projekt, m.zahlungsmittel, m.kategorie, `"${(m.notiz || '').replace(/"/g, '""')}"`, m.erfasst_am].join(';')
      );
      const csvContent = '\uFEFF' + csvHeader + '\n' + csvRows.join('\n'); // BOM für Excel
      zip.file('metadaten.csv', csvContent);

      // README
      zip.file('README.txt',
`SpesenTracker – Automatisierte Bon-Archivierung
==============================================
Erstellt am: ${new Date().toLocaleString('de-DE')}
Anzahl Bons: ${filtered.length}

Inhalt:
- Bons/          → Quittungsbilder mit sprechenden Dateinamen
- metadaten.csv  → Übersicht (Excel-tauglich, Semikolon)
- metadaten.json → Maschinenlesbare Metadaten

Dateinamen-Schema:
  001_2026-09-22_REWE_12,34EUR.jpg
`);

      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const from = $('export-from').value || 'alle';
      const to = $('export-to').value || 'bis_heute';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Spesen_Archiv_${from}_${to}.zip`;
      a.click();
      URL.revokeObjectURL(url);

      alert(`Archiv mit ${filtered.length} Bon(s) wurde heruntergeladen.`);
    } catch (err) {
      console.error(err);
      alert('Fehler beim Erstellen des Archivs: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}

// ========== Google Drive Sync (Steuerberater-Struktur) ==========
/*
  Struktur in Drive:
  SpesenTracker/
  ├── 2026-09/
  │   ├── 001_2026-09-15_REWE_23,45EUR.jpg
  │   ├── 002_...
  │   ├── Spesen_2026-09.pdf
  │   ├── metadaten_2026-09.csv
  │   └── metadaten_2026-09.json
  └── 2026-10/
      └── ...
*/

const DRIVE_ROOT_NAME = 'SpesenTracker';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

let googleTokenClient = null;
let googleAccessToken = null;
let gapiInited = false;
let gisInited = false;

function loadGoogleClientId() {
  return localStorage.getItem('spesen_google_client_id') || '';
}

function saveGoogleClientId(id) {
  localStorage.setItem('spesen_google_client_id', id || '');
}

function updateDriveStatusUI() {
  const statusEl = $('drive-status');
  const syncStatus = $('drive-sync-status');
  const connectBtn = $('btn-google-connect');
  const disconnectBtn = $('btn-google-disconnect');
  const syncBtn = $('btn-drive-sync');
  const headerSync = $('btn-sync');

  if (googleAccessToken) {
    if (statusEl) statusEl.textContent = 'Status: Verbunden ✓';
    if (connectBtn) hide(connectBtn);
    if (disconnectBtn) show(disconnectBtn);
    if (syncBtn) syncBtn.disabled = false;
    if (headerSync) headerSync.disabled = false;
  } else {
    if (statusEl) statusEl.textContent = 'Status: Nicht verbunden';
    if (connectBtn) show(connectBtn);
    if (disconnectBtn) hide(disconnectBtn);
    if (syncBtn) syncBtn.disabled = true;
    if (headerSync) headerSync.disabled = true;
  }
}

function initGoogleApis() {
  const clientId = loadGoogleClientId();
  if (!clientId) {
    updateDriveStatusUI();
    return;
  }

  // GIS Token Client
  if (window.google?.accounts?.oauth2) {
    googleTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.error) {
          console.error('Google Auth Fehler', resp);
          alert('Google-Anmeldung fehlgeschlagen: ' + (resp.error_description || resp.error));
          return;
        }
        googleAccessToken = resp.access_token;
        localStorage.setItem('spesen_google_token', googleAccessToken);
        updateDriveStatusUI();
        alert('Erfolgreich mit Google verbunden!');
      }
    });
    gisInited = true;
  }

  // gapi client for Drive
  if (window.gapi) {
    gapi.load('client', async () => {
      try {
        await gapi.client.init({
          discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest']
        });
        gapiInited = true;
        // Restore token if still valid-ish
        const saved = localStorage.getItem('spesen_google_token');
        if (saved) {
          googleAccessToken = saved;
          gapi.client.setToken({ access_token: saved });
        }
        updateDriveStatusUI();
      } catch (e) {
        console.warn('gapi init', e);
      }
    });
  }
}

function connectGoogle() {
  const clientId = ($('google-client-id')?.value || '').trim() || loadGoogleClientId();
  if (!clientId) {
    alert('Bitte zuerst die Google Cloud Client-ID eintragen und speichern.');
    return;
  }
  saveGoogleClientId(clientId);
  if ($('google-client-id')) $('google-client-id').value = clientId;

  if (!googleTokenClient) {
    initGoogleApis();
    // Kurz warten bis GIS geladen
    setTimeout(() => {
      if (googleTokenClient) {
        googleTokenClient.requestAccessToken({ prompt: 'consent' });
      } else {
        alert('Google-Skript noch nicht geladen. Seite neu laden und erneut versuchen.');
      }
    }, 800);
    return;
  }
  googleTokenClient.requestAccessToken({ prompt: googleAccessToken ? '' : 'consent' });
}

function disconnectGoogle() {
  googleAccessToken = null;
  localStorage.removeItem('spesen_google_token');
  if (window.gapi?.client) gapi.client.setToken(null);
  updateDriveStatusUI();
}

/** Findet oder erstellt einen Ordner und gibt die ID zurück */
async function findOrCreateFolder(name, parentId = null) {
  let q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const listRes = await gapi.client.drive.files.list({
    q,
    fields: 'files(id, name)',
    spaces: 'drive'
  });

  if (listRes.result.files && listRes.result.files.length > 0) {
    return listRes.result.files[0].id;
  }

  const meta = {
    name,
    mimeType: 'application/vnd.google-apps.folder'
  };
  if (parentId) meta.parents = [parentId];

  const createRes = await gapi.client.drive.files.create({
    resource: meta,
    fields: 'id'
  });
  return createRes.result.id;
}

/** Lädt eine Datei (Blob oder Base64) zu Drive hoch */
async function uploadToDrive(name, content, mimeType, parentId) {
  // content kann Blob, ArrayBuffer oder base64-string (ohne prefix) sein
  let body;
  if (content instanceof Blob) {
    body = content;
  } else if (typeof content === 'string' && content.startsWith('data:')) {
    // data-URL → Blob
    const res = await fetch(content);
    body = await res.blob();
  } else if (typeof content === 'string') {
    // pure base64
    const byteChars = atob(content);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    body = new Blob([bytes], { type: mimeType });
  } else {
    body = content;
  }

  const metadata = {
    name,
    parents: parentId ? [parentId] : undefined
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', body);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + googleAccessToken
    },
    body: form
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Upload fehlgeschlagen: ' + err);
  }
  return res.json();
}

/** Gruppiert Spesen nach Monat (YYYY-MM) */
function groupByMonth(expenses) {
  const groups = {};
  expenses.forEach(exp => {
    const key = (exp.date || 'ohne-datum').slice(0, 7); // YYYY-MM
    if (!groups[key]) groups[key] = [];
    groups[key].push(exp);
  });
  return groups;
}

/** Erzeugt PDF-Blob für eine Liste von Spesen */
function createPdfBlob(expenses, monthLabel) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let y = 20;

  doc.setFontSize(16);
  doc.text(`Spesenabrechnung ${monthLabel}`, 14, y);
  y += 8;
  doc.setFontSize(10);
  doc.text(`Erstellt am: ${new Date().toLocaleDateString('de-DE')}`, 14, y);
  y += 12;

  let totalEUR = 0;
  expenses.forEach((exp, idx) => {
    if (y > 270) { doc.addPage(); y = 20; }
    doc.setFontSize(11);
    doc.setFont(undefined, 'bold');
    doc.text(`${idx + 1}. ${exp.company || 'Unbekannt'}`, 14, y);
    y += 6;
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9);
    doc.text(`Datum: ${exp.date || '–'}  |  Projekt: ${exp.project || '–'}  |  ${exp.paymentName || '–'}`, 14, y);
    y += 5;
    doc.text(`Brutto: ${Number(exp.gross).toFixed(2)} ${exp.currency}  →  ${Number(exp.amountEUR).toFixed(2)} EUR`, 14, y);
    if (exp.net || exp.vat) {
      y += 5;
      doc.text(`Netto: ${exp.net != null ? Number(exp.net).toFixed(2) : '–'}  |  MwSt: ${exp.vat != null ? Number(exp.vat).toFixed(2) : '–'}`, 14, y);
    }
    y += 10;
    totalEUR += Number(exp.amountEUR) || 0;
  });

  y += 6;
  doc.setFontSize(12);
  doc.setFont(undefined, 'bold');
  doc.text(`Gesamtsumme: ${totalEUR.toFixed(2)} EUR`, 14, y);

  return doc.output('blob');
}

/** Hauptfunktion: Sync zum Steuerberater-freundlichen Drive-Ordner */
async function syncToDrive() {
  if (!googleAccessToken) {
    alert('Bitte zuerst in den Einstellungen mit Google verbinden.');
    return;
  }
  if (!gapiInited) {
    alert('Google API noch nicht bereit. Kurz warten und erneut versuchen.');
    return;
  }

  gapi.client.setToken({ access_token: googleAccessToken });

  const filtered = await getFilteredExpenses();
  if (filtered.length === 0) {
    alert('Keine Spesen im gewählten Zeitraum.');
    return;
  }

  const statusEl = $('drive-sync-status');
  const btn = $('btn-drive-sync');
  const headerBtn = $('btn-sync');
  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };

  if (btn) { btn.disabled = true; btn.textContent = 'Synchronisiere…'; }
  if (headerBtn) headerBtn.disabled = true;

  try {
    setStatus('Root-Ordner prüfen…');
    const rootId = await findOrCreateFolder(DRIVE_ROOT_NAME);

    const groups = groupByMonth(filtered);
    const months = Object.keys(groups).sort();

    for (const month of months) {
      const expenses = groups[month];
      setStatus(`Monat ${month}: Ordner anlegen…`);
      const monthId = await findOrCreateFolder(month, rootId);

      // Bilder hochladen
      for (let i = 0; i < expenses.length; i++) {
        const exp = expenses[i];
        if (!exp.image) continue;
        const baseName = makeArchiveFilename(exp, i);
        const ext = exp.image.includes('image/png') ? 'png' : 'jpg';
        setStatus(`Monat ${month}: Bild ${i + 1}/${expenses.length}…`);
        await uploadToDrive(`${baseName}.${ext}`, exp.image, ext === 'png' ? 'image/png' : 'image/jpeg', monthId);
      }

      // Metadaten CSV + JSON
      const meta = expenses.map((exp, i) => ({
        nr: i + 1,
        datei: exp.image ? `${makeArchiveFilename(exp, i)}.jpg` : '',
        datum: exp.date || '',
        firma: exp.company || '',
        brutto: exp.gross != null ? Number(exp.gross).toFixed(2) : '',
        netto: exp.net != null ? Number(exp.net).toFixed(2) : '',
        mwst: exp.vat != null ? Number(exp.vat).toFixed(2) : '',
        waehrung: exp.currency || 'EUR',
        betrag_eur: exp.amountEUR != null ? Number(exp.amountEUR).toFixed(2) : '',
        projekt: exp.project || '',
        zahlungsmittel: exp.paymentName || '',
        kategorie: exp.category || '',
        notiz: exp.note || ''
      }));

      const csvHeader = 'Nr;Datei;Datum;Firma;Brutto;Netto;MwSt;Waehrung;Betrag_EUR;Projekt;Zahlungsmittel;Kategorie;Notiz';
      const csvRows = meta.map(m =>
        [m.nr, m.datei, m.datum, m.firma, m.brutto, m.netto, m.mwst, m.waehrung, m.betrag_eur, m.projekt, m.zahlungsmittel, m.kategorie, `"${(m.notiz || '').replace(/"/g, '""')}"`].join(';')
      );
      const csvContent = '\uFEFF' + csvHeader + '\n' + csvRows.join('\n');
      const csvBlob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
      const jsonBlob = new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' });

      setStatus(`Monat ${month}: Metadaten…`);
      await uploadToDrive(`metadaten_${month}.csv`, csvBlob, 'text/csv', monthId);
      await uploadToDrive(`metadaten_${month}.json`, jsonBlob, 'application/json', monthId);

      // PDF-Zusammenfassung
      setStatus(`Monat ${month}: PDF…`);
      const pdfBlob = createPdfBlob(expenses, month);
      await uploadToDrive(`Spesen_${month}.pdf`, pdfBlob, 'application/pdf', monthId);
    }

    setStatus(`Fertig! ${filtered.length} Bon(s) in ${months.length} Monat(en) hochgeladen.`);
    alert(`Sync erfolgreich!\n\nOrdner: SpesenTracker\nMonate: ${months.join(', ')}\nAnzahl Bons: ${filtered.length}`);
  } catch (err) {
    console.error(err);
    setStatus('Fehler: ' + err.message);
    alert('Drive-Sync fehlgeschlagen:\n' + err.message + '\n\nToken evtl. abgelaufen – bitte neu verbinden.');
    // Token invalid → zurücksetzen
    if (String(err.message).includes('401') || String(err.message).includes('Invalid Credentials')) {
      disconnectGoogle();
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '☁ Zu Google Drive hochladen'; }
    if (headerBtn) headerBtn.disabled = false;
    updateDriveStatusUI();
  }
}

function setupGoogleDrive() {
  // Client-ID aus LocalStorage laden
  const savedId = loadGoogleClientId();
  if ($('google-client-id') && savedId) {
    $('google-client-id').value = savedId;
  }

  $('btn-google-connect')?.addEventListener('click', () => {
    const id = ($('google-client-id')?.value || '').trim();
    if (id) saveGoogleClientId(id);
    connectGoogle();
  });

  $('btn-google-disconnect')?.addEventListener('click', disconnectGoogle);

  $('btn-drive-sync')?.addEventListener('click', syncToDrive);
  $('btn-sync')?.addEventListener('click', syncToDrive);

  // Client-ID speichern bei Änderung
  $('google-client-id')?.addEventListener('change', (e) => {
    saveGoogleClientId(e.target.value.trim());
  });

  // Google-Skripte brauchen etwas Zeit
  const tryInit = () => {
    if (window.google?.accounts || window.gapi) {
      initGoogleApis();
    } else {
      setTimeout(tryInit, 400);
    }
  };
  tryInit();
  updateDriveStatusUI();
}

// ========== Init ==========
async function init() {
  await openDB();
  await fetchRates();
  setToday();
  await loadPaymentMethods();
  await loadProjects();

  // Default payment methods if empty
  const pms = await dbGetAll(STORE_PAYMENTS);
  if (pms.length === 0) {
    await dbAdd(STORE_PAYMENTS, { name: 'Bar', ending: null, type: 'cash' });
    await dbAdd(STORE_PAYMENTS, { name: 'Firmenkreditkarte', ending: null, type: 'card' });
    await loadPaymentMethods();
  }

  setupTabs();
  setupUpload();
  setupPaymentModals();
  setupSettings();
  setupExport();
  setupGoogleDrive();
  updateVisionStatusUI();

  $('currency').addEventListener('change', updateEUR);
  $('amount-gross').addEventListener('input', updateEUR);
  $('expense-form').addEventListener('submit', handleSave);
  $('search-list')?.addEventListener('input', (e) => renderExpenseList(e.target.value));

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(console.warn);
  }

  console.log('SpesenTracker bereit');
}

document.addEventListener('DOMContentLoaded', init);
