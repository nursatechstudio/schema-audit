#!/usr/bin/env node
/** Schema Audit: dependency-free JSON-LD health checks for web pages. */
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 SchemaAudit/1.0';
// Recommended (not required) schema.org fields per type; "a|b" means any one of them satisfies the slot.
const FIELDS = {
  JobPosting: ['title', 'datePosted', 'description', 'hiringOrganization', 'jobLocation', 'baseSalary'],
  Product: ['name', 'image|description', 'offers'],
  Event: ['name', 'startDate', 'location'],
  Organization: ['name', 'url', 'logo'],
};
const hasValue = (obj, key) => obj[key] !== undefined && obj[key] !== null && obj[key] !== '' && !(Array.isArray(obj[key]) && obj[key].length === 0);
function fieldSatisfied(obj, slot) { return slot.split('|').some((key) => hasValue(obj, key)); }
function sanitizeJson(text) { return text.replace(/[\x00-\x1f]/g, ' '); }
/** Parse one ld+json block: strict parse first, then retry after stripping control characters. */
function parseBlock(text) {
  try { return { data: JSON.parse(text), status: 'valid' }; }
  catch {
    try { return { data: JSON.parse(sanitizeJson(text)), status: 'invalid-JSON (recovered by sanitization)' }; }
    catch (error) { return { data: null, status: 'unparseable', error: error.message }; }
  }
}
function extractBlocks(html) {
  const blocks = [];
  const re = /<script\b[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = re.exec(html))) blocks.push(match[1]);
  return blocks;
}
/** Depth-first walk over objects, @graph containers, and @type arrays. */
function walk(value, found = []) {
  if (Array.isArray(value)) { for (const item of value) walk(item, found); return found; }
  if (!value || typeof value !== 'object') return found;
  if (value['@type']) {
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    for (const type of types) {
      const shortType = String(type).split(/[\/#]/).filter(Boolean).pop();
      const required = FIELDS[shortType];
      if (!required) continue;
      const missing = required.filter((slot) => !fieldSatisfied(value, slot));
      found.push({ type: shortType, name: value.name ?? value.title ?? '', score: Math.round(((required.length - missing.length) / required.length) * 100), missing });
    }
  }
  for (const [key, child] of Object.entries(value)) if (key !== '@type') walk(child, found);
  return found;
}
/** HTTP fallback: many CDNs block Node's TLS fingerprint but accept curl. */
function curlFetch(url) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['-fsSL', '--max-time', '30', '-A', UA, url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => { code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `curl exited with status ${code}`)); });
  });
}
async function fetchPage(url) {
  if (url.startsWith('file:')) {
    const raw = url.slice('file:'.length);
    return { html: await readFile(raw.startsWith('/') ? raw : path.resolve(ROOT, raw), 'utf8'), via: 'local file' };
  }
  let fetchError;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { html: await response.text(), via: 'Node fetch' };
  } catch (error) { fetchError = error; }
  try { return { html: await curlFetch(url), via: 'curl fallback' }; }
  catch (error) { throw new Error(`Node fetch failed (${fetchError.message}); curl failed (${error.message})`); }
}
async function auditPage(url) {
  try {
    const { html, via } = await fetchPage(url);
    const parsed = extractBlocks(html).map(parseBlock);
    const schemas = parsed.flatMap((block, index) => (block.data ? walk(block.data).map((schema) => ({ ...schema, block: index + 1 })) : []));
    const scores = schemas.map((schema) => schema.score);
    return { url, fetchVia: via, blockCount: parsed.length, blocks: parsed.map((block, index) => ({ index: index + 1, status: block.status, ...(block.error ? { error: block.error } : {}) })), schemas, score: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 0, error: null };
  } catch (error) { return { url, fetchVia: null, blockCount: 0, blocks: [], schemas: [], score: 0, error: error.message }; }
}
function pageIssues(page) {
  if (page.error) return [page.error];
  const parts = page.schemas.map((schema) => `${schema.type}: ${schema.score}%${schema.missing.length ? ` (missing ${schema.missing.join(', ')})` : ' (complete)'}`);
  parts.push(...page.blocks.filter((block) => block.status !== 'valid').map((block) => `block ${block.index}: ${block.status}`));
  if (!page.schemas.length) parts.push('no recognized schema.org types');
  return parts.length ? parts : ['no issues'];
}
function markdown(results) {
  const lines = [
    '# Schema Audit Report', '', `Generated: ${new Date().toISOString()} UTC`, '',
    '| Page | Score | JSON-LD blocks | Schema objects | Findings |', '|---|---:|---:|---:|---|',
  ];
  for (const page of results) {
    lines.push(`| [${page.url}](${page.url}) | ${page.score}% | ${page.blockCount} | ${page.schemas.length} | ${pageIssues(page).join('; ').replaceAll('|', '\\|')} |`);
  }
  lines.push('', 'Score = average completeness of recognized schema.org objects on the page (0-100). Pages with no recognized types score 0.', '');
  return lines.join('\n');
}
function usage() {
  console.log('Usage: node audit.mjs [--targets FILE] [--strict [THRESHOLD]]');
  console.log('  --targets FILE   URL list, one per line (.txt) or a JSON array (.json); default targets.txt');
  console.log('  --strict [N]     exit 1 if any page scores below N (default 70)');
}
async function loadTargets(file) {
  const text = await readFile(file, 'utf8');
  if (file.endsWith('.json')) { const parsed = JSON.parse(text); if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array of URLs`); return parsed.map((url) => String(url).trim()).filter(Boolean); }
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}
async function main() {
  const args = process.argv.slice(2);
  let targetsFile = path.join(ROOT, 'targets.txt'); let strict = false; let threshold = 70;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { usage(); return; }
    if (arg === '--targets') { if (!args[i + 1]) throw new Error('--targets requires a file path'); targetsFile = path.resolve(args[++i]); }
    else if (arg === '--strict') { strict = true; if (args[i + 1] && /^\d+$/.test(args[i + 1])) threshold = Number(args[++i]); }
    else throw new Error(`Unknown option: ${arg}`);
  }
  const urls = await loadTargets(targetsFile);
  if (!urls.length) throw new Error(`No URLs found in ${targetsFile}`);
  console.log(`Schema Audit: checking ${urls.length} page(s) from ${path.relative(ROOT, targetsFile) || targetsFile}...`);
  const results = [];
  for (const url of urls) {
    const page = await auditPage(url);
    results.push(page);
    const head = page.error ? 'ERROR' : `${page.score}%`;
    const extra = page.error || page.schemas.length ? '' : ' — no recognized schema types';
    console.log(`${head} ${url} — ${page.blockCount} JSON-LD block(s), ${page.schemas.length} recognized object(s)${page.fetchVia ? ` via ${page.fetchVia}` : ''}${extra}${page.error ? `: ${page.error}` : ''}`);
    for (const block of page.blocks) if (block.status !== 'valid') console.log(`    block ${block.index}: ${block.status}${block.error ? ` (${block.error})` : ''}`);
    for (const schema of page.schemas) console.log(`    ${schema.type}: ${schema.score}%${schema.missing.length ? `; missing ${schema.missing.join(', ')}` : '; all recommended fields present'}`);
  }
  const report = { generatedAt: new Date().toISOString(), threshold, pages: results };
  await Promise.all([
    writeFile(path.join(ROOT, 'audit.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(ROOT, 'audit.md'), markdown(results)),
  ]);
  console.log('Wrote audit.md and audit.json.');
  const failing = results.filter((page) => page.error || page.score < threshold);
  if (strict && failing.length) {
    console.error(`Strict mode: ${failing.length} page(s) below ${threshold}% or unreachable — exiting 1.`);
    process.exitCode = 1;
  }
}
main().catch((error) => { console.error(`Schema Audit error: ${error.message}`); process.exitCode = 1; });
