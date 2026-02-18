import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(process.cwd(), process.argv[2] || 'output');
const port = Number(process.env.PORT || 4173);

if (!fs.existsSync(rootDir)) {
  console.error(`Output directory not found: ${rootDir}`);
  process.exit(1);
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

function resolveFilePath(urlPathname) {
  const decodedPath = decodeURIComponent(urlPathname);
  const safePath = decodedPath === '/' ? '/index.html' : decodedPath;
  const resolved = path.resolve(rootDir, `.${safePath}`);

  if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
    return null;
  }

  let filePath = resolved;
  try {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    // Leave as-is; caller handles not found.
  }

  return filePath;
}

const server = http.createServer((req, res) => {
  if (!req.url || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const filePath = resolveFilePath(url.pathname);

  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  let fileStats;
  try {
    fileStats = fs.statSync(filePath);
    if (!fileStats.isFile()) {
      throw new Error('Not a file');
    }
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const contentLength = fileStats.size;

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(contentLength),
    'Cache-Control': 'no-cache',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (!res.writableEnded) {
      res.end('Internal server error');
    }
  });
  stream.pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving ${rootDir}`);
  console.log(`Open http://127.0.0.1:${port}/`);
});
