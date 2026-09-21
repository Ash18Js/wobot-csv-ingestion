import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'catalog-ingest' },
});

export type Logger = typeof logger;
