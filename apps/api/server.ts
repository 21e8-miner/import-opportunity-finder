/**
 * Zero-dependency API + static server for the Underwriting Report UI.
 *   node apps/api/server.ts            (PORT env, default 3000)
 * Fastify + BullMQ/Redis scan queue replace this in the hosted build; the route contract stays the same.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { underwrite } from '../../packages/core/src/index.ts';
import type { DealInput } from '../../packages/core/src/index.ts';
import { rules } from '../../packages/rules/src/index.ts';
import { keepaProduct, usitcLookup } from '../../packages/providers/src/index.ts';

const root = new URL('../../', import.meta.url);
const STATIC: Record<string, [string, string]> = {
  '/': ['apps/web/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['apps/web/app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['apps/web/styles.css', 'text/css; charset=utf-8'],
};
const FIXTURE_DIR = new URL('packages/core/fixtures/', root);
const MAX_BODY = 256 * 1024;

const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-ruleset-version': rules.version });
  res.end(typeof body === 'string' || body instanceof Buffer ? body : JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new Error('body too large'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    return send(res, 200, await readFile(new URL(file, root)), type);
  }
  if (req.method === 'GET' && p === '/api/meta') {
    const fixtures = (await readdir(FIXTURE_DIR)).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
    return send(res, 200, {
      rulesetVersion: rules.version,
      playbooks: rules.playbooks.playbooks.map(({ id, label, status, question }) => ({ id, label, status, question })),
      categories: rules.compliance.categories.map(c => ({ id: c.id, label: c.label, required: c.required.map(r => r.id) })),
      fixtures,
      providers: { usitc: true, keepa: Boolean(process.env.KEEPA_API_KEY) },
    });
  }
  const fx = p.match(/^\/api\/fixtures\/([a-z0-9-]+)$/);
  if (req.method === 'GET' && fx) return send(res, 200, await readFile(new URL(`${fx[1]}.json`, FIXTURE_DIR), 'utf8'));
  if (req.method === 'GET' && p === '/api/rules/changelog') return send(res, 200, await readFile(new URL('packages/rules/CHANGELOG.md', root), 'utf8'), 'text/markdown; charset=utf-8');

  if (req.method === 'POST' && p === '/api/underwrite') {
    let input: DealInput;
    try { input = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: `Invalid JSON: ${(e as Error).message}` }); }
    try { return send(res, 200, underwrite(input, rules)); }
    catch (e) { return send(res, 422, { error: (e as Error).message }); }
  }
  const hts = p.match(/^\/api\/hts\/([0-9.]{4,14})$/);
  if (req.method === 'GET' && hts) {
    try { return send(res, 200, await usitcLookup(hts[1])); } catch (e) { return send(res, 502, { error: `USITC lookup failed: ${(e as Error).message}` }); }
  }
  const asin = p.match(/^\/api\/keepa\/([A-Z0-9]{10})$/);
  if (req.method === 'GET' && asin) {
    try { return send(res, 200, await keepaProduct(asin[1])); } catch (e) { return send(res, 502, { error: (e as Error).message }); }
  }
  send(res, 404, { error: 'not found' });
}

const PORT = Number(process.env.PORT ?? 3000);
createServer((req, res) => { route(req, res).catch(e => send(res, 500, { error: (e as Error).message })); })
  .listen(PORT, () => console.log(`Import Underwriter → http://localhost:${PORT}  (ruleset ${rules.version})`));
