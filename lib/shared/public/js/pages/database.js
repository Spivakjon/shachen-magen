/**
 * Database Page — "דאטה-בייס"
 *
 * Full DB browser: table list + schema view + data browsing with pagination.
 * Features: AI query, CSV export, global search, DB analyze, collect context.
 *
 * Shared-dashboard version — call configure() before render().
 */

// ── Portable esc() — falls back to safe DOM-based escaping ──
let esc = (s) => { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; };
try { const m = await import('/shared/js/dashboard-core.js'); if (m.esc) esc = m.esc; } catch {}

// ── Configuration ──
const _config = {
  apiPrefix: '/api/database',
};

export function configure(opts = {}) {
  if (opts.apiPrefix) _config.apiPrefix = opts.apiPrefix;
}

let _tables = [];
let _search = '';
let _selectedTable = null; // { name, columns, rowCount }
let _viewMode = 'schema'; // 'schema' | 'data'
let _rows = [];
let _rowsTotal = 0;
let _rowsLimit = 50;
let _rowsOffset = 0;
let _sortCol = '';
let _sortDir = 'asc';
let _loadingRows = false;

// ── Modal state ──
let _modal = { table: null, rows: [], total: 0, limit: 100, offset: 0, sortCol: '', sortDir: 'asc', loading: false };

// ── AI state ──
let _aiEnabled = false;
let _aiOpen = false;
let _aiHistory = []; // [{ role: 'user'|'ai', question?, sql?, columns?, rows?, error? }]
let _aiLoading = false;

// ── Global search state ──
let _globalSearchResults = null; // null = hidden, [] = no results, [...] = results
let _globalSearchQuery = '';
let _globalSearchLoading = false;

// ── Analyze state ──
let _analyzeEnabled = false;
let _analyzeLoading = false;
let _analyzeResult = null; // null = hidden, object = analysis result

// ── Collect context state ──
let _collectEnabled = false;
let _collectLoading = false;

// ── Public API ──

