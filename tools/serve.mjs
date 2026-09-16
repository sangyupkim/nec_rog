#!/usr/bin/env node
/** 개발용 정적 서버. ES 모듈과 fetch가 file://에서 막히므로 이걸로 띄운다. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT ?? 5173);
const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const path = join(ROOT, rel === '/' ? 'index.html' : rel);
  try {
    const body = await readFile(path);
    const head = { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' };
    // 서비스 워커가 캐시되면 고쳐도 반영되지 않는다. 개발 중에는 늘 새로 받게 한다
    if (rel.endsWith('sw.js')) head['cache-control'] = 'no-cache';
    res.writeHead(200, head);
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('없는 경로입니다: ' + rel);
  }
}).listen(PORT, () => console.log(`Project Patchwork → http://localhost:${PORT}`));
