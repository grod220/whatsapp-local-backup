import fs from 'node:fs';
import path from 'node:path';
try {
  const directory = path.resolve('archive/legacy-recovery/snapshots');
  const history = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
    const snapshot = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    return { name, originalName: snapshot.originalName, files: Object.keys(snapshot.files).length };
  }) : [];
  console.log(JSON.stringify(history, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
