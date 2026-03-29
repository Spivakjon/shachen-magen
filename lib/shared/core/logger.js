// shared-dashboard/lib/core/logger.js
// Shared Pino logger singleton

import pino from 'pino';
import pretty from 'pino-pretty';

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

const customLevels = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export const logger = pino(
  {
    level: customLevels[LOG_LEVEL] ? LOG_LEVEL : 'info',
    customLevels,
    useOnlyCustomLevels: false,
  },
  pretty({
    colorize: true,
    translateTime: 'HH:MM:ss.l',
    ignore: 'pid,hostname',
  })
);
