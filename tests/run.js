// שכן מגן — Test suite
const BASE = 'http://localhost:3011';
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log('\x1b[32m✅\x1b[0m', name); }
  catch (e) { failed++; console.log('\x1b[31m❌\x1b[0m', name, '-', e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'fail'); }

(async () => {
  console.log('══════════════════════════════');
  console.log('  שכן מגן — סדרת בדיקות');
  console.log('══════════════════════════════\n');

  // ── Health & Static ──
  await test('Health check', async () => {
    const d = await (await fetch(BASE + '/health')).json();
    assert(d.status === 'ok');
  });
  await test('App page loads', async () => {
    const r = await fetch(BASE + '/app');
    assert(r.ok && (await r.text()).includes('שכן מגן'));
  });
  await test('Admin page loads', async () => {
    assert((await fetch(BASE + '/')).ok);
  });
  await test('Leaflet vendor', async () => {
    assert((await fetch(BASE + '/vendor/leaflet/leaflet.js')).ok);
  });
  await test('Logo SVG', async () => {
    assert((await fetch(BASE + '/icons/logo.svg')).ok);
  });

  // ── Shelters (public) ──
  await test('Nearby — returns all approved', async () => {
    const d = await (await fetch(BASE + '/api/shelters/nearby?lat=32.256&lng=34.918&radius=2000')).json();
    assert(d.shelters.length >= 3, 'got ' + d.shelters.length);
    assert(d.shelters[0].distance > 0);
    assert(d.shelters[0].walkMinutes > 0);
  });
  await test('Nearby — radius filter', async () => {
    const d = await (await fetch(BASE + '/api/shelters/nearby?lat=32.256&lng=34.918&radius=50')).json();
    assert(d.shelters.length === 0);
  });
  await test('Nearby — missing params error', async () => {
    const d = await (await fetch(BASE + '/api/shelters/nearby')).json();
    assert(d.error);
  });

  // ── Auth ──
  await test('Send OTP', async () => {
    const d = await (await fetch(BASE + '/api/auth/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0501111111' }) })).json();
    assert(d.success && d.code);
  });
  await test('Verify OTP — new user → regToken', async () => {
    const otp = await (await fetch(BASE + '/api/auth/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0507777777' }) })).json();
    const d = await (await fetch(BASE + '/api/auth/verify-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0507777777', code: otp.code }) })).json();
    assert(d.needsRegistration && d.regToken);
  });
  await test('Verify OTP — wrong code → 401', async () => {
    await (await fetch(BASE + '/api/auth/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0508888888' }) })).json();
    const r = await fetch(BASE + '/api/auth/verify-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0508888888', code: '000000' }) });
    assert(r.status === 401);
  });
  await test('Register with full details', async () => {
    const phone = '050' + Date.now().toString().slice(-7);
    const otp = await (await fetch(BASE + '/api/auth/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })).json();
    const v = await (await fetch(BASE + '/api/auth/verify-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: otp.code }) })).json();
    const d = await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regToken: v.regToken, name: 'Test User', address: 'Test 1', floor: 2, capacity: 5 }) })).json();
    assert(d.success && d.token && d.host.name === 'Test User');
  });
  await test('Existing user login', async () => {
    const otp = await (await fetch(BASE + '/api/auth/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0541234567' }) })).json();
    const d = await (await fetch(BASE + '/api/auth/verify-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0541234567', code: otp.code }) })).json();
    assert(d.success && d.token && !d.needsRegistration && d.host.name === 'דוד כהן');
  });

  // ── Host operations ──
  const otp = await (await fetch(BASE + '/api/auth/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0541234567' }) })).json();
  const login = await (await fetch(BASE + '/api/auth/verify-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0541234567', code: otp.code }) })).json();
  const T = login.token;
  const hdr = { 'Authorization': 'Bearer ' + T, 'Content-Type': 'application/json' };
  const hdrNoBody = { 'Authorization': 'Bearer ' + T };

  await test('Get my shelter', async () => {
    const d = await (await fetch(BASE + '/api/shelters/mine', { headers: hdr })).json();
    assert(d.host && d.stats !== undefined);
  });
  await test('Update shelter', async () => {
    const d = await (await fetch(BASE + '/api/shelters/mine', { method: 'PUT', headers: hdr, body: JSON.stringify({ notes: 'test update' }) })).json();
    assert(d.success);
  });
  await test('Deactivate shelter', async () => {
    const d = await (await fetch(BASE + '/api/shelters/mine/deactivate', { method: 'POST', headers: hdrNoBody })).json();
    assert(d.success);
  });
  await test('Activate shelter', async () => {
    const d = await (await fetch(BASE + '/api/shelters/mine/activate', { method: 'POST', headers: hdrNoBody })).json();
    assert(d.success);
    await (await fetch(BASE + '/api/shelters/mine/deactivate', { method: 'POST', headers: hdrNoBody })).json();
  });
  await test('Unauthorized → 401', async () => {
    assert((await fetch(BASE + '/api/shelters/mine')).status === 401);
  });

  // ── Alerts ──
  await fetch(BASE + '/api/alerts/stop', { method: 'POST' }); // clean

  await test('No active alert', async () => {
    const d = await (await fetch(BASE + '/api/alerts/active')).json();
    assert(!d.alert);
  });
  await test('Drill alert', async () => {
    const d = await (await fetch(BASE + '/api/alerts/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cities: 'תל מונד', timeToShelter: 30 }) })).json();
    assert(d.success);
  });
  await test('Active alert after drill', async () => {
    const d = await (await fetch(BASE + '/api/alerts/active')).json();
    assert(d.alert && !d.alert.ended_at);
  });
  await test('Always-open auto-activated', async () => {
    const d = await (await fetch(BASE + '/api/shelters/nearby?lat=32.256&lng=34.918&radius=2000')).json();
    assert(d.shelters.filter(s => s.is_active).length >= 2, 'open: ' + d.shelters.filter(s => s.is_active).length);
  });
  await test('Open shelters sorted first', async () => {
    const d = await (await fetch(BASE + '/api/shelters/nearby?lat=32.256&lng=34.918&radius=2000')).json();
    assert(d.shelters[0].is_active);
  });
  await test('Stop alert', async () => {
    const d = await (await fetch(BASE + '/api/alerts/stop', { method: 'POST' })).json();
    assert(d.success && d.stopped >= 1);
  });
  await test('All closed after stop', async () => {
    const d = await (await fetch(BASE + '/api/shelters/nearby?lat=32.256&lng=34.918&radius=2000')).json();
    assert(d.shelters.filter(s => s.is_active).length === 0);
  });
  await test('Alert history exists', async () => {
    const d = await (await fetch(BASE + '/api/alerts/history')).json();
    assert(d.alerts.length > 0);
  });

  // ── Seeker events ──
  await test('Record seeker event', async () => {
    const d = await (await fetch(BASE + '/api/shelters/1/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'navigate', lat: 32.256, lng: 34.918 }) })).json();
    assert(d.success);
  });

  // ── Admin ──
  await test('Admin stats', async () => {
    const d = await (await fetch(BASE + '/api/admin/stats')).json();
    assert(d.totalHosts > 0);
  });
  await test('Admin hosts', async () => {
    const d = await (await fetch(BASE + '/api/admin/hosts')).json();
    assert(d.hosts.length > 0);
  });
  await test('Push VAPID key', async () => {
    const d = await (await fetch(BASE + '/api/push/vapid-key')).json();
    assert(d.ok);
  });

  console.log('\n══════════════════════════════');
  console.log(`  ${passed} עברו, ${failed} נכשלו`);
  console.log('══════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
})();
