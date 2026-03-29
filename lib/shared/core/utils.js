// shared-dashboard/lib/core/utils.js
// Shared utility functions

export function asString(v) {
  return (v ?? '').toString().trim();
}

export function normalizePhone(phone) {
  const d = asString(phone).replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('972')) return d;
  if (d.startsWith('0')) return '972' + d.slice(1);
  return '972' + d;
}

// Alias for backward compatibility (kikkaboo uses this name)
export const normalizePhoneIL = normalizePhone;

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function truncate(str, maxLen = 200) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}
