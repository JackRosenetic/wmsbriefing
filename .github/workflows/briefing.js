const SLACK_CHANNEL = 'D0A187GQTAM';
const WMS_BASE = 'https://hamperwms.replit.app';
const WMS_EMAIL = 'jack@rosenetic.com';
const WMS_PASSWORD = process.env.WMS_PASSWORD;
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;

async function wmsPost(path, cookie) {
  try {
    await fetch(`${WMS_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie }
    });
  } catch (e) { console.warn(`Sync warning ${path}: ${e.message}`); }
}

async function wmsGet(path, cookie) {
  try {
    const res = await fetch(`${WMS_BASE}${path}`, { headers: { Cookie: cookie } });
    if (!res.ok) { console.warn(`WARN ${path} → ${res.status}`); return null; }
    return res.json();
  } catch (e) { console.warn(`ERROR ${path}: ${e.message}`); return null; }
}

async function sendSlack(message) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text: message, mrkdwn: true })
  });
  const data = await res.json();
  if (!data.ok) throw new Error('Slack error: ' + data.error);
}

async function main() {
  const loginRes = await fetch(`${WMS_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: WMS_EMAIL, password: WMS_PASSWORD })
  });
  if (!loginRes.ok) {
    await sendSlack('⚠️ Daily WMS briefing failed — could not log in to https://hamperwms.replit.app/');
    process.exit(1);
  }
  const setCookies = loginRes.headers.getSetCookie
    ? loginRes.headers.getSetCookie()
    : [loginRes.headers.get('set-cookie') || ''];
  const cookie = setCookies.map(c => c.split(';')[0]).join('; ');
  await loginRes.json();
  console.log('Logged in ✓');

  wmsPost('/api/amazon/sync-inventory-v2', cookie);
  wmsPost('/api/shipment-tracking/sync', cookie);
  console.log('Syncs fired. Waiting 90s...');
  await new Promise(r => setTimeout(r, 90000));

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const pad = n => String(n).padStart(2, '0');
  const yyyymmdd = `${yesterday.getFullYear()}-${pad(yesterday.getMonth()+1)}-${pad(yesterday.getDate())}`;
  const todayLabel = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  console.log('Fetching data...');
  const [sales, packPlan, timing, tracking, reorder] = await Promise.all([
    wmsGet(`/api/amazon/sales-summary?startDate=${yyyymmdd}&endDate=${yyyymmdd}&groupBy=day`, cookie),
    wmsGet('/api/pack-shipments/plan', cookie),
    wmsGet('/api/shipment-timing', cookie),
    wmsGet('/api/shipment-tracking', cookie),
    wmsGet('/api/reorder-recommendations', cookie),
  ]);

  const unitsSold = sales?.totals?.unitsSold ?? 0;
  const ordersCount = sales?.totals?.ordersCount ?? 0;
  const topProducts = (sales?.byHamper || []).slice(0, 3);
  let salesProse;
  if (topProducts.length) {
    const top2 = topProducts.slice(0, 2)
      .map(h => `${(h.productName || h.hamperName || '').split(' -')[0].trim()} (${h.unitsSold || h.units || 0} units)`)
      .join(' and ');
    salesProse = `Yesterday saw ${unitsSold} units sold across ${ordersCount} orders. Top performers were ${top2}.`;
  } else {
    salesProse = `(data unavailable) — ${unitsSold} units / ${ordersCount} orders.`;
  }

  // Combine hamper rows (daysOfCover) and DIY rows (daysCover) and sort together
  const hamperRows = (packPlan?.rows || []).map(h => ({
    name: h.hamperName || h.productName || 'Unknown',
    cover: h.daysOfCover ?? 9999,
    send: h.recommendedSend || 0,
  }));
  const diyRows = (packPlan?.diyRows || []).map(d => ({
    name: d.productName || d.hamperName || 'Unknown',
    cover: d.daysCover ?? 9999,
    send: d.recommendedSend || 0,
  }));
  const allProducts = [...hamperRows, ...diyRows]
    .sort((a, b) => a.cover - b.cover)
    .slice(0, 5);
  const urgentLines = allProducts.length
    ? allProducts.map(p => `• ${p.name} - Days of Cover (${Math.round(p.cover * 10) / 10}d) Recommended Send ${p.send}`).join('\n')
    : '(data unavailable)';

  const avgD = timing?.avgInboundDays ?? 'N/A';
  const completedCount = timing?.completedCount ?? 0;
  const minD = timing?.minInboundDays ?? 'N/A';
  const maxD = timing?.maxInboundDays ?? 'N/A';
  const timingLine = `Current average inbound time is *${avgD}d* across ${completedCount} completed shipments (range: ${minD}d – ${maxD}d).`;

  const allShipments = Array.isArray(tracking) ? tracking : (tracking?.shipments || []);
  const delayed = allShipments.filter(s => s.isDelayed && !s.isCompleted);
  const delayedLines = delayed.map(s =>
    `• ${s.shipmentName || s.amazonShipmentName || 'Unknown'} — ${s.daysSinceCollection} days in transit | Status: ${s.amazonStatus} | Progress: ${s.quantityReceived}/${s.quantityExpected} units (${s.percentReceived}%)`
  ).join('\n') || '✅ No delayed shipments';

  const recs = Array.isArray(reorder) ? reorder : (reorder?.recommendations || []);
  const orderNow = recs.filter(i => i.category === 'order_now');
  const orderLines = orderNow.map(i =>
    `• ${(i.name || '').trim()} — Order ${i.casesToOrder} cases (stock: ${i.currentStock} units / ${i.daysOfStock} days remaining)`
  ).join('\n') || '✅ No items need ordering today';

  const message = `📅 *${todayLabel}*

*Yesterday's Sales*
${salesProse}

---

*🚚 Avg Inbound Time*
${timingLine}

---

*📦 Top 5 Most Urgent to Pack* — lowest days of cover first
${urgentLines}

---

*⏰ Delayed Shipments (>7 days)*
${delayedLines}

---

*⚠️ Items to Order*
${orderLines}`;

  await sendSlack(message);
  console.log('✅ Brief sent to Slack!');
}

main().catch(async err => {
  console.error('Fatal:', err);
  try { await sendSlack('⚠️ Daily WMS briefing failed with error: ' + err.message); } catch (_) {}
  process.exit(1);
});
