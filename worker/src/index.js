const ALLOWED_ORIGIN = 'https://markcqhsu.github.io';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function fetchText(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

// mis.twse.com.tw (and occasionally so.cnyes.com) intermittently return
// Cloudflare 520s (edge-to-edge hiccups between our Worker and the target's
// own Cloudflare-fronted host) even though the same request succeeds seconds
// later from a plain client. Retry a couple of times before surfacing the
// failure to the user.
async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

function fetchJsonWithRetry(url, opts) {
  return withRetry(() => fetchJson(url, opts));
}

async function fetchForex() {
  // rter.info only publishes USD-based pairs, so EUR/USD and CNY/TWD are
  // derived by division — an exact identity, not an approximation.
  const data = await fetchJson('https://tw.rter.info/capi.php');
  const usdTwd = data.USDTWD;
  const usdCny = data.USDCNY;
  const usdEur = data.USDEUR;
  if (!usdTwd || !usdCny || !usdEur) {
    throw new Error('rter.info 缺少必要幣別資料 (USDTWD/USDCNY/USDEUR)');
  }
  // Each pair can be refreshed at a slightly different moment; use the
  // oldest of the three so the reported "as of" time holds for all of them.
  const toDate = (utc) => new Date(utc.replace(' ', 'T') + 'Z');
  const oldest = [usdTwd.UTC, usdCny.UTC, usdEur.UTC]
    .map(toDate)
    .reduce((a, b) => (a < b ? a : b));
  return {
    as_of: oldest.toISOString(),
    usd_twd: usdTwd.Exrate,
    eur_usd: 1 / usdEur.Exrate,
    usd_cny: usdCny.Exrate,
    cny_twd: usdTwd.Exrate / usdCny.Exrate,
  };
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
  const json = await fetchJsonWithRetry(url, {
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

// 經濟部能源署官方每日原油參考價（路透社資料）。oilpriceapi 的 /latest 實測會卡在
// 舊快照好幾個小時不動，看起來即時實則不準；能源署這份本來就是每日更新一次的
// 參考價，SurDate 就是實際報價日期，不用假裝是即時報價。
async function fetchOilMoe() {
  const form = new FormData();
  form.append('unit', 'day');
  const json = await fetchJsonWithRetry('https://www2.moeaea.gov.tw/oil111/CrudeOil/CrudeOil/load', {
    method: 'POST',
    body: form,
  });
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
  const html = await withRetry(() =>
    fetchText(`https://so.cnyes.com/JavascriptGraphic/chartstudy.aspx?country=future&market=future&code=${code}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: `https://www.cnyes.com/futures/html5chart/${code}.html`,
      },
    }),
  );
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

// Human-readable label per source, used to prefix that source's error message
// so a failure in one (e.g. TWSE's realtime system being down) is attributed
// to the right line instead of reading as a generic, unexplained failure.
const SOURCE_LABELS = {
  forex: '匯率',
  market: '大盤指數',
  honchuan: '宏全股價',
  oil_moe: '原油現貨（能源署）',
  oil_cnyes: '原油期貨（鉅亨網）',
  us_market: '美股道瓊',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      // Promise.allSettled (not Promise.all) so one source failing — e.g.
      // mis.twse.com.tw having no data outside trading hours — doesn't wipe
      // out the other four sources that fetched fine.
      const keys = ['forex', 'market', 'honchuan', 'oil_moe', 'oil_cnyes', 'us_market'];
      const settled = await Promise.allSettled([
        fetchForex(),
        fetchMarket(),
        fetchHonChuan(),
        fetchOilMoe(),
        fetchOilCnyes(),
        fetchDowJones(),
      ]);

      const result = { generated_at: new Date().toISOString() };
      const errors = {};
      settled.forEach((outcome, i) => {
        const key = keys[i];
        if (outcome.status === 'fulfilled') {
          result[key] = outcome.value;
        } else {
          errors[key] = `${SOURCE_LABELS[key]}：${outcome.reason.message}`;
        }
      });
      if (Object.keys(errors).length) result.errors = errors;

      return new Response(JSON.stringify(result, null, 2), { headers: corsHeaders() });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: corsHeaders(),
      });
    }
  },
};
