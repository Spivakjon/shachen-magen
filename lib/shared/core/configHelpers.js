// shared-dashboard/lib/core/configHelpers.js
// Shared config helper functions for reading environment variables

export const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
};

export const optional = (key, def = '') => {
  const v = process.env[key];
  return (v === undefined || v === null || v === '') ? def : v;
};

export const asBool = (v, def = false) => {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
};
