import fs from 'node:fs';

async function fetchText(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cols[i]; });
    return obj;
  });
}

async function fetchForex() {
  const csv = await fetchText('https://www.taifex.com.tw/data_gov/taifex_open_data.asp?data_name=DailyForeignExchangeRates');
  const rows = parseCsv(csv);
  const latest = rows[rows.length - 1];
  return {
    date: latest['日期'],
    usd_twd: Number(latest['美元_新台幣(匯率)']),
    eur_usd: Number(latest['歐元_美元(匯率)']),
    usd_cny: Number(latest['美元_人民幣(匯率)']),
    cny_twd: Number(latest['人民幣_新台幣(匯率)']),
  };
}

async function fetchMarket() {
  const rows = await fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK');
  const latest = rows[rows.length - 1];
  return {
    date: latest.Date,
    taiex: Number(latest.TAIEX),
    change: Number(latest.Change),
    trade_value: Number(latest.TradeValue),
  };
}

function rocDateToInternal(rocDate) {
  // "115/08/10" -> "1150810" (matches the ROC date format used elsewhere)
  return rocDate.replace(/\//g, '');
}

async function fetchHonChuanForMonth(yyyymm01) {
  // The STOCK_DAY_ALL OpenAPI mirror lags a day behind; this classic
  // per-stock endpoint publishes the same trading day's close sooner.
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${yyyymm01}&stockNo=9939`;
  const json = await fetchJson(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (json.stat !== 'OK' || !json.data || json.data.length === 0) return null;
  const row = json.data[json.data.length - 1];
  const [rocDate, volumeShares, , , , , closePrice, change] = row;
  return {
    date: rocDateToInternal(rocDate),
    close: Number(closePrice),
    change: Number(change),
    volume: Number(volumeShares.replace(/,/g, '')),
  };
}

async function fetchHonChuan() {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}01`;
  const result = await fetchHonChuanForMonth(thisMonth);
  if (result) return result;
  // Fallback for the first trading day(s) of a month, before this month has any rows yet.
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = `${prev.getFullYear()}${String(prev.getMonth() + 1).padStart(2, '0')}01`;
  return fetchHonChuanForMonth(prevMonth);
}

async function fetchOil(token) {
  const headers = { Authorization: `Token ${token}` };
  const [wti, brent] = await Promise.all([
    fetchJson('https://api.oilpriceapi.com/v1/prices/latest?by_code=WTI_USD', { headers }),
    fetchJson('https://api.oilpriceapi.com/v1/prices/latest?by_code=BRENT_CRUDE_USD', { headers }),
  ]);
  return {
    wti: {
      price: wti.data.price,
      change: wti.data.changes?.['24h']?.amount ?? null,
      as_of: wti.data.as_of,
    },
    brent: {
      price: brent.data.price,
      change: brent.data.changes?.['24h']?.amount ?? null,
      as_of: brent.data.as_of,
    },
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

  const [forex, market, honchuan, oil, usMarket] = await Promise.all([
    fetchForex(),
    fetchMarket(),
    fetchHonChuan(),
    fetchOil(token),
    fetchDowJones(),
  ]);

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
