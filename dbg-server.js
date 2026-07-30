const http = require('http');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function nowMs() {
  return Date.now();
}

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function tryListen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);

  const sessionId = String(args.session || '').trim();
  if (!sessionId) {
    process.stderr.write('Missing required --session\n');
    process.exit(2);
  }

  const outdir = String(args.outdir || '.dbg');
  const idleSec = Number(args.idle || 0);
  const clean = !!args.clean;
  const host = args.remote ? '0.0.0.0' : '127.0.0.1';
  const startPort = Number(args.port || 7777);

  const absOutdir = path.resolve(process.cwd(), outdir);
  fs.mkdirSync(absOutdir, { recursive: true });

  const logFile = path.join(absOutdir, `trae-debug-log-${sessionId}.ndjson`);
  if (clean) {
    try { fs.writeFileSync(logFile, ''); } catch {}
  }

  let lastEventAt = nowMs();
  const server = http.createServer((req, res) => {
    withCors(res);

    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, sessionId, ts: nowMs() }));
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/logs') {
      try { fs.writeFileSync(logFile, ''); } catch {}
      res.statusCode = 200;
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/logs') {
      res.setHeader('Content-Type', 'application/x-ndjson');
      try {
        const txt = fs.readFileSync(logFile, 'utf8');
        res.statusCode = 200;
        res.end(txt);
      } catch {
        res.statusCode = 200;
        res.end('');
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/event') {
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        try {
          const evt = JSON.parse(body || '{}');
          if (!evt.ts) evt.ts = nowMs();
          if (!evt.sessionId) evt.sessionId = sessionId;
          fs.appendFileSync(logFile, JSON.stringify(evt) + '\n');
          lastEventAt = nowMs();
          res.statusCode = 200;
          res.end('ok');
        } catch {
          res.statusCode = 400;
          res.end('bad json');
        }
      });
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  let boundPort = null;
  for (let i = 0; i < 10; i++) {
    const p = startPort + i;
    try {
      await tryListen(server, p, host);
      boundPort = p;
      break;
    } catch (e) {
      if (e && e.code === 'EADDRINUSE') continue;
      process.stderr.write(String(e && e.message ? e.message : e) + '\n');
      process.exit(1);
    }
  }

  if (!boundPort) {
    process.stderr.write('No free port found\n');
    process.exit(1);
  }

  const apiUrl = `http://127.0.0.1:${boundPort}/event`;
  const envFile = path.join(absOutdir, `${sessionId}.env`);
  fs.writeFileSync(envFile, `DEBUG_SERVER_URL=${apiUrl}\nDEBUG_SESSION_ID=${sessionId}\n`);

  process.stdout.write('@@DEBUG_SERVER_INFO\n');
  process.stdout.write(JSON.stringify({
    api_url: apiUrl,
    session_id: sessionId,
    log_dir: absOutdir,
    log_file: logFile,
    env_file: envFile,
  }, null, 2) + '\n');
  process.stdout.write('@@END_DEBUG_SERVER_INFO\n');

  if (idleSec > 0) {
    setInterval(() => {
      if (nowMs() - lastEventAt > idleSec * 1000) process.exit(0);
    }, 1000).unref();
  }
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});

