import fs from 'node:fs';
import path from 'node:path';

const filename = path.resolve('clemcast.config.json');
const config = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {};
export const DISPLAY_TIME_ZONE: string = config.timeZone ?? 'UTC';
export const VIEW_VERSION = '2';
new Intl.DateTimeFormat('en', { timeZone: DISPLAY_TIME_ZONE }).format();
