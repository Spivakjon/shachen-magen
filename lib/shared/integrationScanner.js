// shared-dashboard/lib/integrationScanner.js
// Scans .env files across all projects and maps every integration with details.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

/* ── Parse .env ── */
function parseEnv(dir) {
  try {
    const raw = readFileSync(resolvePath(dir, '.env'), 'utf8');
    const env = {};
    for (const line of raw.split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      env[k] = v;
    }
    return env;
  } catch { return {}; }
}

/* ── Mask sensitive values ── */
function mask(val) {
  if (!val) return null;
  if (val.length <= 8) return '••••';
  return val.slice(0, 4) + '••••' + val.slice(-4);
}

/* ── Detect integrations from env vars ── */
function detectIntegrations(env) {
  const integrations = [];
  const has = (k) => !!env[k];
  const val = (k) => env[k] || '';
  const enabled = (k, fallback = true) => {
    if (!has(k)) return fallback;
    const v = val(k);
    return v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'disabled';
  };

  // ── Database ──
  if (has('DATABASE_URL')) {
    let host = '', db = '';
    try {
      const u = new URL(val('DATABASE_URL'));
      host = u.hostname;
      db = u.pathname.replace('/', '');
    } catch { /* skip */ }
    integrations.push({
      category: 'database',
      icon: '🗄️',
      name: 'PostgreSQL',
      provider: host.includes('rlwy') ? 'Railway' : (host === 'localhost' ? 'Local' : host),
      status: 'configured',
      details: { host, database: db },
    });
  }

  // ── OpenAI ──
  if (has('OPENAI_API_KEY')) {
    integrations.push({
      category: 'ai',
      icon: '🤖',
      name: 'OpenAI',
      provider: 'OpenAI',
      status: 'configured',
      details: {
        model: val('OPENAI_MODEL') || val('AI_MODEL') || 'default',
        key: mask(val('OPENAI_API_KEY')),
      },
    });
  }

  // ── Anthropic / Claude ──
  if (has('ANTHROPIC_API_KEY')) {
    integrations.push({
      category: 'ai',
      icon: '🧠',
      name: 'Claude (Anthropic)',
      provider: 'Anthropic',
      status: 'configured',
      details: {
        model: val('ANTHROPIC_MODEL') || val('AI_MODEL') || 'default',
        key: mask(val('ANTHROPIC_API_KEY')),
      },
    });
  }

  // ── WATI WhatsApp ──
  if (has('WATI_API_URL') || has('WATI_TOKEN')) {
    const apiUrl = val('WATI_API_URL');
    let accountId = '';
    try { accountId = apiUrl.match(/\/(\d+)/)?.[1] || ''; } catch {}
    integrations.push({
      category: 'whatsapp',
      icon: '💬',
      name: 'WhatsApp (WATI)',
      provider: 'WATI',
      status: has('WATI_TOKEN') ? 'configured' : 'partial',
      details: {
        accountId,
        apiUrl: apiUrl || null,
        email: val('WATI_EMAIL') || null,
      },
    });
  }

  // ── Meta WhatsApp Cloud API ──
  if (has('META_WHATSAPP_ACCESS_TOKEN') || has('META_PHONE_NUMBER_ID') || has('WHATSAPP_ACCESS_TOKEN')) {
    const token = val('META_WHATSAPP_ACCESS_TOKEN') || val('WHATSAPP_ACCESS_TOKEN');
    const phoneId = val('META_PHONE_NUMBER_ID') || val('WHATSAPP_PHONE_NUMBER_ID');
    const bizId = val('META_BUSINESS_ACCOUNT_ID') || val('WHATSAPP_BUSINESS_ACCOUNT_ID');
    integrations.push({
      category: 'whatsapp',
      icon: '💬',
      name: 'WhatsApp (Meta Cloud)',
      provider: 'Meta',
      status: token && phoneId ? 'configured' : 'partial',
      details: {
        phoneNumberId: phoneId || 'not set',
        businessAccountId: bizId || 'not set',
        hasToken: !!token,
      },
    });
  }

  // ── Telegram ──
  if (has('TELEGRAM_BOT_TOKEN')) {
    integrations.push({
      category: 'telegram',
      icon: '📨',
      name: 'Telegram Bot',
      provider: 'Telegram',
      status: enabled('TELEGRAM_ENABLED') ? 'active' : 'disabled',
      details: {
        botToken: mask(val('TELEGRAM_BOT_TOKEN')),
        allowedUsers: val('TELEGRAM_ALLOWED_USER_IDS') || null,
      },
    });
  }

  // ── Gmail (OAuth) ──
  if (has('GOOGLE_CLIENT_ID') || has('GMAIL_CLIENT_ID')) {
    const clientId = val('GOOGLE_CLIENT_ID') || val('GMAIL_CLIENT_ID');
    integrations.push({
      category: 'email',
      icon: '📧',
      name: 'Gmail (OAuth)',
      provider: 'Google',
      status: enabled('GMAIL_ENABLED', true) ? 'configured' : 'disabled',
      details: {
        clientId: clientId ? clientId.split('-')[0] + '••••' : null,
        redirectUri: val('GMAIL_REDIRECT_URI') || val('GOOGLE_REDIRECT_URI') || null,
      },
    });
  }

  // ── Gmail (Service Account / Domain-Wide) ──
  if (has('GMAIL_SERVICE_ACCOUNT_FILE') || has('GMAIL_DELEGATED_USER')) {
    const mailboxes = [];
    if (val('GMAIL_DELEGATED_USER')) mailboxes.push(val('GMAIL_DELEGATED_USER'));
    if (val('GMAIL_MAILBOX_INFO')) mailboxes.push(val('GMAIL_MAILBOX_INFO'));
    if (val('GMAIL_MAILBOX_OFFICE')) mailboxes.push(val('GMAIL_MAILBOX_OFFICE'));
    integrations.push({
      category: 'email',
      icon: '📧',
      name: 'Gmail (Service Account)',
      provider: 'Google',
      status: enabled('GMAIL_ENABLED', true) ? 'configured' : 'disabled',
      details: {
        mailboxes: mailboxes.length ? mailboxes : null,
        pollInterval: val('GMAIL_POLL_INTERVAL') || null,
      },
    });
  }

  // ── SMTP ──
  if (has('SMTP_HOST') || has('EMAIL_HOST')) {
    integrations.push({
      category: 'email',
      icon: '📧',
      name: 'SMTP Email',
      provider: val('SMTP_HOST') || val('EMAIL_HOST') || 'unknown',
      status: (has('SMTP_HOST') || has('EMAIL_HOST')) ? 'configured' : 'partial',
      details: {
        host: val('SMTP_HOST') || val('EMAIL_HOST'),
        port: val('SMTP_PORT') || val('EMAIL_PORT') || '587',
        user: val('SMTP_USER') || val('EMAIL_USER') || null,
        from: val('SMTP_FROM') || val('EMAIL_FROM') || null,
      },
    });
  }

  // ── GitHub ──
  if (has('GITHUB_TOKEN')) {
    integrations.push({
      category: 'dev',
      icon: '🐙',
      name: 'GitHub',
      provider: 'GitHub',
      status: 'configured',
      details: { token: mask(val('GITHUB_TOKEN')) },
    });
  }

  // ── Israel Post (Shipping) ──
  if (has('ISRAELPOST_SUBSCRIPTION_KEY') || has('ISRAEL_POST_API_KEY')) {
    integrations.push({
      category: 'shipping',
      icon: '📦',
      name: 'Israel Post',
      provider: 'דואר ישראל',
      status: val('ISRAELPOST_DRY_RUN') === '1' ? 'test-mode' : 'configured',
      details: {
        server: val('ISRAELPOST_BASE_URL') || null,
        partnerCode: val('ISRAELPOST_PARTNER_CODE') || null,
        dryRun: val('ISRAELPOST_DRY_RUN') === '1',
      },
    });
  }

  // ── Google Sheets ──
  if (has('GOOGLE_SHEETS_SPREADSHEET_ID') || has('SHEETS_SPREADSHEET_ID')) {
    integrations.push({
      category: 'google',
      icon: '📊',
      name: 'Google Sheets',
      provider: 'Google',
      status: 'configured',
      details: {
        spreadsheetId: mask(val('GOOGLE_SHEETS_SPREADSHEET_ID') || val('SHEETS_SPREADSHEET_ID')),
        sheetName: val('GOOGLE_SHEETS_SHEET_NAME') || val('SHEETS_SHEET_NAME') || null,
      },
    });
  }

  // ── Google Calendar ──
  if (has('GOOGLE_CALENDAR_ID') || has('GCAL_CLIENT_ID')) {
    integrations.push({
      category: 'google',
      icon: '📅',
      name: 'Google Calendar',
      provider: 'Google',
      status: 'configured',
      details: {},
    });
  }

  // ── Google Drive ──
  if (has('GOOGLE_DRIVE_FOLDER_ID') || has('GOOGLE_DRIVE_SERVICE_ACCOUNT')) {
    integrations.push({
      category: 'google', icon: '📁', name: 'Google Drive', provider: 'Google',
      status: 'configured', details: {},
    });
  }

  // ── Google Ads ──
  if (has('GOOGLE_ADS_DEVELOPER_TOKEN') || has('GOOGLE_ADS_CLIENT_ID')) {
    integrations.push({
      category: 'marketing', icon: '💰', name: 'Google Ads', provider: 'Google',
      status: has('GOOGLE_ADS_DEVELOPER_TOKEN') && has('GOOGLE_ADS_REFRESH_TOKEN') ? 'configured' : 'partial',
      details: { customerId: val('GOOGLE_ADS_CUSTOMER_ID') || null },
    });
  }

  // ── Google Merchant Center ──
  if (has('GOOGLE_MERCHANT_ID') || has('GOOGLE_MERCHANT_SERVICE_ACCOUNT')) {
    integrations.push({
      category: 'marketing', icon: '🛍️', name: 'Google Merchant Center', provider: 'Google',
      status: has('GOOGLE_MERCHANT_ID') && has('GOOGLE_MERCHANT_SERVICE_ACCOUNT') ? 'configured' : 'partial',
      details: { merchantId: val('GOOGLE_MERCHANT_ID') || null },
    });
  }

  // ── Google Analytics ──
  if (has('GA_PROPERTY_ID') || has('GA_SERVICE_ACCOUNT')) {
    integrations.push({
      category: 'marketing', icon: '📈', name: 'Google Analytics', provider: 'Google',
      status: has('GA_PROPERTY_ID') && has('GA_SERVICE_ACCOUNT') ? 'configured' : 'partial',
      details: { propertyId: val('GA_PROPERTY_ID') || null },
    });
  }

  // ── Google Search Console ──
  if (has('GSC_SITE_URL') || has('GSC_SERVICE_ACCOUNT')) {
    integrations.push({
      category: 'marketing', icon: '🔍', name: 'Google Search Console', provider: 'Google',
      status: has('GSC_SITE_URL') && has('GSC_SERVICE_ACCOUNT') ? 'configured' : 'partial',
      details: { siteUrl: val('GSC_SITE_URL') || null },
    });
  }

  // ── Google Trends ──
  if (has('GOOGLE_TRENDS_API_KEY')) {
    integrations.push({
      category: 'marketing', icon: '📊', name: 'Google Trends', provider: 'SerpAPI',
      status: 'configured',
      details: { region: val('GOOGLE_TRENDS_REGION') || 'global' },
    });
  }

  // ── Google Tag Manager ──
  if (has('GTM_CONTAINER_ID')) {
    integrations.push({
      category: 'marketing', icon: '🏷️', name: 'Google Tag Manager', provider: 'Google',
      status: 'configured',
      details: { containerId: val('GTM_CONTAINER_ID') || null },
    });
  }

  // ── Meta / Facebook / Instagram ──
  if (has('META_ACCESS_TOKEN') || has('FB_PAGE_ID') || has('INSTAGRAM_USER_ID')) {
    integrations.push({
      category: 'social',
      icon: '📱',
      name: 'Meta (FB/IG)',
      provider: 'Meta',
      status: (has('META_ACCESS_TOKEN') || has('FB_ACCESS_TOKEN')) ? 'configured' : 'partial',
      details: {
        fbPageId: val('FB_PAGE_ID') || 'not set',
        igUserId: val('INSTAGRAM_USER_ID') || 'not set',
        hasToken: !!(val('META_ACCESS_TOKEN') || val('FB_ACCESS_TOKEN')),
      },
    });
  }

  // ── Box.com ──
  if (has('BOX_CLIENT_ID') || has('BOX_CLIENT_SECRET')) {
    integrations.push({
      category: 'storage',
      icon: '💾',
      name: 'Box.com',
      provider: 'Box',
      status: has('BOX_CLIENT_ID') && has('BOX_CLIENT_SECRET') ? 'configured' : 'partial',
      details: {},
    });
  }

  // ── Konimbo (E-commerce) ──
  if (has('KONIMBO_API_TOKEN') || has('KONIMBO_STORE_ID')) {
    integrations.push({
      category: 'ecommerce',
      icon: '🛒',
      name: 'Konimbo',
      provider: 'Konimbo',
      status: has('KONIMBO_API_TOKEN') ? 'configured' : 'partial',
      details: {
        storeId: val('KONIMBO_STORE_ID') || 'not set',
      },
    });
  }

  // ── Stripe ──
  if (has('STRIPE_SECRET_KEY') || has('STRIPE_PUBLISHABLE_KEY')) {
    integrations.push({
      category: 'payment',
      icon: '💳',
      name: 'Stripe',
      provider: 'Stripe',
      status: 'configured',
      details: { key: mask(val('STRIPE_SECRET_KEY') || val('STRIPE_PUBLISHABLE_KEY')) },
    });
  }

  // ── Home Assistant ──
  if (has('HASS_URL') || has('HASS_TOKEN') || has('HOME_ASSISTANT_URL')) {
    integrations.push({
      category: 'smarthome',
      icon: '\u{1F3E0}',
      name: 'Home Assistant',
      provider: 'Home Assistant',
      status: (has('HASS_TOKEN') || has('HOME_ASSISTANT_TOKEN')) ? 'configured' : 'partial',
      details: {
        url: val('HASS_URL') || val('HOME_ASSISTANT_URL') || null,
      },
    });
  }

  // ── SmartThings ──
  if (has('SMARTTHINGS_TOKEN') || has('SMARTTHINGS_API_KEY')) {
    integrations.push({
      category: 'smarthome',
      icon: '\u{1F4F1}',
      name: 'SmartThings',
      provider: 'Samsung',
      status: 'configured',
      details: {
        token: mask(val('SMARTTHINGS_TOKEN') || val('SMARTTHINGS_API_KEY')),
      },
    });
  }

  // ── PalGate ──
  if (has('PALGATE_TOKEN') || has('PALGATE_DEVICE_ID')) {
    integrations.push({
      category: 'smarthome',
      icon: '\u{1F6AA}',
      name: 'PalGate',
      provider: 'PalGate',
      status: has('PALGATE_TOKEN') ? 'configured' : 'partial',
      details: {
        deviceId: val('PALGATE_DEVICE_ID') || null,
      },
    });
  }

  // ── HEOS ──
  if (has('HEOS_HOST') || has('HEOS_PORT')) {
    integrations.push({
      category: 'smarthome',
      icon: '\u{1F50A}',
      name: 'HEOS',
      provider: 'Denon',
      status: has('HEOS_HOST') ? 'configured' : 'partial',
      details: {
        host: val('HEOS_HOST') || null,
        port: val('HEOS_PORT') || '1255',
      },
    });
  }

  // ── SwitchBee ──
  if (has('SWITCHBEE_IP')) {
    integrations.push({
      category: 'smarthome',
      icon: '💡',
      name: 'SwitchBee',
      provider: 'SwitchBee',
      status: has('SWITCHBEE_USER') && has('SWITCHBEE_PASS') ? 'configured' : 'partial',
      details: { ip: val('SWITCHBEE_IP'), user: val('SWITCHBEE_USER') || null },
    });
  }

  // ── SendGrid ──
  if (has('SENDGRID_API_KEY')) {
    integrations.push({
      category: 'email',
      icon: '📧',
      name: 'SendGrid',
      provider: 'SendGrid',
      status: 'configured',
      details: { from: val('SENDGRID_FROM_EMAIL') || null },
    });
  }

  return integrations;
}

/* ── Main export ── */
export function scanAllIntegrations(projects) {
  return projects.map(p => {
    const env = parseEnv(p.cwd);
    const integrations = detectIntegrations(env);
    return {
      id: p.id,
      name: p.name,
      port: p.port,
      color: p.color,
      logo: p.logo,
      integrations,
    };
  });
}
