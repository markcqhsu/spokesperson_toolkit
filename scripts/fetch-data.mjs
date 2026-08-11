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

// TWSE returns "-" (not empty/absent) for z/y before a stock's first trade
// of the day, e.g. pre-market. "-" is truthy, so a plain !quote.z check
// misses it, and Number("-") is NaN — silently producing a "null" price
// downstream instead of a clear error.
function isValidQuoteNumber(v) {
  return v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
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
  if (json.rtcode !== '0000' || !quote || !isValidQuoteNumber(quote.z) || !isValidQuoteNumber(quote.y)) {
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

// 經濟部能源署官方每日原油參考價（路透社資料），unit=day 回傳最近 22 個交易日、
// 最新一筆在最前面。這是每日更新一次的參考價，SurDate 本身就是實際報價日期
// （通常是查詢當下的前一個已結算交易日），不用另外對齊或猜測時間戳欄位。
async function fetchOilMoe() {
  const form = new FormData();
  form.append('unit', 'day');
  const res = await fetch('https://www2.moeaea.gov.tw/oil111/CrudeOil/CrudeOil/load', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`能源署原油資料 -> ${res.status}`);
  const json = await res.json();
  const rows = json.data?.crudeoil;
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('能源署原油資料筆數不足，無法算漲跌');
  }
  const [latest, prev] = rows;
  const round2 = (n) => Math.round(n * 100) / 100;
  const asOf = latest.SurDate.replace(/\//g, '-');
  return {
    wti: { price: latest.WestT, change: round2(latest.WestT - prev.WestT), as_of: asOf },
    brent: { price: latest.Burant, change: round2(latest.Burant - prev.Burant), as_of: asOf },
  };
}

// 鉅亨網的期貨走勢圖頁（so.cnyes.com/JavascriptGraphic/chartstudy.aspx）沒有獨立
// 的資料 API，是把整年每日 OHLCV 直接以 `globalData.push([...])` 內嵌在頁面的
// <script> 裡回傳；每一列格式是
// [x座標, y座標, '日期YYYYMMDD', 開, 高, 低, 收, 量, 0, 圖表最大值, 圖表最小值,]。
// 發言人習慣核對鉅亨網的報價，所以跟能源署的數字並列顯示，而不是互相取代——
// 兩者都是每日收盤一次更新，不是逐秒跳動的即時報價。
async function fetchCnyesDaily(code) {
  const res = await fetch(
    `https://so.cnyes.com/JavascriptGraphic/chartstudy.aspx?country=future&market=future&code=${code}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: `https://www.cnyes.com/futures/html5chart/${code}.html`,
      },
    },
  );
  if (!res.ok) throw new Error(`cnyes ${code} -> ${res.status}`);
  const html = await res.text();
  const rows = [...html.matchAll(/globalData\.push\(\[([^\]]*)\]\)/g)].map((m) => m[1].split(','));
  if (rows.length < 2) throw new Error(`cnyes ${code} 沒有足夠的每日資料`);
  const parseRow = (r) => ({ date: r[2].replace(/'/g, ''), close: Number(r[6]) });
  const latest = parseRow(rows[rows.length - 1]);
  const prev = parseRow(rows[rows.length - 2]);
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    price: latest.close,
    change: round2(latest.close - prev.close),
    as_of: `${latest.date.slice(0, 4)}-${latest.date.slice(4, 6)}-${latest.date.slice(6, 8)}`,
  };
}

async function fetchOilCnyes() {
  const [wti, brent] = await Promise.all([fetchCnyesDaily('CLCON'), fetchCnyesDaily('IBCON')]);
  return { wti, brent };
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
  const [forex, market, honchuan, usMarket, oilMoe, oilCnyes] = await Promise.all([
    loadForex(),
    fetchMarket(),
    fetchHonChuan(),
    fetchDowJones(),
    fetchOilMoe(),
    fetchOilCnyes(),
  ]);

  const result = {
    generated_at: new Date().toISOString(),
    forex,
    market,
    honchuan,
    oil_moe: oilMoe,
    oil_cnyes: oilCnyes,
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
