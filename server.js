// GIF server: serves the web page and downloads videos on behalf of the browser
// (YouTube and other sites via yt-dlp, or any direct link), so the editor can
// read frames without CORS limits. No npm dependencies; needs yt-dlp and ffmpeg on PATH.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const { spawn } = require('node:child_process');

const PORT = +process.env.PORT || 3000;
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, 'cache');
const CACHE_TTL_MS = (+process.env.CACHE_TTL_MIN || 60) * 60 * 1000;
const MAX_DURATION = +process.env.MAX_DURATION || 20 * 60;      // seconds
const MAX_FILESIZE = process.env.MAX_FILESIZE || '500M';
const MAX_HEIGHT = +process.env.MAX_HEIGHT || 720;
const DOWNLOAD_TIMEOUT_MS = (+process.env.DOWNLOAD_TIMEOUT_SEC || 300) * 1000;
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';         // allow localhost / LAN URLs (testing only)
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const COOKIES = process.env.YTDLP_COOKIES || '';                // Netscape cookies.txt (e.g. for YouTube bot checks)

fs.mkdirSync(CACHE_DIR, { recursive: true });

const jobs = new Map();   // id -> Promise<{ file, title, duration }>

/* ---------- helpers ---------- */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('올바른 주소가 아닙니다.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('http/https 주소만 지원합니다.');
  if (!ALLOW_PRIVATE) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(a => a.address);
    if (!addrs.length) throw new Error('주소의 서버를 찾을 수 없습니다.');
    if (addrs.some(isPrivateIp)) throw new Error('내부 네트워크 주소는 사용할 수 없습니다.');
  }
  return u.href;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('다운로드 시간이 초과되었습니다.')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e.code === 'ENOENT' ? new Error(`${cmd} 가 설치되어 있지 않습니다.`) : e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(cleanError(err) || `${cmd} 종료 코드 ${code}`)); });
  });
}

function cleanError(stderr) {
  const line = stderr.split('\n').reverse().find(l => /ERROR/.test(l)) || stderr.trim().split('\n').pop() || '';
  return line.replace(/^.*?ERROR:\s*/, '').slice(0, 300);
}

/* ---------- download ---------- */
async function download(url, id) {
  const outTpl = path.join(CACHE_DIR, `${id}.%(ext)s`);
  const common = ['--no-playlist', '--no-mtime', '--no-warnings', '--no-progress', '--socket-timeout', '30'];
  if (COOKIES) common.push('--cookies', COOKIES);

  // 1) metadata (duration check)
  let info = {};
  try {
    info = JSON.parse(await run(YTDLP, [...common, '-J', '--', url], 60000));
  } catch (e) {
    throw new Error('영상 정보를 가져오지 못했습니다: ' + e.message);
  }
  if (info.is_live) throw new Error('라이브 방송은 지원하지 않습니다.');
  if (info.duration && info.duration > MAX_DURATION) {
    throw new Error(`영상이 너무 깁니다 (최대 ${Math.round(MAX_DURATION / 60)}분).`);
  }

  // 2) download a browser-playable mp4 (H.264 preferred), capped in height
  const h = MAX_HEIGHT;
  const format = [
    `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]`,
    `b[height<=${h}][ext=mp4][vcodec^=avc1]`,
    `bv*[height<=${h}]+ba`,
    `b[height<=${h}]`,
    'b', 'bv*+ba',
  ].join('/');
  await run(YTDLP, [...common, '-f', format, '--merge-output-format', 'mp4', '--remux-video', 'mp4',
    '--max-filesize', MAX_FILESIZE, '-o', outTpl, '--', url], DOWNLOAD_TIMEOUT_MS);

  const files = (await fsp.readdir(CACHE_DIR)).filter(f => f.startsWith(id + '.') && !/\.(part|ytdl|temp)$/.test(f));
  if (!files.length) throw new Error('영상을 받지 못했습니다 (파일 크기 제한을 넘었을 수 있습니다).');
  return { file: files[0], title: info.title || '', duration: info.duration || null };
}

/* ---------- static / file serving ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime' };

async function serveFile(req, res, filePath, extraHeaders = {}) {
  let st;
  try { st = await fsp.stat(filePath); } catch { return sendJson(res, 404, { error: 'not found' }); }
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...extraHeaders };
  if (range && (range[1] || range[2])) {
    let start = range[1] ? +range[1] : st.size - +range[2];
    let end = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    if (start < 0) start = 0;
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  }
}

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true });

    if (pathname === '/api/fetch' && req.method === 'POST') {
      let url;
      try { url = (JSON.parse(await readBody(req)).url || '').trim(); } catch { return sendJson(res, 400, { error: '잘못된 요청입니다.' }); }
      try { url = await validateUrl(url); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      const id = crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
      if (!jobs.has(id)) {
        const job = download(url, id);
        jobs.set(id, job);
        job.catch(() => jobs.delete(id));
      }
      try {
        const r = await jobs.get(id);
        // the job may have been cleaned up from disk
        if (!fs.existsSync(path.join(CACHE_DIR, r.file))) { jobs.delete(id); return sendJson(res, 410, { error: '다시 시도해주세요.' }); }
        return sendJson(res, 200, { src: `/api/file/${r.file}`, title: r.title, duration: r.duration });
      } catch (e) {
        return sendJson(res, 422, { error: e.message });
      }
    }

    const m = /^\/api\/file\/([a-f0-9]{24}\.[a-z0-9]{2,5})$/.exec(pathname);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveFile(req, res, path.join(CACHE_DIR, m[1]), { 'Cache-Control': 'private, max-age=3600' });
    }

    if ((pathname === '/' || pathname === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveFile(req, res, path.join(__dirname, 'index.html'), { 'Cache-Control': 'no-cache' });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: '서버 오류' });
    else res.destroy();
  }
});

/* ---------- cache cleanup ---------- */
setInterval(async () => {
  const now = Date.now();
  for (const f of await fsp.readdir(CACHE_DIR).catch(() => [])) {
    const p = path.join(CACHE_DIR, f);
    try {
      const st = await fsp.stat(p);
      if (now - st.mtimeMs > CACHE_TTL_MS) {
        await fsp.rm(p, { force: true });
        jobs.delete(f.split('.')[0]);
      }
    } catch {}
  }
}, 5 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`GIF server running at http://localhost:${PORT}`));
