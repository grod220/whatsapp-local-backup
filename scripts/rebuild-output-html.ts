import path from 'node:path';
import { renderOutput } from '../src/render.js';
import { withBackupLock } from '../src/storage.js';
import { verifyContinuity } from '../src/archive.js';

withBackupLock(process.cwd(), () => {
  verifyContinuity(path.resolve('output'), path.resolve('archive'));
  renderOutput(path.resolve('output'));
});
