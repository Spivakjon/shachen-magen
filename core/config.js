import 'dotenv/config';

export const config = {
  name: 'שכן מגן',
  port: parseInt(process.env.PORT) || 3011,
  timezone: process.env.TIMEZONE || 'Asia/Jerusalem',
  dryRun: (process.env.DRY_RUN || '1') === '1',
  admin: {
    secret: process.env.ADMIN_SECRET || '',
  },
  push: {
    publicKey:  process.env.VAPID_PUBLIC_KEY  || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    email:      process.env.VAPID_EMAIL       || 'mailto:admin@magen-shachen.co.il',
  },
  googleMapsKey: process.env.GOOGLE_MAPS_KEY || '',
  alerts: {
    monitoredCities: (process.env.MONITORED_CITIES || 'תל מונד').split(',').map(s => s.trim()),
    pollInterval: parseInt(process.env.ALERT_POLL_INTERVAL) || 3000,
    autoDeactivateMinutes: parseInt(process.env.ALERT_AUTO_DEACTIVATE_MIN) || 10,
  },
};
