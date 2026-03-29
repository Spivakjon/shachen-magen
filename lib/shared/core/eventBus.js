// shared-dashboard/lib/core/eventBus.js
// Shared EventBus singleton

import { EventEmitter } from 'events';
import { logger } from './logger.js';

class EventBus extends EventEmitter {
  emit(event, payload) {
    logger.debug({ event }, 'Event emitted');
    return super.emit(event, payload);
  }
}

export const eventBus = new EventBus();
