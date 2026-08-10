import fs from 'node:fs';
import { fetchForex } from './forex.mjs';

// Runs on its own cron (14:00 Taipei) so data/forex-1400.json holds the
// afternoon reference rate the 19:30 full fetch later reads instead of
// re-fetching a live quote at that later time.
async function main() {
  const forex = await fetchForex();
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/forex-1400.json', JSON.stringify(forex, null, 2));
  console.log('Wrote data/forex-1400.json');
  console.log(JSON.stringify(forex, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
