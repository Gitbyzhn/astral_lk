import { config } from './config.js';
import { openDatabase } from './db.js';
import { createEventHub } from './events.js';
import { createApp, lanAddresses } from './app.js';

const db = openDatabase();
const events = createEventHub();
const { app, services } = createApp({ db, events });

// Ұмытылған ескі талондарды мезгіл-мезгіл жабу.
const sweep = () => {
  if (services.orders.expireStale() > 0) events.emit('queue');
};
sweep();
setInterval(sweep, 60_000).unref();

const server = app.listen(config.port, config.host, () => {
  const urls = [`http://localhost:${config.port}`, ...lanAddresses().map((ip) => `http://${ip}:${config.port}`)];
  console.log('\n  Astral — кезек жүйесі іске қосылды');
  for (const url of urls) console.log(`  • Клиент:  ${url}\n    Әкімші:  ${url}/admin`);
  const base = config.publicUrl || urls.at(-1);
  console.log(`\n  🔑 Әкімші сілтемесі (құпиясөзсіз кіру, тек қызметкерлерге):\n     ${base}/admin#key=${services.auth.adminKey()}`);
  if (services.auth.isDefault()) {
    console.log('\n  ⚠ Әдепкі құпиясөз: "admin" — кіргеннен кейін «Баптаулар» бетінде өзгертіңіз.');
  }
  if (config.publicUrl) console.log(`  QR сілтемелері: ${config.publicUrl}`);
  console.log(`  Уақыт белдеуі: ${config.timeZone} · Деректер: ${config.dataDir}\n`);
});

function shutdown() {
  events.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