export function render(container) {
  container.innerHTML = `
    <style>
      /* ── Stats ── */
      .db-stats {
        display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap;
      }
      .db-stat-card {
        background: var(--bg-card); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 14px 22px;
        display: flex; flex-direction: column; align-items: center; gap: 2px;
      }
      .db-stat-value { font-size: 1.6rem; font-weight: 700; color: var(--accent); }
      .db-stat-label { font-size: 0.8rem; color: var(--text-secondary); }

      /* ── Table filter search ── */
      .db-search { margin-bottom: 16px; }
      .db-search input {
        padding: 8px 14px; border-radius: 6px; border: 1px solid var(--border);
        background: var(--bg-card); color: var(--text-primary); font-size: 0.9rem;
        min-width: 280px;
      }

      /* ── Grid (table list) ── */
      .db-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
        gap: 10px;
      }
      .db-table-btn {
        background: var(--bg-card); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 12px 16px;
        cursor: pointer; display: flex; flex-direction: column; gap: 6px;
        color: var(--text-primary); font-size: 0.92rem; font-weight: 600;
        transition: border-color 0.15s, background 0.15s; text-align: right;
      }
      .db-table-btn-top {
        display: flex; align-items: center; gap: 10px; width: 100%;
      }
      .db-table-btn:hover { border-color: var(--accent); background: var(--bg-hover); }
      .db-table-btn .db-badge {
        margin-right: auto; padding: 2px 10px; border-radius: 10px;
        font-size: 0.75rem; font-weight: 600;
        background: var(--accent); color: #000;
      }
      .db-table-btn .db-cols-hint {
        font-size: 0.75rem; color: var(--text-secondary); font-weight: 400;
      }

      /* ── Card actions row ── */
      .db-card-actions {
        display: flex; gap: 6px; align-items: center; margin-top: 4px;
      }

      /* ── Detail panel ── */
      .db-detail {
        background: var(--bg-card); border: 1px solid var(--border);
        border-radius: var(--radius); overflow: hidden;
      }
      .db-detail-header {
        display: flex; align-items: center; gap: 12px; padding: 14px 18px;
        border-bottom: 1px solid var(--border); flex-wrap: wrap;
      }
      .db-back-btn {
        background: none; border: 1px solid var(--border); border-radius: 6px;
        color: var(--text-primary); padding: 5px 12px; cursor: pointer;
        font-size: 0.85rem;
      }
      .db-back-btn:hover { background: var(--bg-hover); }
      .db-detail-title { font-size: 1.1rem; font-weight: 700; color: var(--text-primary); }
      .db-detail-meta { font-size: 0.8rem; color: var(--text-secondary); }

      /* ── Tabs ── */
      .db-tabs {
        display: flex; gap: 0; border-bottom: 1px solid var(--border);
      }
      .db-tab {
        padding: 10px 22px; cursor: pointer; font-size: 0.88rem; font-weight: 600;
        color: var(--text-secondary); border-bottom: 2px solid transparent;
        background: none; border-top: none; border-left: none; border-right: none;
        transition: color 0.15s, border-color 0.15s;
      }
      .db-tab:hover { color: var(--text-primary); }
      .db-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

      /* ── Schema table ── */
      .db-schema-wrap { padding: 0; }
      .db-schema-table {
        width: 100%; border-collapse: collapse; font-size: 0.82rem;
      }
      .db-schema-table thead { background: var(--bg-hover); }
      .db-schema-table th {
        padding: 8px 14px; text-align: right; font-weight: 600;
        color: var(--text-secondary); font-size: 0.75rem;
        border-bottom: 1px solid var(--border);
      }
      .db-schema-table td {
        padding: 7px 14px; border-bottom: 1px solid var(--border);
        color: var(--text-primary);
      }
      .db-schema-table tr:last-child td { border-bottom: none; }
      .db-type { color: #f6ad55; font-family: monospace; font-size: 0.82rem; direction: ltr; }
      .db-default-val {
        color: var(--text-secondary); font-family: monospace; font-size: 0.78rem;
        max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        direction: ltr;
      }

      /* ── Data table ── */
      .db-data-wrap { overflow: auto; max-height: 62vh; }
      .db-data-table {
        width: 100%; border-collapse: collapse; font-size: 0.8rem;
        white-space: nowrap;
      }
      .db-data-table thead { background: var(--bg-hover); position: sticky; top: 0; z-index: 2; }
      .db-data-table th {
        padding: 8px 12px; text-align: right; font-weight: 600;
        color: var(--text-secondary); font-size: 0.75rem;
        border-bottom: 2px solid var(--border); cursor: pointer;
        user-select: none; position: relative;
      }
      .db-data-table th:hover { color: var(--accent); }
      .db-data-table th .db-sort-arrow {
        font-size: 0.65rem; margin-right: 4px; color: var(--accent);
      }
      .db-data-table td {
        padding: 6px 12px; border-bottom: 1px solid var(--border);
        color: var(--text-primary); max-width: 300px;
        overflow: hidden; text-overflow: ellipsis; direction: ltr; text-align: right;
      }
      .db-data-table tr:hover td { background: var(--bg-hover); }
      .db-null-val { color: var(--text-secondary); font-style: italic; }

      /* ── Pagination ── */
      .db-pagination {
        display: flex; align-items: center; justify-content: center;
        gap: 12px; padding: 12px 18px; border-top: 1px solid var(--border);
        flex-wrap: wrap;
      }
      .db-page-btn {
        background: var(--bg-hover); border: 1px solid var(--border); border-radius: 6px;
        color: var(--text-primary); padding: 5px 14px; cursor: pointer;
        font-size: 0.82rem;
      }
      .db-page-btn:hover:not(:disabled) { border-color: var(--accent); }
      .db-page-btn:disabled { opacity: 0.4; cursor: default; }
      .db-page-info { font-size: 0.82rem; color: var(--text-secondary); }

      /* ── Consumer tags ── */
      .db-consumers {
        display: flex; gap: 5px; flex-wrap: wrap; margin-top: 6px;
      }
      .db-tag {
        padding: 1px 8px; border-radius: 8px; font-size: 0.68rem; font-weight: 600;
        white-space: nowrap;
      }
      .db-tag-tab {
        background: rgba(0, 212, 255, 0.15); color: #00d4ff; border: 1px solid rgba(0, 212, 255, 0.3);
      }
      .db-tag-agent {
        background: rgba(246, 173, 85, 0.15); color: #f6ad55; border: 1px solid rgba(246, 173, 85, 0.3);
      }
      .db-tag-skill {
        background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3);
      }
      .db-tag-none {
        background: rgba(255, 255, 255, 0.05); color: var(--text-secondary);
        border: 1px solid var(--border); font-style: italic;
      }
      .db-detail-consumers {
        display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
      }
      .db-detail-consumers .db-tag { font-size: 0.75rem; padding: 2px 10px; }

      /* ── View-table button ── */
      .db-view-btn {
        padding: 3px 12px; border-radius: 6px; font-size: 0.72rem; font-weight: 600;
        background: rgba(0, 212, 255, 0.1); color: var(--accent);
        border: 1px solid rgba(0, 212, 255, 0.3); cursor: pointer;
        transition: background 0.15s;
      }
      .db-view-btn:hover { background: rgba(0, 212, 255, 0.25); }

      /* ── CSV export button ── */
      .db-csv-btn {
        padding: 3px 12px; border-radius: 6px; font-size: 0.72rem; font-weight: 600;
        background: rgba(72, 187, 120, 0.1); color: #48bb78;
        border: 1px solid rgba(72, 187, 120, 0.3); cursor: pointer;
        transition: background 0.15s; text-decoration: none; display: inline-block;
      }
      .db-csv-btn:hover { background: rgba(72, 187, 120, 0.25); }

      /* ── Modal overlay ── */
      .dbm-overlay {
        position: fixed; inset: 0; z-index: 9000;
        background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        animation: dbm-fade-in 0.15s ease-out;
      }
      @keyframes dbm-fade-in { from { opacity: 0; } to { opacity: 1; } }

      .dbm-dialog {
        background: var(--bg-page, #0d1117); border: 1px solid var(--border);
        border-radius: 12px; width: 96vw; height: 92vh;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      }

      /* ── Modal header ── */
      .dbm-header {
        display: flex; align-items: center; gap: 14px; padding: 14px 20px;
        border-bottom: 1px solid var(--border); flex-shrink: 0;
      }
      .dbm-title { font-size: 1.1rem; font-weight: 700; color: var(--text-primary); }
      .dbm-meta { font-size: 0.8rem; color: var(--text-secondary); }
      .dbm-close {
        margin-right: auto; background: none; border: 1px solid var(--border);
        border-radius: 6px; color: var(--text-primary); padding: 5px 14px;
        cursor: pointer; font-size: 0.85rem;
      }
      .dbm-close:hover { background: var(--bg-hover); border-color: #f44; color: #f66; }

      /* ── Modal table ── */
      .dbm-body { flex: 1; overflow: auto; position: relative; }
      .dbm-table {
        width: 100%; border-collapse: collapse; font-size: 0.8rem;
        white-space: nowrap;
      }
      .dbm-table thead {
        background: var(--bg-card, #161b22); position: sticky; top: 0; z-index: 2;
      }
      .dbm-table th {
        padding: 9px 14px; text-align: right; font-weight: 600;
        color: var(--accent); font-size: 0.75rem;
        border-bottom: 2px solid var(--border); cursor: pointer;
        user-select: none;
      }
      .dbm-table th:hover { background: var(--bg-hover); }
      .dbm-table th .dbm-arrow { font-size: 0.65rem; margin-right: 4px; }
      .dbm-table td {
        padding: 7px 14px; border-bottom: 1px solid var(--border);
        color: var(--text-primary); max-width: 350px;
        overflow: hidden; text-overflow: ellipsis; direction: ltr; text-align: right;
      }
      .dbm-table tr:hover td { background: var(--bg-hover); }
      .dbm-table .dbm-row-num {
        color: var(--text-secondary); font-size: 0.7rem; text-align: center;
        min-width: 40px; border-left: 1px solid var(--border);
        background: var(--bg-card, #161b22);
      }
      .dbm-table thead .dbm-row-num { cursor: default; }
      .dbm-null { color: var(--text-secondary); font-style: italic; }

      /* ── Modal footer / pagination ── */
      .dbm-footer {
        display: flex; align-items: center; justify-content: center;
        gap: 14px; padding: 10px 20px; border-top: 1px solid var(--border);
        flex-shrink: 0; flex-wrap: wrap;
      }
      .dbm-page-btn {
        background: var(--bg-hover); border: 1px solid var(--border); border-radius: 6px;
        color: var(--text-primary); padding: 5px 16px; cursor: pointer; font-size: 0.82rem;
      }
      .dbm-page-btn:hover:not(:disabled) { border-color: var(--accent); }
      .dbm-page-btn:disabled { opacity: 0.4; cursor: default; }
      .dbm-page-info { font-size: 0.82rem; color: var(--text-secondary); }
      .dbm-loading { text-align: center; padding: 60px; color: var(--text-secondary); font-size: 0.9rem; }

      /* ── AI Panel ── */
      .db-ai-wrap {
        margin-bottom: 16px;
      }
      .db-ai-toggle {
        background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.3);
        border-radius: 8px; padding: 8px 18px; cursor: pointer;
        color: #c084fc; font-size: 0.88rem; font-weight: 600;
        transition: background 0.15s;
      }
      .db-ai-toggle:hover { background: rgba(168, 85, 247, 0.2); }
      .db-ai-toggle.active {
        border-radius: 8px 8px 0 0; border-bottom: none;
      }
      .db-ai-panel {
        background: var(--bg-card); border: 1px solid rgba(168, 85, 247, 0.3);
        border-top: none; border-radius: 0 0 8px 8px; padding: 14px 18px;
      }
      .db-ai-input-row {
        display: flex; gap: 8px; margin-bottom: 10px;
      }
      .db-ai-input {
        flex: 1; padding: 8px 14px; border-radius: 6px;
        border: 1px solid var(--border); background: var(--bg-page, #0d1117);
        color: var(--text-primary); font-size: 0.88rem;
      }
      .db-ai-input::placeholder { color: var(--text-secondary); }
      .db-ai-send {
        padding: 8px 18px; border-radius: 6px; border: 1px solid rgba(168, 85, 247, 0.3);
        background: rgba(168, 85, 247, 0.15); color: #c084fc;
        font-weight: 600; cursor: pointer; font-size: 0.85rem;
        transition: background 0.15s;
      }
      .db-ai-send:hover { background: rgba(168, 85, 247, 0.3); }
      .db-ai-send:disabled { opacity: 0.4; cursor: default; }
      .db-ai-history {
        max-height: 400px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px;
      }
      .db-ai-msg {
        border-radius: 8px; padding: 10px 14px; font-size: 0.84rem;
      }
      .db-ai-msg-user {
        background: rgba(168, 85, 247, 0.08); border: 1px solid rgba(168, 85, 247, 0.2);
        color: #c084fc; align-self: flex-end; max-width: 80%;
      }
      .db-ai-msg-ai {
        background: var(--bg-hover); border: 1px solid var(--border);
      }
      .db-ai-sql {
        background: #0d1117; border: 1px solid var(--border); border-radius: 6px;
        padding: 8px 12px; margin: 6px 0; font-family: monospace; font-size: 0.78rem;
        color: #79c0ff; direction: ltr; text-align: left; overflow-x: auto;
        white-space: pre-wrap; word-break: break-all;
      }
      .db-ai-error {
        color: #f87171; font-size: 0.82rem; margin-top: 4px;
      }
      .db-ai-result-table {
        width: 100%; border-collapse: collapse; font-size: 0.78rem;
        margin-top: 8px; white-space: nowrap;
      }
      .db-ai-result-table thead { background: var(--bg-card); }
      .db-ai-result-table th {
        padding: 5px 10px; text-align: right; font-weight: 600;
        color: var(--accent); font-size: 0.72rem;
        border-bottom: 1px solid var(--border);
      }
      .db-ai-result-table td {
        padding: 4px 10px; border-bottom: 1px solid var(--border);
        color: var(--text-primary); max-width: 250px;
        overflow: hidden; text-overflow: ellipsis; direction: ltr; text-align: right;
      }
      .db-ai-result-wrap {
        max-height: 200px; overflow: auto; border: 1px solid var(--border);
        border-radius: 6px; margin-top: 6px;
      }
      .db-ai-row-count {
        font-size: 0.72rem; color: var(--text-secondary); margin-top: 4px;
      }
      .db-ai-loading {
        color: var(--text-secondary); font-size: 0.82rem; padding: 8px 0;
      }

      /* ── Global Search ── */
      .db-global-search {
        margin-bottom: 16px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      }
      .db-global-input {
        padding: 8px 14px; border-radius: 6px; border: 1px solid var(--border);
        background: var(--bg-card); color: var(--text-primary); font-size: 0.88rem;
        min-width: 300px;
      }
      .db-global-input::placeholder { color: var(--text-secondary); }
      .db-global-btn {
        padding: 8px 18px; border-radius: 6px; border: 1px solid var(--accent);
        background: rgba(0, 212, 255, 0.1); color: var(--accent);
        font-weight: 600; cursor: pointer; font-size: 0.85rem;
        transition: background 0.15s;
      }
      .db-global-btn:hover { background: rgba(0, 212, 255, 0.2); }
      .db-global-btn:disabled { opacity: 0.4; cursor: default; }
      .db-global-close {
        background: none; border: 1px solid var(--border); border-radius: 6px;
        color: var(--text-secondary); padding: 5px 12px; cursor: pointer;
        font-size: 0.85rem;
      }
      .db-global-close:hover { background: var(--bg-hover); color: #f66; }
      .db-global-results {
        margin-bottom: 16px; background: var(--bg-card);
        border: 1px solid var(--accent); border-radius: 8px;
        overflow: hidden;
      }
      .db-global-group {
        border-bottom: 1px solid var(--border);
      }
      .db-global-group:last-child { border-bottom: none; }
      .db-global-group-header {
        display: flex; align-items: center; gap: 10px; padding: 10px 16px;
        background: var(--bg-hover); cursor: pointer;
      }
      .db-global-group-header:hover { background: rgba(0, 212, 255, 0.08); }
      .db-global-table-name {
        font-weight: 700; color: var(--accent); font-size: 0.88rem;
      }
      .db-global-match-info {
        font-size: 0.75rem; color: var(--text-secondary);
      }
      .db-global-cols {
        font-size: 0.72rem; color: #f6ad55; margin-right: auto;
      }
      .db-global-preview {
        padding: 0; overflow-x: auto;
      }
      .db-global-preview table {
        width: 100%; border-collapse: collapse; font-size: 0.78rem;
        white-space: nowrap;
      }
      .db-global-preview th {
        padding: 5px 10px; text-align: right; font-weight: 600;
        color: var(--text-secondary); font-size: 0.7rem;
        border-bottom: 1px solid var(--border); background: var(--bg-card);
      }
      .db-global-preview td {
        padding: 4px 10px; border-bottom: 1px solid var(--border);
        color: var(--text-primary); max-width: 200px;
        overflow: hidden; text-overflow: ellipsis; direction: ltr; text-align: right;
      }
      .db-global-highlight {
        background: rgba(0, 212, 255, 0.2); border-radius: 2px;
        padding: 0 2px;
      }
      .db-global-no-results {
        padding: 16px; text-align: center; color: var(--text-secondary); font-size: 0.85rem;
      }
      .db-global-loading {
        padding: 16px; text-align: center; color: var(--text-secondary); font-size: 0.85rem;
      }

      /* ── Misc ── */
      .db-empty { text-align: center; padding: 40px; color: var(--text-secondary); font-size: 0.9rem; }
      .db-loading { text-align: center; padding: 60px; color: var(--text-secondary); }
      .db-data-loading { text-align: center; padding: 30px; color: var(--text-secondary); font-size: 0.85rem; }

      /* ── Analyze Panel ── */
      .db-analyze-btn {
        background: rgba(246, 173, 85, 0.12); border: 1px solid rgba(246, 173, 85, 0.35);
        border-radius: 8px; padding: 8px 20px; cursor: pointer;
        color: #f6ad55; font-size: 0.88rem; font-weight: 600;
        transition: background 0.15s; display: inline-flex; align-items: center; gap: 8px;
      }
      .db-analyze-btn:hover { background: rgba(246, 173, 85, 0.22); }
      .db-analyze-btn:disabled { opacity: 0.5; cursor: default; }
      .db-analyze-btn .spinner {
        display: inline-block; width: 14px; height: 14px;
        border: 2px solid rgba(246, 173, 85, 0.3); border-top-color: #f6ad55;
        border-radius: 50%; animation: db-spin 0.7s linear infinite;
      }
      @keyframes db-spin { to { transform: rotate(360deg); } }

      .db-analyze-panel {
        margin-bottom: 16px; background: var(--bg-card);
        border: 1px solid rgba(246, 173, 85, 0.35); border-radius: 10px;
        overflow: hidden; animation: dbm-fade-in 0.2s ease-out;
      }
      .db-analyze-header {
        display: flex; align-items: center; gap: 12px; padding: 12px 18px;
        border-bottom: 1px solid var(--border); background: rgba(246, 173, 85, 0.06);
      }
      .db-analyze-header-title {
        font-size: 1rem; font-weight: 700; color: #f6ad55;
      }
      .db-analyze-close {
        margin-right: auto; background: none; border: 1px solid var(--border);
        border-radius: 6px; color: var(--text-secondary); padding: 4px 12px;
        cursor: pointer; font-size: 0.82rem;
      }
      .db-analyze-close:hover { background: var(--bg-hover); color: #f66; }

      .db-analyze-section {
        border-bottom: 1px solid var(--border);
      }
      .db-analyze-section:last-child { border-bottom: none; }
      .db-analyze-section-header {
        display: flex; align-items: center; gap: 8px; padding: 10px 18px;
        cursor: pointer; user-select: none; transition: background 0.15s;
      }
      .db-analyze-section-header:hover { background: var(--bg-hover); }
      .db-analyze-section-icon {
        font-size: 0.75rem; color: var(--text-secondary); transition: transform 0.2s;
        display: inline-block;
      }
      .db-analyze-section-icon.open { transform: rotate(90deg); }
      .db-analyze-section-title {
        font-size: 0.9rem; font-weight: 600; color: var(--text-primary);
      }
      .db-analyze-section-badge {
        font-size: 0.72rem; padding: 1px 8px; border-radius: 8px;
        background: rgba(246, 173, 85, 0.15); color: #f6ad55; font-weight: 600;
      }
      .db-analyze-section-body {
        padding: 0 18px 14px 18px; font-size: 0.84rem; color: var(--text-primary);
        line-height: 1.6;
      }
      .db-analyze-summary {
        padding: 14px 18px; font-size: 0.9rem; color: var(--text-primary);
        line-height: 1.7; border-bottom: 1px solid var(--border);
        background: rgba(246, 173, 85, 0.03);
      }

      .db-analyze-table-item {
        display: flex; align-items: center; gap: 10px; padding: 6px 0;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .db-analyze-table-item:last-child { border-bottom: none; }
      .db-analyze-table-name { font-weight: 600; min-width: 160px; font-family: monospace; font-size: 0.82rem; }
      .db-analyze-table-purpose { flex: 1; color: var(--text-secondary); font-size: 0.82rem; }
      .db-analyze-table-rows { font-size: 0.75rem; color: var(--text-secondary); min-width: 70px; text-align: left; }
      .db-analyze-status {
        padding: 1px 8px; border-radius: 8px; font-size: 0.7rem; font-weight: 600;
        min-width: 50px; text-align: center;
      }
      .db-analyze-status-ok { background: rgba(72, 187, 120, 0.15); color: #48bb78; }
      .db-analyze-status-warning { background: rgba(246, 173, 85, 0.15); color: #f6ad55; }
      .db-analyze-status-unused { background: rgba(248, 113, 113, 0.15); color: #f87171; }
      .db-analyze-status-redundant { background: rgba(168, 85, 247, 0.15); color: #c084fc; }

      .db-analyze-suggestion {
        padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .db-analyze-suggestion:last-child { border-bottom: none; }
      .db-analyze-suggestion-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
      .db-analyze-priority {
        padding: 1px 8px; border-radius: 8px; font-size: 0.68rem; font-weight: 600;
      }
      .db-analyze-priority-high { background: rgba(248, 113, 113, 0.15); color: #f87171; }
      .db-analyze-priority-medium { background: rgba(246, 173, 85, 0.15); color: #f6ad55; }
      .db-analyze-priority-low { background: rgba(148, 163, 184, 0.15); color: #94a3b8; }
      .db-analyze-suggestion-reason { color: var(--text-secondary); font-size: 0.82rem; }
      .db-analyze-suggestion-tables {
        font-family: monospace; font-weight: 600; font-size: 0.84rem; color: var(--text-primary);
      }

      .db-analyze-actions {
        display: flex; gap: 8px; margin-bottom: 16px; align-items: center;
      }

      /* ── Collect Context Button ── */
      .db-collect-btn {
        background: rgba(72, 187, 120, 0.12); border: 1px solid rgba(72, 187, 120, 0.35);
        border-radius: 8px; padding: 8px 20px; cursor: pointer;
        color: #48bb78; font-size: 0.88rem; font-weight: 600;
        transition: background 0.15s; display: inline-flex; align-items: center; gap: 8px;
      }
      .db-collect-btn:hover { background: rgba(72, 187, 120, 0.22); }
      .db-collect-btn:disabled { opacity: 0.5; cursor: default; }
      .db-collect-btn .spinner {
        display: inline-block; width: 14px; height: 14px;
        border: 2px solid rgba(72, 187, 120, 0.3); border-top-color: #48bb78;
        border-radius: 50%; animation: db-spin 0.7s linear infinite;
      }

      /* ── Collect Context Modal ── */
      .db-collect-overlay {
        position: fixed; inset: 0; z-index: 9000;
        background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        animation: dbm-fade-in 0.15s ease-out;
      }
      .db-collect-dialog {
        background: var(--bg-page, #0d1117); border: 1px solid var(--border);
        border-radius: 12px; width: 90vw; max-width: 900px; height: 85vh;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      }
      .db-collect-header {
        display: flex; align-items: center; gap: 14px; padding: 14px 20px;
        border-bottom: 1px solid var(--border); flex-shrink: 0;
      }
      .db-collect-header-title {
        font-size: 1.1rem; font-weight: 700; color: #48bb78;
      }
      .db-collect-stats {
        display: flex; gap: 12px; font-size: 0.78rem; color: var(--text-secondary);
      }
      .db-collect-stats span { white-space: nowrap; }
      .db-collect-copy {
        padding: 6px 16px; border-radius: 6px; border: 1px solid rgba(72, 187, 120, 0.35);
        background: rgba(72, 187, 120, 0.12); color: #48bb78;
        font-weight: 600; cursor: pointer; font-size: 0.82rem;
        transition: background 0.15s;
      }
      .db-collect-copy:hover { background: rgba(72, 187, 120, 0.25); }
      .db-collect-copy.copied {
        background: rgba(72, 187, 120, 0.3); color: #fff;
      }
      .db-collect-close {
        margin-right: auto; background: none; border: 1px solid var(--border);
        border-radius: 6px; color: var(--text-primary); padding: 5px 14px;
        cursor: pointer; font-size: 0.85rem;
      }
      .db-collect-close:hover { background: var(--bg-hover); border-color: #f44; color: #f66; }
      .db-collect-body {
        flex: 1; overflow: auto; padding: 0;
      }
      .db-collect-body pre {
        margin: 0; padding: 18px 22px; font-size: 0.8rem; line-height: 1.6;
        color: var(--text-primary); white-space: pre-wrap; word-break: break-word;
        font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
        direction: ltr; text-align: left;
      }
      .db-collect-cache-info {
        display: flex; align-items: center; gap: 8px;
      }
      .db-collect-cache-badge {
        padding: 2px 10px; border-radius: 8px; font-size: 0.72rem; font-weight: 600;
      }
      .db-collect-cache-badge.cache {
        background: rgba(246, 173, 85, 0.15); color: #f6ad55;
        border: 1px solid rgba(246, 173, 85, 0.3);
      }
      .db-collect-cache-badge.fresh {
        background: rgba(72, 187, 120, 0.15); color: #48bb78;
        border: 1px solid rgba(72, 187, 120, 0.3);
      }
      .db-collect-scan-date {
        font-size: 0.72rem; color: var(--text-secondary);
      }
      .db-collect-rescan {
        padding: 3px 12px; border-radius: 6px; font-size: 0.72rem; font-weight: 600;
        background: rgba(0, 212, 255, 0.1); color: var(--accent);
        border: 1px solid rgba(0, 212, 255, 0.3); cursor: pointer;
        transition: background 0.15s;
      }
      .db-collect-rescan:hover { background: rgba(0, 212, 255, 0.2); }
      .db-collect-rescan:disabled { opacity: 0.4; cursor: default; }
    </style>

    <div id="db-ai-wrap" class="db-ai-wrap" style="display:none"></div>
    <div id="db-stats" class="db-stats"></div>
    <div id="db-analyze-actions" class="db-analyze-actions"></div>
    <div id="db-analyze-panel-wrap"></div>
    <div id="db-global-search-wrap" class="db-global-search">
      <input id="db-global-input" class="db-global-input" type="text" placeholder="חיפוש ערך בכל הטבלאות..." />
      <button id="db-global-btn" class="db-global-btn">חפש</button>
    </div>
    <div id="db-global-results-wrap"></div>
    <div id="db-search-wrap" class="db-search">
      <input id="db-search-input" type="text" placeholder="חיפוש טבלה..." />
    </div>
    <div id="db-content">
      <div class="db-loading">טוען מבנה דאטהבייס...</div>
    </div>
  `;

  document.getElementById('db-search-input').addEventListener('input', e => {
    _search = e.target.value.trim().toLowerCase();
    if (!_selectedTable) renderTableList();
  });

  // Global search handlers
  const globalInput = document.getElementById('db-global-input');
  const globalBtn = document.getElementById('db-global-btn');
  globalBtn.addEventListener('click', () => doGlobalSearch());
  globalInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') doGlobalSearch();
  });
}

