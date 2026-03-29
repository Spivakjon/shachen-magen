// shared-dashboard — main entry
// Re-exports for convenience

export { registerSharedRoutes } from './lib/sharedAdminRoutes.js';
export { registerSecurity } from './lib/security.js';
export { trackTokens, getTokenStats, resetTokenStats } from './lib/tokenTracker.js';

// Core shared modules
export { logEvent, getSystemEvents } from './lib/core/eventLogger.js';
export { recordMetric, getGlobalMetrics } from './lib/core/metricsStore.js';
export { required, optional, asBool } from './lib/core/configHelpers.js';
export { logger } from './lib/core/logger.js';
export { eventBus } from './lib/core/eventBus.js';
export { asString, normalizePhone, normalizePhoneIL, sleep, truncate } from './lib/core/utils.js';
export { createDb } from './lib/core/db.js';
export { runMigrations } from './lib/core/migrate.js';

// Mail
export { createMailRoutes } from './lib/mail/mailRoutes.js';
export { createGmailClient } from './lib/mail/gmailClient.js';
export { createGmailAdapter } from './lib/mail/gmailAdapter.js';
export { createPop3Adapter } from './lib/mail/pop3Adapter.js';
export { createHybridAdapter } from './lib/mail/hybridAdapter.js';

// Tasks
export { createTaskRoutes } from './lib/tasks/taskRoutes.js';
export { createTaskStore } from './lib/tasks/taskStore.js';
export { createCategoryStore } from './lib/tasks/categoryStore.js';
export { createReminderScheduler } from './lib/tasks/reminderScheduler.js';

// Bureaucracy
export { createBureaucracyRoutes } from './lib/bureaucracy/bureaucracyRoutes.js';
export { createBureaucracyStore } from './lib/bureaucracy/bureaucracyStore.js';
export { createUserRulesStore } from './lib/bureaucracy/userRulesStore.js';
export { createBureaucracyAgent } from './lib/bureaucracy/bureaucracyAgent.js';

// Database
export { createDatabaseRoutes } from './lib/database/databaseRoutes.js';
