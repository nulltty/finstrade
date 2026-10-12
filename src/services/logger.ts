import fs from 'fs';
import path from 'path';
import pino from 'pino';
import pretty from 'pino-pretty';

const level = process.env.LOG_LEVEL || 'info';
const logFile = process.env.LOG_FILE;

function createLogger() {
  if (!logFile) {
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'yyyy-mm-dd HH:MM:ss', ignore: 'pid,hostname' },
      },
    });
  }

  // 24/7 service mode (launchd): plain-text file that newsyslog rotates. Rotation sends
  // SIGHUP (pid file below) and we reopen the file instead of exiting.
  const dest = pino.destination({ dest: logFile, mkdir: true, sync: false });
  const stream = pretty({ colorize: false, translateTime: 'yyyy-mm-dd HH:MM:ss', ignore: 'pid,hostname', destination: dest });
  fs.writeFileSync(path.join(path.dirname(logFile), 'fins.pid'), String(process.pid));
  process.on('SIGHUP', () => dest.reopen());
  return pino({ level }, stream);
}

export const logger = createLogger();
