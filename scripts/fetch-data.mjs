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

// 富果（Fugle）行情 API 的 intraday quote 端點同時支援個股（EQUITY）跟指數
// （INDEX），一次就能拿到報價、漲跌、當天累計成交值/量，不用再像以前那樣拼
// mis.twse.com.tw（即時報價，無成交值）加 FMTQIK（成交值，常常延後一個交易
// 日才公布）兩個來源——這也是為什麼以前加權指數是今天、成交量卻是前幾天的
// 落差在這個資料源就不會發生了。IX0001 是「發行量加權股價指數」的代碼。
async function fetchFugleQuote(symbol) {
  const apiKey = process.env.FUGLE_API_KEY;
  if (!apiKey) throw new Error('缺少 FUGLE_API_KEY 環境變數');
  const json = await fetchJson(`https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${symbol}`, {
    headers: { 'X-API-KEY': apiKey },
  });
  if (!Number.isFinite(json.closePrice) || !Number.isFinite(json.change) || !json.total) {
    throw new Error(`Fugle 沒有 ${symbol} 的即時資料`);
  }
  return json;
}

async function fetchMarket() {
  const quote = await fetchFugleQuote('IX0001');
  return {
    date: quote.date.replace(/-/g, ''),
    taiex: quote.closePrice,
    change: quote.change,
    trade_value: quote.total.tradeValue,
  };
}

async function fetchHonChuan() {
  const quote = await fetchFugleQuote('9939');
  return {
    date: quote.date.replace(/-/g, ''),
    close: quote.closePrice,
    change: quote.change,
    // Fugle 的 tradeVolume 是「張」，乘 1000 存成「股」，跟資料層原本的單位慣例一致。
    volume: quote.total.tradeVolume * 1000,
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
