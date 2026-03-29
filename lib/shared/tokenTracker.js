// shared-dashboard/lib/tokenTracker.js
// In-memory token usage tracker for AI API calls
// Projects import trackTokens() and call it after each API request.
// getTokenStats() returns accumulated usage for the dashboard.

let currentDay = new Date().toDateString();

const usage = {
  today:   { prompt: 0, completion: 0, total: 0, requests: 0 },
  allTime: { prompt: 0, completion: 0, total: 0, requests: 0 },
};

function resetDayIfNeeded() {
  const today = new Date().toDateString();
  if (today !== currentDay) {
    currentDay = today;
    usage.today = { prompt: 0, completion: 0, total: 0, requests: 0 };
  }
}

/**
 * Track token consumption from an AI API response.
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @param {string} [model] — model name (e.g. 'gpt-4o')
 */
export function trackTokens(promptTokens, completionTokens, model) {
  resetDayIfNeeded();
  const p = promptTokens || 0;
  const c = completionTokens || 0;
  const t = p + c;

  usage.today.prompt += p;
  usage.today.completion += c;
  usage.today.total += t;
  usage.today.requests += 1;

  usage.allTime.prompt += p;
  usage.allTime.completion += c;
  usage.allTime.total += t;
  usage.allTime.requests += 1;

  if (model) usage.model = model;
}

/**
 * Get current token usage stats.
 * @returns {{ today, allTime, model, ts }}
 */
export function getTokenStats() {
  resetDayIfNeeded();
  return {
    today:   { ...usage.today },
    allTime: { ...usage.allTime },
    model:   usage.model || null,
    ts:      Date.now(),
  };
}

/**
 * Reset all counters.
 */
export function resetTokenStats() {
  usage.today   = { prompt: 0, completion: 0, total: 0, requests: 0 };
  usage.allTime = { prompt: 0, completion: 0, total: 0, requests: 0 };
  delete usage.model;
}