export async function onActivate() {
  _selectedTable = null;
  _viewMode = 'schema';
  _rows = [];
  _aiHistory = [];
  _globalSearchResults = null;
  _analyzeLoading = false;
  _analyzeResult = null;
  try {
    const res = await fetch(`${_config.apiPrefix}/tables`);
    const data = await res.json();
    _tables = data.success ? data.tables : [];
    _aiEnabled = !!data.aiEnabled;
    _analyzeEnabled = !!data.analyzeEnabled;
    _collectEnabled = !!data.collectEnabled;
  } catch {
    _tables = [];
    _aiEnabled = false;
    _analyzeEnabled = false;
    _collectEnabled = false;
  }
  renderAIPanel();
  renderStats();
  renderAnalyzeButton();
  renderTableList();
}

// ══════════════════════════════════════════
// ── AI Panel ──
// ══════════════════════════════════════════

function renderAIPanel() {
  const wrap = document.getElementById('db-ai-wrap');
  if (!wrap) return;
  if (!_aiEnabled) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  wrap.innerHTML = `
    <button class="db-ai-toggle ${_aiOpen ? 'active' : ''}" id="db-ai-toggle">\u2726 שאילתת AI</button>
    ${_aiOpen ? `
      <div class="db-ai-panel">
        <div class="db-ai-input-row">
          <input class="db-ai-input" id="db-ai-input" type="text"
            placeholder="שאל שאלה על הדאטהבייס..." ${_aiLoading ? 'disabled' : ''} />
          <button class="db-ai-send" id="db-ai-send" ${_aiLoading ? 'disabled' : ''}>שלח</button>
        </div>
        <div class="db-ai-history" id="db-ai-history">
          ${_aiHistory.map(renderAIMessage).join('')}
          ${_aiLoading ? '<div class="db-ai-loading">מריץ שאילתה...</div>' : ''}
        </div>
      </div>
    ` : ''}
  `;

  document.getElementById('db-ai-toggle').addEventListener('click', () => {
    _aiOpen = !_aiOpen;
    renderAIPanel();
    if (_aiOpen) {
      setTimeout(() => document.getElementById('db-ai-input')?.focus(), 50);
    }
  });

  if (_aiOpen) {
    const input = document.getElementById('db-ai-input');
    const sendBtn = document.getElementById('db-ai-send');
    sendBtn?.addEventListener('click', () => submitAIQuery());
    input?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !_aiLoading) submitAIQuery();
    });
    // Auto-scroll history
    const hist = document.getElementById('db-ai-history');
    if (hist) hist.scrollTop = hist.scrollHeight;
  }
}

