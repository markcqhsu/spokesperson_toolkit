import fs from 'node:fs';
import { fetchForex } from './forex.mjs';

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function taipeiDateString(date) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function loadForex() {
  // The 14:00 Taipei snapshot job (fetch-forex-snapshot.mjs) commits this
  // file earlier in the same day; reuse it so the report shows the
  // afternoon reference rate instead of whatever's live at 19:30.
  try {
    const snapshot = JSON.parse(fs.readFileSync('data/forex-1400.json', 'utf8'));
    const today = taipeiDateString(new Date());
    const snapshotDate = taipeiDateString(new Date(snapshot.as_of));
    if (snapshotDate === today) return snapshot;
    console.warn(`data/forex-1400.json 是 ${snapshotDate} 的舊資料，改用即時匯率`);
  } catch (err) {
    console.warn('讀不到 data/forex-1400.json，改用即時匯率:', err.message);
  }
  return fetchForex();
}

async function fetchRealtimeQuote(exCh) {
  // TWSE's own official realtime quote system (same one twstock's
  // realtime module and TWSE's own website widgets use). Gives same-day
  // price/change well before the OpenAPI/FMTQIK mirrors publish.
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&_=${Date.now()}`;
  const json = await fetchJson(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://mis.twse.com.tw/stock/index.jsp',
    },
  });
  const quote = json.msgArray?.[0];
  if (json.rtcode !== '0000' || !quote || !quote.z || !quote.y) {
    throw new Error(`mis.twse.com.tw 沒有 ${exCh} 的即時資料`);
  }
  return quote;
}

function priceChange(quote) {
  return Math.round((Number(quote.z) - Number(quote.y)) * 100) / 100;
}

async function fetchMarket() {
  const quote = await fetchRealtimeQuote('tse_t00.tw');
  // The realtime index quote has no market-wide turnover figure, so
  // trade_value still comes from FMTQIK and keeps its own (often older) date.
  const rows = await fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK');
  const latestFmtqik = rows[rows.length - 1];
  return {
    date: quote.d,
    taiex: Number(quote.z),
    change: priceChange(quote),
    trade_value: Number(latestFmtqik.TradeValue),
    trade_value_date: latestFmtqik.Date,
  };
}

async function fetchHonChuan() {
  const quote = await fetchRealtimeQuote('tse_9939.tw');
  return {
    date: quote.d,
    close: Number(quote.z),
    change: priceChange(quote),
    volume: Number(quote.v) * 1000, // "v" is in 張 (board lots of 1000 shares)
  };
}

// Picks the past_week entry whose timestamp is nearest targetTime. past_week
// (not past_day) is used because on a Monday run the last US close is Friday
// afternoon, more than 24h back — past_day's window wouldn't reach it.
function closestPricePoint(points, targetTime) {
  const list = Array.isArray(points) ? points : [points];
  const target = new Date(targetTime).getTime();
  let best = null;
  let bestDiff = Infinity;
  for (const p of list) {
    const tsRaw = p.as_of ?? p.created_at ?? p.timestamp ?? p.period;
    if (!tsRaw) continue;
    const diff = Math.abs(new Date(tsRaw).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  if (!best) throw new Error('oilpriceapi past_week 回應裡沒有可用的資料點');
  if (typeof best.price !== 'number') {
    // Fail loudly instead of writing an undefined price into data/latest.json —
    // this field name is guessed (oilpriceapi's past_week response shape isn't
    // documented), so a wrong guess should break the run, not the report.
    throw new Error(`oilpriceapi past_week 資料點沒有數字型別的 price 欄位: ${JSON.stringify(best)}`);
  }
  return {
    price: best.price,
    change: best.changes?.['24h']?.amount ?? null,
    as_of: new Date(best.as_of ?? best.created_at ?? best.timestamp ?? best.period).toISOString(),
  };
}

async function fetchOil(token, targetTime) {
  const headers = { Authorization: `Token ${token}` };
  const [wti, brent] = await Promise.all([
    fetchJson('https://api.oilpriceapi.com/v1/prices/past_week?by_code=WTI_USD', { headers }),
    fetchJson('https://api.oilpriceapi.com/v1/prices/past_week?by_code=BRENT_CRUDE_USD', { headers }),
  ]);
  return {
    wti: closestPricePoint(wti.data, targetTime),
    brent: closestPricePoint(brent.data, targetTime),
  };
}

async function fetchDowJones() {
  // No range/interval params: Yahoo defaults to range=1d, which gives the
  // actual previous trading day's close via meta.previousClose. Adding
  // range=5d shifts chartPreviousClose to the close from ~5 days back
  // instead of yesterday, producing a wildly wrong "daily" change.
  const data = await fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/%5EDJI', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const meta = data.chart.result[0].meta;
  const prevClose = meta.previousClose ?? meta.chartPreviousClose;
  return {
    price: meta.regularMarketPrice,
    prev_close: prevClose,
    change: Math.round((meta.regularMarketPrice - prevClose) * 100) / 100,
    as_of: new Date(meta.regularMarketTime * 1000).toISOString(),
  };
}

async function main() {
  const token = process.env.OILPRICEAPI_TOKEN;
  if (!token) throw new Error('Missing OILPRICEAPI_TOKEN env var');

  const [forex, market, honchuan, usMarket] = await Promise.all([
    loadForex(),
    fetchMarket(),
    fetchHonChuan(),
    fetchDowJones(),
  ]);

  // Oil is anchored to the same "as of" instant as the Dow Jones close
  // (rather than oilpriceapi's live tick) so both reflect the same US
  // trading-day close.
  const oil = await fetchOil(token, usMarket.as_of);

  const result = {
    generated_at: new Date().toISOString(),
    forex,
    market,
    honchuan,
    oil,
    us_market: usMarket,
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/latest.json', JSON.stringify(result, null, 2));
  console.log('Wrote data/latest.json');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
