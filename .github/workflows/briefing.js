const SLACK_CHANNEL = 'U0A0V9RHZSN';
const WMS_BASE = 'https://hamperwms.replit.app';
const WMS_EMAIL = 'jack@rosenetic.com';
const WMS_PASSWORD = process.env.WMS_PASSWORD;
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;

async function wmsGet(path, cookie) {
  const res = await fetch(`${WMS_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', 'Cookie': cookie }
  });
  return res.json();
}

async function main() {
  // 1. Login
  const loginRes = await fetch(`${WMS_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: WMS_EMAIL, password: WMS_PASSWORD })
  });
  const setCookies = loginRes.headers.getSetCookie
    ? loginRes.headers.getSetCookie()
    : [loginRes.headers.get('set-cookie') || ''];
  const cookie = setCookies.map(c => c.split(';')[0]).join('; ');
  await loginRes.json();
  console.log('Logged in.');

  // 2. Fire both syncs (fire and forget)
  fetch(`${WMS_BASE}/api/amazon/sync-inventory-v2`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cookie': cookie } });
  fetch(`${WMS_BASE}/api/shipment-tracking/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cookie': cookie } });
  console.log('Syncs fired. Waiting 90 seconds...');
  await new Promise(r => setTimeout(r, 90000));

  // 3. Dates
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const pad = n => String(n).padStart(2, '0');
  const yyyymmdd = `${yesterday.getFullYear()}-${pad(yesterday.getMonth()+1)}-${pad(yesterday.getDate())}`;
  const todayLabel = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // 4. Fetch all data
  console.log('Fetching data...');
  const [sales, forecast, timing, shipments, reorder] = await Promise.all([
    wmsGet(`/api/amazon/sales-summary?startDate=${yyyymmdd}&endDate=${yyyymmdd}&groupBy=day`, cookie),
    wmsGet('/api/sales/forecast-report?preset=30d', cookie),
    wmsGet('/api/shipment-timing', cookie),
    wmsGet('/api/shipment-tracking', cookie),
    wmsGet('/api/reorder-recommendations', cookie),
  ]);

  // 5. Process sales
  const unitsSold = sales.totals?.unitsSold || 0;
  const ordersCount = sales.totals?.ordersCount || 0;
  const top3 = (sales.byHamper || []).slice(0, 3)
    .map((h, i) => `${i+1}. ${h.hamperName.substring(0, 65).trim()}… — ${h.unitsSold} units`).join('\n');

  // 6. Top 5 urgent hampers
  const forecastRows = Array.isArray(forecast) ? forecast : (forecast.rows || forecast.hampers || forecast.data || []);
  const top5 = [...forecastRows].sort((a,b) => (a.daysCover??9999)-(b.daysCover??9999)).slice(0,5);
  const top5Table = top5.map((h, i) => {
    const name = (h.productName||h.name||h.hamperName||'').substring(0, 65);
    return `| ${i+1} | ${name} | ${h.daysCover} days | *${h.recommendedSend||h.recommendedQuantity||'?'}* |`;
  }).join('\n');

  // 7. Inbound timing
  const avgInbound = timing.avgInboundDays || 'N/A';
  const completedCount = timing.completedCount || 0;

  // 8. Delayed shipments
  const allShipments = Array.isArray(shipments) ? shipments : (shipments.shipments || shipments.data || []);
  const delayed = allShipments.filter(s => s.isDelayed && !s.isCompleted);
  const delayedTable = delayed.map(s => {
    const name = (s.shipmentName||s.amazonShipmentName||s.name||'Unknown').substring(0, 40);
    return `| ${name} | ${s.daysSinceCollection} days | ${s.percentReceived}% | ${s.quantityReceived} / ${s.quantityExpected} |`;
  }).join('\n');

  // 9. Order now
  const reorderItems = Array.isArray(reorder) ? reorder : (reorder.recommendations || reorder.items || reorder.data || []);
  const orderNow = reorderItems.filter(i => i.category === 'order_now');
  const orderTable = orderNow.map(i =>
    `| ${(i.name||i.productName||'').trim()} | *${i.casesToOrder} cases* | ${i.currentStock} units | ${i.daysOfStock} days |`
  ).join('\n');

  // 10. Compose message
  const message = `🏭 *Hamper WMS — Daily Briefing | ${todayLabel}*

---

*📦 Yesterday's Sales (${yyyymmdd})*
*${unitsSold} units* sold across *${ordersCount} orders*.

Top sellers:
${top3}

---

*🚨 Top 5 Most Urgent Hampers to Pack*
_Sorted by lowest days of cover — prioritise these first._

| # | Hamper | Days Cover | Send Qty |
|---|--------|-----------|----------|
${top5Table}

---

*⏱️ Average Inbound Time (Build & Send)*
*${avgInbound} days* average across ${completedCount} completed shipments.

---

*⚠️ Delayed Shipments (>7 Days) — ${delayed.length} active*

| Shipment | Age | Progress | Units In |
|----------|-----|----------|---------|
${delayedTable}

---

*🛒 Items to Order Now*

| Item | Order | Stock | Days Left |
|------|-------|-------|----------|
${orderTable}

---
_Briefing auto-generated · Hamper WMS · https://hamperwms.replit.app_`;

  // 11. Open DM channel then send
  const openRes = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify({ users: 'U0A0V9RHZSN' })
  });
  const openData = await openRes.json();
  if (!openData.ok) {
    console.error('❌ Failed to open DM:', openData.error);
    process.exit(1);
  }
  const dmChannel = openData.channel.id;

  const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify({ channel: dmChannel, text: message, mrkdwn: true })
  });
  const slackData = await slackRes.json();
  if (slackData.ok) {
    console.log('✅ Briefing sent to Slack!');
  } else {
    console.error('❌ Slack error:', slackData.error);
    process.exit(1);
  }}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