function renderAIMessage(msg) {
  if (msg.role === 'user') {
    return `<div class="db-ai-msg db-ai-msg-user">${esc(msg.question)}</div>`;
  }
  // AI response
  let html = '<div class="db-ai-msg db-ai-msg-ai">';
  if (msg.sql) {
    html += `<div class="db-ai-sql">${esc(msg.sql)}</div>`;
  }
  if (msg.error) {
    html += `<div class="db-ai-error">${esc(msg.error)}</div>`;
  }
  if (msg.columns && msg.rows && msg.rows.length > 0) {
    html += `<div class="db-ai-result-wrap"><table class="db-ai-result-table">
      <thead><tr>${msg.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${msg.rows.slice(0, 50).map(row => `<tr>${msg.columns.map(c => {
        const val = row[c];
        if (val === null || val === undefined) return '<td style="color:var(--text-secondary);font-style:italic">NULL</td>';
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
        return `<td title="${esc(str)}">${esc(str)}</td>`;
      }).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
    html += `<div class="db-ai-row-count">${msg.rows.length} שורות${msg.rows.length >= 50 ? ' (מוצגות 50 ראשונות)' : ''}</div>`;
  }
  html += '</div>';
  return html;
}

async function submitAIQuery() {
  const input = document.getElementById('db-ai-input');
  if (!input) return;
  const question = input.value.trim();
  if (!question || _aiLoading) return;

  _aiHistory.push({ role: 'user', question });
  input.value = '';
  _aiLoading = true;
  renderAIPanel();

  try {
    const res = await fetch(`${_config.apiPrefix}/ai-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();

    if (data.success) {
      _aiHistory.push({ role: 'ai', sql: data.sql, columns: data.columns, rows: data.rows });
    } else {
      _aiHistory.push({ role: 'ai', sql: data.sql, error: data.error || 'שגיאה לא ידועה' });
    }
  } catch (err) {
    _aiHistory.push({ role: 'ai', error: err.message });
  }

  _aiLoading = false;
  renderAIPanel();
}

// ══════════════════════════════════════════
// ── Global Search ──
// ══════════════════════════════════════════

async function doGlobalSearch() {
  const input = document.getElementById('db-global-input');
  if (!input) return;
  const q = input.value.trim();
  if (q.length < 2 || _globalSearchLoading) return;

  _globalSearchQuery = q;
  _globalSearchLoading = true;
  renderGlobalSearchResults();

  try {
    const res = await fetch(`${_config.apiPrefix}/search?q=${encodeURIComponent(q)}&limit=5`);
    const data = await res.json();
    _globalSearchResults = data.success ? data.results : [];
  } catch {
    _globalSearchResults = [];
  }

  _globalSearchLoading = false;
  renderGlobalSearchResults();
}

function highlightMatch(text, query) {
  if (!text || !query) return esc(text);
  const str = String(text);
  const lower = str.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return esc(str);
  const before = str.slice(0, idx);
  const match = str.slice(idx, idx + query.length);
  const after = str.slice(idx + query.length);
  return esc(before) + `<span class="db-global-highlight">${esc(match)}</span>` + esc(after);
}

function renderGlobalSearchResults() {
  const wrap = document.getElementById('db-global-results-wrap');
  if (!wrap) return;

  if (_globalSearchLoading) {
    wrap.innerHTML = `<div class="db-global-results"><div class="db-global-loading">מחפש "${esc(_globalSearchQuery)}"...</div></div>`;
    return;
  }

  if (_globalSearchResults === null) {
    wrap.innerHTML = '';
    return;
  }

  if (_globalSearchResults.length === 0) {
    wrap.innerHTML = `
      <div class="db-global-results">
        <div class="db-global-no-results">
          לא נמצאו תוצאות עבור "${esc(_globalSearchQuery)}"
          <button class="db-global-close" id="db-global-close" style="margin-right:10px">\u2715</button>
        </div>
      </div>`;
    document.getElementById('db-global-close')?.addEventListener('click', closeGlobalSearch);
    return;
  }

  const groupsHtml = _globalSearchResults.map(group => {
    const cols = group.rows.length > 0 ? Object.keys(group.rows[0]) : [];
    // Show max 6 columns for preview
    const showCols = cols.slice(0, 6);

    return `
      <div class="db-global-group">
        <div class="db-global-group-header" data-table="${esc(group.table)}">
          <span class="db-global-table-name">${esc(group.table)}</span>
          <span class="db-global-match-info">${group.matchCount} התאמות</span>
          <span class="db-global-cols">${group.matchedColumns.map(c => esc(c)).join(', ')}</span>
        </div>
        <div class="db-global-preview">
          <table>
            <thead><tr>${showCols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
            <tbody>
              ${group.rows.map(row => `<tr>${showCols.map(c => {
                const val = row[c];
                if (val === null || val === undefined) return '<td style="color:var(--text-secondary);font-style:italic">NULL</td>';
                const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
                return `<td title="${esc(str)}">${highlightMatch(str, _globalSearchQuery)}</td>`;
              }).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');

  wrap.innerHTML = `
    <div class="db-global-results">
      <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border)">
        <span style="font-weight:600;color:var(--text-primary);font-size:0.88rem">
          תוצאות חיפוש: "${esc(_globalSearchQuery)}"
        </span>
        <span style="font-size:0.78rem;color:var(--text-secondary)">
          ${_globalSearchResults.reduce((s, g) => s + g.matchCount, 0)} התאמות ב-${_globalSearchResults.length} טבלאות
        </span>
        <button class="db-global-close" id="db-global-close" style="margin-right:auto">\u2715</button>
      </div>
      ${groupsHtml}
    </div>
  `;

  document.getElementById('db-global-close')?.addEventListener('click', closeGlobalSearch);

  // Click table name to open detail
  wrap.querySelectorAll('.db-global-group-header').forEach(header => {
    header.addEventListener('click', () => {
      closeGlobalSearch();
      openTable(header.dataset.table);
    });
  });
}

function closeGlobalSearch() {
  _globalSearchResults = null;
  _globalSearchQuery = '';
  const wrap = document.getElementById('db-global-results-wrap');
  if (wrap) wrap.innerHTML = '';
  const input = document.getElementById('db-global-input');
  if (input) input.value = '';
}

// ══════════════════════════════════════════
// ── Stats ──
// ══════════════════════════════════════════

function renderStats() {
  const el = document.getElementById('db-stats');
  if (!el) return;
  const totalRows = _tables.reduce((sum, t) => sum + t.rowCount, 0);
  el.innerHTML = `
    <div class="db-stat-card">
      <span class="db-stat-value">${_tables.length}</span>
      <span class="db-stat-label">טבלאות</span>
    </div>
    <div class="db-stat-card">
      <span class="db-stat-value">${totalRows.toLocaleString('he-IL')}</span>
      <span class="db-stat-label">סה"כ רשומות</span>
    </div>
  `;
}

// ── Consumer tags helper ──

function renderConsumerTags(consumers, cssExtra = '') {
  if (!consumers) return '';
  const { tabs = [], agents = [], skills = [] } = consumers;
  if (tabs.length === 0 && agents.length === 0 && skills.length === 0) {
    return `<div class="db-consumers ${cssExtra}"><span class="db-tag db-tag-none">לא בשימוש</span></div>`;
  }
  const parts = [];
  for (const tab of tabs)     parts.push(`<span class="db-tag db-tag-tab">${esc(tab)}</span>`);
  for (const skill of skills) parts.push(`<span class="db-tag db-tag-skill">${esc(skill)}</span>`);
  for (const agent of agents)  parts.push(`<span class="db-tag db-tag-agent">${esc(agent)}</span>`);
  return `<div class="db-consumers ${cssExtra}">${parts.join('')}</div>`;
}

// ══════════════════════════════════════════
// ── Table List (grid) ──
// ══════════════════════════════════════════

function renderTableList() {
  const content = document.getElementById('db-content');
  const searchWrap = document.getElementById('db-search-wrap');
  if (!content) return;
  if (searchWrap) searchWrap.style.display = '';

  const filtered = _search
    ? _tables.filter(t => t.name.includes(_search))
    : _tables;

  if (filtered.length === 0) {
    content.innerHTML = `<div class="db-empty">${_search ? 'לא נמצאו טבלאות תואמות' : 'אין טבלאות'}</div>`;
    return;
  }

  content.innerHTML = `<div class="db-grid">
    ${filtered.map(t => `
      <div class="db-table-btn" data-table="${esc(t.name)}">
        <div class="db-table-btn-top">
          ${esc(t.name)}
          <span class="db-cols-hint">${t.columns.length} עמודות</span>
          <span class="db-badge">${t.rowCount.toLocaleString('he-IL')} שורות</span>
        </div>
        ${renderConsumerTags(t.consumers)}
        <div class="db-card-actions">
          ${t.rowCount > 0 ? `<button class="db-view-btn" data-view="${esc(t.name)}">הצג DB בטבלה</button>` : ''}
          ${t.rowCount > 0 ? `<a class="db-csv-btn" href="${_config.apiPrefix}/tables/${encodeURIComponent(t.name)}/export" download>\u2B07 CSV</a>` : ''}
        </div>
      </div>
    `).join('')}
  </div>`;

  content.querySelectorAll('.db-table-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('.db-view-btn') || e.target.closest('.db-csv-btn')) return;
      openTable(btn.dataset.table);
    });
  });
  content.querySelectorAll('.db-view-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTableModal(btn.dataset.view);
    });
  });
}

// ══════════════════════════════════════════
// ── Open Table Detail ──
// ══════════════════════════════════════════

function openTable(name) {
  const table = _tables.find(t => t.name === name);
  if (!table) return;
  _selectedTable = table;
  _viewMode = 'schema';
  _rows = [];
  _rowsOffset = 0;
  _sortCol = '';
  _sortDir = 'asc';
  renderDetail();
}

function renderDetail() {
  const content = document.getElementById('db-content');
  const searchWrap = document.getElementById('db-search-wrap');
  if (!content || !_selectedTable) return;
  if (searchWrap) searchWrap.style.display = 'none';

  const t = _selectedTable;

  content.innerHTML = `
    <div class="db-detail">
      <div class="db-detail-header">
        <button class="db-back-btn" id="db-back">חזרה לרשימה</button>
        <span class="db-detail-title">${esc(t.name)}</span>
        <span class="db-detail-meta">${t.columns.length} עמודות &middot; ${t.rowCount.toLocaleString('he-IL')} שורות</span>
        ${t.rowCount > 0 ? `<button class="db-view-btn" id="db-detail-view">הצג DB בטבלה</button>` : ''}
        ${t.rowCount > 0 ? `<a class="db-csv-btn" href="${_config.apiPrefix}/tables/${encodeURIComponent(t.name)}/export" download>\u2B07 CSV</a>` : ''}
        ${renderConsumerTags(t.consumers, 'db-detail-consumers')}
      </div>
      <div class="db-tabs">
        <button class="db-tab ${_viewMode === 'schema' ? 'active' : ''}" data-mode="schema">מבנה</button>
        <button class="db-tab ${_viewMode === 'data' ? 'active' : ''}" data-mode="data">נתונים</button>
      </div>
      <div id="db-tab-content"></div>
    </div>
  `;

  document.getElementById('db-back').addEventListener('click', () => {
    _selectedTable = null;
    renderTableList();
  });
  document.getElementById('db-detail-view')?.addEventListener('click', () => {
    openTableModal(t.name);
  });

  content.querySelectorAll('.db-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _viewMode = tab.dataset.mode;
      content.querySelectorAll('.db-tab').forEach(t2 => t2.classList.toggle('active', t2.dataset.mode === _viewMode));
      renderTabContent();
    });
  });

  renderTabContent();
}

function renderTabContent() {
  if (_viewMode === 'schema') renderSchemaTab();
  else loadAndRenderData();
}

// ── Schema Tab ──

function renderSchemaTab() {
  const el = document.getElementById('db-tab-content');
  if (!el || !_selectedTable) return;

  el.innerHTML = `
    <div class="db-schema-wrap">
      <table class="db-schema-table">
        <thead>
          <tr>
            <th>#</th>
            <th>שם עמודה</th>
            <th>טיפוס</th>
            <th>Nullable</th>
            <th>ברירת מחדל</th>
          </tr>
        </thead>
        <tbody>
          ${_selectedTable.columns.map((c, i) => `
            <tr>
              <td style="color:var(--text-secondary)">${i + 1}</td>
              <td><strong>${esc(c.name)}</strong></td>
              <td class="db-type">${esc(c.type)}</td>
              <td style="color:var(--text-secondary)">${c.nullable ? 'כן' : 'לא'}</td>
              <td class="db-default-val" title="${esc(c.default || '')}">${esc(c.default || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ── Data Tab ──

async function loadAndRenderData() {
  const el = document.getElementById('db-tab-content');
  if (!el || !_selectedTable) return;

  el.innerHTML = '<div class="db-data-loading">טוען נתונים...</div>';
  _loadingRows = true;

  try {
    const params = new URLSearchParams({
      limit: _rowsLimit,
      offset: _rowsOffset,
    });
    if (_sortCol) {
      params.set('sort', _sortCol);
      params.set('dir', _sortDir);
    }

    const res = await fetch(`${_config.apiPrefix}/tables/${encodeURIComponent(_selectedTable.name)}/rows?${params}`);
    const data = await res.json();

    if (data.success) {
      _rows = data.rows;
      _rowsTotal = data.total;
    } else {
      _rows = [];
      _rowsTotal = 0;
    }
  } catch {
    _rows = [];
    _rowsTotal = 0;
  }

  _loadingRows = false;
  renderDataTab();
}

function renderDataTab() {
  const el = document.getElementById('db-tab-content');
  if (!el || !_selectedTable) return;

  const cols = _selectedTable.columns;
  const page = Math.floor(_rowsOffset / _rowsLimit) + 1;
  const totalPages = Math.max(1, Math.ceil(_rowsTotal / _rowsLimit));

  if (_rows.length === 0) {
    el.innerHTML = `
      <div class="db-empty">אין נתונים בטבלה</div>
      <div class="db-pagination">
        <span class="db-page-info">${_rowsTotal.toLocaleString('he-IL')} שורות</span>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="db-data-wrap">
      <table class="db-data-table">
        <thead>
          <tr>
            ${cols.map(c => {
              const arrow = _sortCol === c.name
                ? `<span class="db-sort-arrow">${_sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>`
                : '';
              return `<th data-col="${esc(c.name)}">${arrow}${esc(c.name)}</th>`;
            }).join('')}
          </tr>
        </thead>
        <tbody>
          ${_rows.map(row => `
            <tr>
              ${cols.map(c => {
                const val = row[c.name];
                if (val === null || val === undefined) {
                  return '<td><span class="db-null-val">NULL</span></td>';
                }
                const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
                return `<td title="${esc(str)}">${esc(str)}</td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="db-pagination">
      <button class="db-page-btn" id="db-prev" ${page <= 1 ? 'disabled' : ''}>הקודם</button>
      <span class="db-page-info">עמוד ${page} מתוך ${totalPages} &middot; ${_rowsTotal.toLocaleString('he-IL')} שורות</span>
      <button class="db-page-btn" id="db-next" ${page >= totalPages ? 'disabled' : ''}>הבא</button>
    </div>
  `;

  // Sort by clicking column headers
  el.querySelectorAll('.db-data-table th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_sortCol === col) {
        _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        _sortCol = col;
        _sortDir = 'asc';
      }
      _rowsOffset = 0;
      loadAndRenderData();
    });
  });

  // Pagination
  document.getElementById('db-prev')?.addEventListener('click', () => {
    if (_rowsOffset > 0) {
      _rowsOffset = Math.max(0, _rowsOffset - _rowsLimit);
      loadAndRenderData();
    }
  });
  document.getElementById('db-next')?.addEventListener('click', () => {
    if (_rowsOffset + _rowsLimit < _rowsTotal) {
      _rowsOffset += _rowsLimit;
      loadAndRenderData();
    }
  });
}

// ══════════════════════════════════════════
// ── Fullscreen Table Modal ──
// ══════════════════════════════════════════

function openTableModal(name) {
  const table = _tables.find(t => t.name === name);
  if (!table) return;
  _modal = { table, rows: [], total: 0, limit: 100, offset: 0, sortCol: '', sortDir: 'asc', loading: false };
  renderModal();
  loadModalData();
}

function closeModal() {
  document.getElementById('dbm-overlay')?.remove();
  _modal.table = null;
}

function renderModal() {
  // remove old
  document.getElementById('dbm-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dbm-overlay';
  overlay.className = 'dbm-overlay';
  overlay.innerHTML = `
    <div class="dbm-dialog">
      <div class="dbm-header">
        <button class="dbm-close" id="dbm-close">\u2715 סגור</button>
        <span class="dbm-title">${esc(_modal.table.name)}</span>
        <span class="dbm-meta">${_modal.table.columns.length} עמודות &middot; ${_modal.table.rowCount.toLocaleString('he-IL')} שורות</span>
        <a class="db-csv-btn" href="${_config.apiPrefix}/tables/${encodeURIComponent(_modal.table.name)}/export" download>\u2B07 CSV</a>
      </div>
      <div class="dbm-body" id="dbm-body">
        <div class="dbm-loading">טוען נתונים...</div>
      </div>
      <div class="dbm-footer" id="dbm-footer"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // close handlers
  document.getElementById('dbm-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  overlay.tabIndex = -1;
  overlay.focus();
}

async function loadModalData() {
  const m = _modal;
  if (!m.table) return;
  m.loading = true;

  const params = new URLSearchParams({ limit: m.limit, offset: m.offset });
  if (m.sortCol) {
    params.set('sort', m.sortCol);
    params.set('dir', m.sortDir);
  }

  try {
    const res = await fetch(`${_config.apiPrefix}/tables/${encodeURIComponent(m.table.name)}/rows?${params}`);
    const data = await res.json();
    if (data.success) {
      m.rows = data.rows;
      m.total = data.total;
    } else {
      m.rows = [];
      m.total = 0;
    }
  } catch {
    m.rows = [];
    m.total = 0;
  }

  m.loading = false;
  renderModalTable();
}

function renderModalTable() {
  const body = document.getElementById('dbm-body');
  const footer = document.getElementById('dbm-footer');
  if (!body || !footer || !_modal.table) return;

  const m = _modal;
  const cols = m.table.columns;
  const page = Math.floor(m.offset / m.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(m.total / m.limit));

  if (m.rows.length === 0) {
    body.innerHTML = '<div class="dbm-loading">אין נתונים בטבלה</div>';
    footer.innerHTML = '';
    return;
  }

  body.innerHTML = `
    <table class="dbm-table">
      <thead>
        <tr>
          <th class="dbm-row-num">#</th>
          ${cols.map(c => {
            const arrow = m.sortCol === c.name
              ? `<span class="dbm-arrow">${m.sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>`
              : '';
            return `<th data-col="${esc(c.name)}">${arrow}${esc(c.name)}</th>`;
          }).join('')}
        </tr>
      </thead>
      <tbody>
        ${m.rows.map((row, i) => `
          <tr>
            <td class="dbm-row-num">${m.offset + i + 1}</td>
            ${cols.map(c => {
              const val = row[c.name];
              if (val === null || val === undefined) return '<td><span class="dbm-null">NULL</span></td>';
              const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
              return `<td title="${esc(str)}">${esc(str)}</td>`;
            }).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  footer.innerHTML = `
    <button class="dbm-page-btn" id="dbm-prev" ${page <= 1 ? 'disabled' : ''}>הקודם</button>
    <span class="dbm-page-info">עמוד ${page} מתוך ${totalPages} &middot; ${m.total.toLocaleString('he-IL')} שורות</span>
    <button class="dbm-page-btn" id="dbm-next" ${page >= totalPages ? 'disabled' : ''}>הבא</button>
  `;

  // sort
  body.querySelectorAll('.dbm-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (m.sortCol === col) {
        m.sortDir = m.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        m.sortCol = col;
        m.sortDir = 'asc';
      }
      m.offset = 0;
      loadModalData();
    });
  });

  // pagination
  document.getElementById('dbm-prev')?.addEventListener('click', () => {
    if (m.offset > 0) {
      m.offset = Math.max(0, m.offset - m.limit);
      loadModalData();
    }
  });
  document.getElementById('dbm-next')?.addEventListener('click', () => {
    if (m.offset + m.limit < m.total) {
      m.offset += m.limit;
      loadModalData();
    }
  });
}

// ══════════════════════════════════════════
// ── DB Analyze ──
// ══════════════════════════════════════════

function renderAnalyzeButton() {
  const wrap = document.getElementById('db-analyze-actions');
  if (!wrap) return;

  const collectBtnHtml = _collectEnabled ? `
    <button class="db-collect-btn" id="db-collect-btn" ${_collectLoading ? 'disabled' : ''}>
      ${_collectLoading ? '<span class="spinner"></span>' : '\uD83D\uDCCB'}
      ${_collectLoading ? 'אוסף מידע...' : 'איסוף כל המידע מהDB'}
    </button>
  ` : '';

  const analyzeBtnHtml = _analyzeEnabled ? `
    <button class="db-analyze-btn" id="db-analyze-btn" ${_analyzeLoading ? 'disabled' : ''}>
      ${_analyzeLoading ? '<span class="spinner"></span>' : '\u2696'}
      ${_analyzeLoading ? 'מנתח...' : 'איזון וסדר בDB'}
    </button>
  ` : '';

  wrap.innerHTML = collectBtnHtml + analyzeBtnHtml;

  document.getElementById('db-collect-btn')?.addEventListener('click', runCollectContext);
  document.getElementById('db-analyze-btn')?.addEventListener('click', runAnalyze);
}

async function runAnalyze() {
  if (_analyzeLoading) return;
  _analyzeLoading = true;
  _analyzeResult = null;
  renderAnalyzeButton();
  renderAnalyzePanel();

  try {
    const res = await fetch(`${_config.apiPrefix}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.success) {
      _analyzeResult = data.analysis;
    } else {
      _analyzeResult = { error: data.error || 'שגיאה בניתוח' };
    }
  } catch (err) {
    _analyzeResult = { error: err.message };
  }

  _analyzeLoading = false;
  renderAnalyzeButton();
  renderAnalyzePanel();
}

// Track which sections are open
const _analyzeSectionsOpen = { tables: false, merge: true, delete: true, optimizations: true };

function renderAnalyzePanel() {
  const wrap = document.getElementById('db-analyze-panel-wrap');
  if (!wrap) return;

  if (_analyzeLoading) {
    wrap.innerHTML = `
      <div class="db-analyze-panel">
        <div class="db-analyze-summary" style="text-align:center;color:var(--text-secondary)">
          מנתח את מבנה הדאטהבייס... זה עשוי לקחת מספר שניות.
        </div>
      </div>
    `;
    return;
  }

  if (!_analyzeResult) {
    wrap.innerHTML = '';
    return;
  }

  if (_analyzeResult.error) {
    wrap.innerHTML = `
      <div class="db-analyze-panel">
        <div class="db-analyze-header">
          <span class="db-analyze-header-title">שגיאה בניתוח</span>
          <button class="db-analyze-close" id="db-analyze-close">\u2715</button>
        </div>
        <div class="db-analyze-summary" style="color:#f87171">${esc(_analyzeResult.error)}</div>
      </div>
    `;
    document.getElementById('db-analyze-close')?.addEventListener('click', closeAnalyze);
    return;
  }

  const a = _analyzeResult;
  const tables = a.tables || [];
  const merges = a.merge_suggestions || [];
  const deletes = a.delete_suggestions || [];
  const opts = a.optimizations || [];

  wrap.innerHTML = `
    <div class="db-analyze-panel">
      <div class="db-analyze-header">
        <span class="db-analyze-header-title">\u2696 ניתוח DB — איזון וסדר</span>
        <button class="db-analyze-close" id="db-analyze-close">\u2715</button>
      </div>

      ${a.summary ? `<div class="db-analyze-summary">${esc(a.summary)}</div>` : ''}

      ${buildAnalyzeSection('tables', 'ניתוח טבלאות', tables.length, () =>
        tables.map(t => `
          <div class="db-analyze-table-item">
            <span class="db-analyze-status db-analyze-status-${t.status || 'ok'}">${statusLabel(t.status)}</span>
            <span class="db-analyze-table-name">${esc(t.name)}</span>
            <span class="db-analyze-table-purpose">${esc(t.purpose || '')}</span>
            <span class="db-analyze-table-rows">${(t.rowCount || 0).toLocaleString('he-IL')} שורות</span>
          </div>
          ${t.notes ? `<div style="padding:0 0 6px 0;font-size:0.78rem;color:var(--text-secondary);margin-right:60px">${esc(t.notes)}</div>` : ''}
        `).join('')
      )}

      ${buildAnalyzeSection('merge', 'הצעות לאיחוד', merges.length, () =>
        merges.length === 0
          ? '<div style="color:var(--text-secondary);font-size:0.84rem">אין הצעות לאיחוד טבלאות</div>'
          : merges.map(m => `
            <div class="db-analyze-suggestion">
              <div class="db-analyze-suggestion-header">
                <span class="db-analyze-priority db-analyze-priority-${m.priority || 'low'}">${priorityLabel(m.priority)}</span>
                <span class="db-analyze-suggestion-tables">${(m.tables || []).map(t => esc(t)).join(' + ')}</span>
              </div>
              <div class="db-analyze-suggestion-reason">${esc(m.reason || '')}</div>
            </div>
          `).join('')
      )}

      ${buildAnalyzeSection('delete', 'הצעות למחיקה', deletes.length, () =>
        deletes.length === 0
          ? '<div style="color:var(--text-secondary);font-size:0.84rem">אין הצעות למחיקת טבלאות</div>'
          : deletes.map(d => `
            <div class="db-analyze-suggestion">
              <div class="db-analyze-suggestion-header">
                <span class="db-analyze-priority db-analyze-priority-${d.priority || 'low'}">${priorityLabel(d.priority)}</span>
                <span class="db-analyze-suggestion-tables">${esc(d.table || '')}</span>
              </div>
              <div class="db-analyze-suggestion-reason">${esc(d.reason || '')}</div>
            </div>
          `).join('')
      )}

      ${buildAnalyzeSection('optimizations', 'אופטימיזציות', opts.length, () =>
        opts.length === 0
          ? '<div style="color:var(--text-secondary);font-size:0.84rem">אין הצעות לאופטימיזציה</div>'
          : opts.map(o => `
            <div class="db-analyze-suggestion">
              <div class="db-analyze-suggestion-header">
                <span class="db-analyze-priority db-analyze-priority-${o.priority || 'low'}">${priorityLabel(o.priority)}</span>
                <span style="font-size:0.78rem;color:var(--text-secondary);font-family:monospace">${esc(o.type || '')}</span>
              </div>
              <div class="db-analyze-suggestion-reason">${esc(o.description || '')}</div>
            </div>
          `).join('')
      )}
    </div>
  `;

  // Close button
  document.getElementById('db-analyze-close')?.addEventListener('click', closeAnalyze);

  // Section toggle handlers
  wrap.querySelectorAll('.db-analyze-section-header').forEach(header => {
    header.addEventListener('click', () => {
      const key = header.dataset.section;
      _analyzeSectionsOpen[key] = !_analyzeSectionsOpen[key];
      renderAnalyzePanel();
    });
  });
}

function buildAnalyzeSection(key, title, count, contentFn) {
  const isOpen = _analyzeSectionsOpen[key];
  return `
    <div class="db-analyze-section">
      <div class="db-analyze-section-header" data-section="${key}">
        <span class="db-analyze-section-icon ${isOpen ? 'open' : ''}">\u25B6</span>
        <span class="db-analyze-section-title">${title}</span>
        <span class="db-analyze-section-badge">${count}</span>
      </div>
      ${isOpen ? `<div class="db-analyze-section-body">${contentFn()}</div>` : ''}
    </div>
  `;
}

function statusLabel(status) {
  const map = { ok: 'תקין', warning: 'אזהרה', unused: 'לא בשימוש', redundant: 'מיותר' };
  return map[status] || 'תקין';
}

function priorityLabel(priority) {
  const map = { high: 'גבוהה', medium: 'בינונית', low: 'נמוכה' };
  return map[priority] || 'נמוכה';
}

function closeAnalyze() {
  _analyzeResult = null;
  renderAnalyzePanel();
}

// ══════════════════════════════════════════
// ── Collect DB Context ──
// ══════════════════════════════════════════

async function runCollectContext() {
  if (_collectLoading) return;
  _collectLoading = true;
  renderAnalyzeButton();

  try {
    // Try cache first
    const cacheRes = await fetch(`${_config.apiPrefix}/collect-context`);
    const cacheData = await cacheRes.json();

    if (cacheData.success && cacheData.fromCache && cacheData.text) {
      // Got cached result — show immediately
      _collectLoading = false;
      renderAnalyzeButton();
      showCollectModal(cacheData.text, cacheData.stats, cacheData.scannedAt, true);
      return;
    }

    // No cache — do full scan
    await doFullScan();
  } catch (err) {
    alert('שגיאה: ' + err.message);
  }

  _collectLoading = false;
  renderAnalyzeButton();
}

async function doFullScan() {
  _collectLoading = true;
  renderAnalyzeButton();

  try {
    const res = await fetch(`${_config.apiPrefix}/collect-context`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showCollectModal(data.text, data.stats, data.scannedAt, false);
    } else {
      alert(data.error || 'שגיאה באיסוף מידע');
    }
  } catch (err) {
    alert('שגיאה: ' + err.message);
  }

  _collectLoading = false;
  renderAnalyzeButton();
}

function showCollectModal(text, stats, scannedAt, fromCache) {
  // Remove existing
  document.getElementById('db-collect-overlay')?.remove();

  const scannedDate = scannedAt ? new Date(scannedAt) : null;
  const scannedLabel = scannedDate
    ? scannedDate.toLocaleDateString('he-IL') + ' ' + scannedDate.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
    : '';
  const cacheLabel = fromCache
    ? `<span class="db-collect-cache-badge cache">נטען מ-cache</span>`
    : `<span class="db-collect-cache-badge fresh">סריקה חדשה</span>`;

  const overlay = document.createElement('div');
  overlay.id = 'db-collect-overlay';
  overlay.className = 'db-collect-overlay';
  overlay.innerHTML = `
    <div class="db-collect-dialog">
      <div class="db-collect-header">
        <button class="db-collect-close" id="db-collect-close">\u2715 סגור</button>
        <span class="db-collect-header-title">\uD83D\uDCCB כל המידע מהDB</span>
        <div class="db-collect-stats">
          <span>${stats.tables} טבלאות</span>
          <span>${stats.totalRows.toLocaleString('he-IL')} רשומות</span>
          <span>${stats.foreignKeys} FK</span>
          <span>${stats.indexes} אינדקסים</span>
          <span>${stats.migrations} מיגרציות</span>
        </div>
        <div class="db-collect-cache-info">
          ${cacheLabel}
          ${scannedLabel ? `<span class="db-collect-scan-date">${scannedLabel}</span>` : ''}
          <button class="db-collect-rescan" id="db-collect-rescan">סרוק מחדש</button>
        </div>
        <button class="db-collect-copy" id="db-collect-copy">העתק הכל</button>
      </div>
      <div class="db-collect-body">
        <pre id="db-collect-text"></pre>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Set text content safely (not innerHTML)
  document.getElementById('db-collect-text').textContent = text;

  // Close handlers
  document.getElementById('db-collect-close').addEventListener('click', closeCollectModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCollectModal(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCollectModal(); });
  overlay.tabIndex = -1;
  overlay.focus();

  // Rescan handler
  document.getElementById('db-collect-rescan').addEventListener('click', async () => {
    const btn = document.getElementById('db-collect-rescan');
    if (btn) { btn.textContent = 'סורק...'; btn.disabled = true; }
    closeCollectModal();
    await doFullScan();
  });

  // Copy handler
  document.getElementById('db-collect-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById('db-collect-copy');
      if (btn) {
        btn.textContent = 'הועתק! \u2713';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'העתק הכל';
          btn.classList.remove('copied');
        }, 2000);
      }
    } catch {
      // Fallback: select all text
      const pre = document.getElementById('db-collect-text');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  });
}

function closeCollectModal() {
  document.getElementById('db-collect-overlay')?.remove();
}
