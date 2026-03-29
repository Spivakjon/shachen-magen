// services/sms.js — SMS sending via multiple providers
import { logger } from '../core/logger.js';

const SMS4FREE_URL = 'https://api.sms4free.co.il/ApiSMS/SendSMS';

/**
 * Send SMS via configured provider.
 * Tries SMS4Free first, falls back to Textbelt (free tier).
 */
export async function sendSMS(phone, message) {
  // Format phone for international
  let intlPhone = phone;
  if (intlPhone.startsWith('0')) intlPhone = '+972' + intlPhone.slice(1);

  // Try SMS4Free if configured
  if (process.env.SMS4FREE_KEY) {
    try {
      const result = await sendViaSMS4Free(phone, message);
      if (result.success) return result;
    } catch (err) {
      logger.warn({ err: err.message }, 'SMS4Free failed, trying fallback');
    }
  }

  // Fallback: Textbelt free (1 SMS/day in free tier, good for testing)
  try {
    const result = await sendViaTextbelt(intlPhone, message);
    return result;
  } catch (err) {
    logger.error({ err: err.message, phone }, 'All SMS providers failed');
    return { success: false, error: 'SMS sending failed' };
  }
}

/**
 * SMS4Free — Israeli provider
 * Register at: https://www.sms4free.co.il
 * Set SMS4FREE_KEY, SMS4FREE_USER, SMS4FREE_PASS in .env
 */
async function sendViaSMS4Free(phone, message) {
  const res = await fetch(SMS4FREE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: process.env.SMS4FREE_KEY,
      user: process.env.SMS4FREE_USER,
      pass: process.env.SMS4FREE_PASS,
      sender: process.env.SMS4FREE_SENDER || 'ShachenM',
      recipient: phone,
      msg: message,
    }),
  });

  const status = await res.text();
  // SMS4Free returns positive number on success, negative on error
  const code = parseInt(status);
  if (code > 0) {
    logger.info({ phone, provider: 'sms4free' }, 'SMS sent');
    return { success: true, provider: 'sms4free', messageId: status };
  }
  throw new Error(`SMS4Free error: ${status}`);
}

/**
 * Textbelt — free tier (1 SMS/day, for testing only)
 * No registration needed.
 * Paid: $0.01/SMS with API key from textbelt.com
 */
async function sendViaTextbelt(phone, message) {
  const apiKey = process.env.TEXTBELT_KEY || 'textbelt'; // 'textbelt' = free tier

  const res = await fetch('https://textbelt.com/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone,
      message,
      key: apiKey,
    }),
  });

  const data = await res.json();
  if (data.success) {
    logger.info({ phone, provider: 'textbelt' }, 'SMS sent');
    return { success: true, provider: 'textbelt', quotaRemaining: data.quotaRemaining };
  }
  throw new Error(`Textbelt error: ${data.error}`);
}
