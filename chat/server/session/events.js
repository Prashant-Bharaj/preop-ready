import { EventEmitter } from 'node:events';

export const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(50);
