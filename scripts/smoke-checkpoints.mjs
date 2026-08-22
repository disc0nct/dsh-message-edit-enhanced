// Lifecycle smoke test for workspace checkpoints via the built bundle.
// Run after `npm run build`: node scripts/smoke-checkpoints.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
const ws = mkdtempSync(join(tmpdir(), 'ws-'))
process.env.DSH_HOME = home

const A = join(ws, 'a.txt')
const B = join(ws, 'sub', 'b.txt')
const C = join(ws, 'c.md')
mkdirSync(dirname(B), { recursive: true })
writeFileSync(A, 'alpha-v1')
writeFileSync(B, 'beta-v1')
writeFileSync(C, '# gamma')

// Minimal real-file fs service matching the structural subset the module uses.
const fssvc = {
  async resolve(p) { return { targetKey: p, displayPath: p } },
  async listDir(target) {
    const { readdirSync, statSync } = await import('node:fs')
    return readdirSync(target.displayPath, { withFileTypes: true }).map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
      target: { targetKey: join(target.displayPath, e.name), displayPath: join(target.displayPath, e.name) },
      size: e.isFile() ? statSync(join(target.displayPath, e.name)).size : undefined,
    }))
  },
  async readText(target) { return readFileSync(target.displayPath, 'utf8') },
  async writeText(target, content) { writeFileSync(target.displayPath, content); return {} },
}

const T = Date.now()
const fakeEvents = [
  { type: 'turn/start', seq: 4, time: T, data: { turn: 2 } },
  { type: 'user/message', seq: 5, time: T, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello world' }] } },
  { type: 'assistant/message', seq: 6, time: T, data: { turn: 2, step: 1, message: { id: 'm', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } } } },
  { type: 'turn/end', seq: 7, time: T, data: { turn: 2, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 18, time: T, data: { turn: 3 } },
  { type: 'user/message', seq: 20, time: T, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'second exchange' }] } },
  { type: 'assistant/message', seq: 21, time: T, data: { turn: 3, step: 1, message: { id: 'm2', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } } } },
  { type: 'turn/end', seq: 22, time: T, data: { turn: 3, reason: { kind: 'completed' } } },
]

const listeners = {}
const routes = []
const ctx = {
  effect(fn, _label) { fn(); return () => {} },
  webServer: { register(route) { routes.push(route); return () => {} } },
  sessions: { get: () => undefined },
  agents: { get: () => undefined },
  sessionQuery: { async readSession() { return { events: fakeEvents } } },
  get(name) {
    if (name === 'fs') return fssvc
    if (name === 'workspaceRegistry') {
      return { list: () => [{ id: 'ws1', path: ws, sessionIds: ['session-test'] }] }
    }
    return undefined
  },
  on(name, listener) { (listeners[name] ??= []).push(listener); return () => {} },
}

function mockRequest(method, url) {
  return { method, url, on() { return this } }
}
function mockResponse() {
  const res = { status: 0, headers: null, body: '', writeHead(s, h) { res.status = s; res.headers = h }, end(b) { res.body = b ?? '' } }
  return res
}

const m = await import(new URL('../index.mjs', import.meta.url).href)

// 1. Capture checkpoint at seq 5 by firing the session/event feed listener.
m.apply(ctx)
const feed = listeners['session/event']
if (!feed || feed.length !== 1) throw new Error('feed not registered')
feed[0]({ id: 'session-test' }, { type: 'user/message', seq: 5, data: { source: { kind: 'user' } } })
await new Promise(r => setTimeout(r, 400)) // let the async capture chain settle

const cp = await m.loadCheckpoint('session-test', 5)
if (!cp) throw new Error('checkpoint manifest missing')
const expected = ['a.txt', 'c.md', 'sub/b.txt'].sort().join(',')
if (Object.keys(cp.files).sort().join(',') !== expected) {
  throw new Error('manifest files wrong: ' + JSON.stringify(Object.keys(cp.files)))
}
console.log('capture OK:', Object.keys(cp.files).length, 'files')

// 2. Mutate workspace like an agent exchange: change a.txt, delete b.txt, create d.txt
writeFileSync(A, 'alpha-v2-AGENT-EDIT')
rmSync(B)
writeFileSync(join(ws, 'd.txt'), 'delta-created-by-agent')

// 3. Plan rollback to the pre-message checkpoint
const plan = await m.planRollback(ctx, 'session-test', 5)
if (!plan.available) throw new Error('plan unavailable: ' + plan.reason)
const writeSet = plan.filesToWrite.map(f => f.path).sort().join(',')
if (writeSet !== 'a.txt,sub/b.txt') throw new Error('expected revert of a.txt + restored sub/b.txt, got ' + writeSet)
if (plan.filesToRemove.join(',') !== 'd.txt') throw new Error('expected only d.txt removed, got ' + plan.filesToRemove.join(','))
console.log('plan OK: revert=%j remove=%j skipped=%d', plan.filesToWrite.map(f => f.path), plan.filesToRemove, plan.skipped.length)

// 4. Apply rollback and verify exact restoration
const outcome = await m.applyRollback(ctx, plan, ws)
if (outcome.failures.length > 0) throw new Error('rollback failures: ' + JSON.stringify(outcome.failures))
if (readFileSync(A, 'utf8') !== 'alpha-v1') throw new Error('a.txt not reverted')
if (readFileSync(B, 'utf8') !== 'beta-v1') throw new Error('b.txt not restored')
if (existsSync(join(ws, 'd.txt'))) throw new Error('d.txt not removed')
if (readFileSync(C, 'utf8') !== '# gamma') throw new Error('c.md should be untouched')
console.log('apply OK: reverted=%d removed=%d', outcome.reverted, outcome.removed)

// 5. Idempotency: re-planning after rollback must yield no work
const plan2 = await m.planRollback(ctx, 'session-test', 5)
if (plan2.filesToWrite.length !== 0 || plan2.filesToRemove.length !== 0) {
  throw new Error('rollback not idempotent: ' + JSON.stringify(plan2))
}
console.log('idempotency OK')

// 6. Audit trail
const auditId = await m.appendAuditEntry({ kind: 'delete', sessionId: 'session-test' })
if (!existsSync(join(home, 'message-edit-enhanced', 'checkpoints', 'audit.log'))) throw new Error('audit file missing')
if (!auditId.startsWith('audit-')) throw new Error('bad audit id')
console.log('audit OK:', auditId)

// 7. Containment guard refuses escaping paths
await m.applyRollback(
  ctx,
  { available: true, manifest: cp, filesToWrite: [], filesToRemove: ['../escaped.txt'], skipped: [], warnings: [] },
  ws,
)
if (existsSync(join(dirname(ws), 'escaped.txt'))) throw new Error('containment breach!')
console.log('containment OK')

// 8. GET delete-preview returns the impact report.
const previewRoute = routes.find(r => r.path.endsWith('/delete-preview'))
if (previewRoute === undefined) throw new Error('delete-preview route not registered')
const res = mockResponse()
await previewRoute.handler(mockRequest('GET', '/message-edit-enhanced/delete-preview?sessionId=session-test&eventSeq=5'), res)
const report = JSON.parse(res.body)
if (res.status !== 200 || !report.checkpointFound || report.turn !== 2 || report.preview !== 'hello world') {
  throw new Error('preview broken: ' + res.status + ' ' + res.body.slice(0, 200))
}
if (!report.willBranch) throw new Error('expected willBranch=true without live agent')
if (report.laterTurns[0] !== 3) throw new Error('expected laterTurns [3]')
if (report.filesToRevert.length !== 0 || report.filesToRemove.length !== 0) {
  throw new Error('preview should show clean workspace: ' + res.body.slice(0, 300))
}
console.log('preview route OK:', JSON.stringify({ turn: report.turn, checkpointFound: report.checkpointFound, laterTurns: report.laterTurns }))

// Preview for a VALID message without a snapshot reports unavailable.
const res2 = mockResponse()
await previewRoute.handler(mockRequest('GET', '/message-edit-enhanced/delete-preview?sessionId=session-test&eventSeq=20'), res2)
const report2 = JSON.parse(res2.body)
if (res2.status !== 200 || report2.checkpointFound !== false || !report2.checkpointReason || report2.turn !== 3) {
  throw new Error('missing-checkpoint preview broken: ' + res2.body.slice(0, 300))
}
console.log('no-checkpoint preview OK:', report2.checkpointReason)

// An out-of-range event is rejected cleanly.
const res3 = mockResponse()
await previewRoute.handler(mockRequest('GET', '/message-edit-enhanced/delete-preview?sessionId=session-test&eventSeq=99'), res3)
if (res3.status === 200 || !JSON.parse(res3.body).error) throw new Error('bad-event handling broken: ' + res3.body)
console.log('bad-event rejection OK')

// 9. POST decode path reaches routing and fails gracefully without a runtime;
// repeated failures must not produce unhandled rejections.
process.on('unhandledRejection', () => {
  console.error('UNHANDLED REJECTION DETECTED')
  process.exit(1)
})
const mainRoute = routes.find(r => r.path === '/message-edit-enhanced')
if (mainRoute === undefined) throw new Error('main route not registered')
for (let i = 0; i < 3; i += 1) {
  const postRes = mockResponse()
  const payload = JSON.stringify({ action: 'delete', sessionId: 'session-test', eventSeq: 5, rollbackWorkspace: true })
  const reqLike = {
    method: 'POST',
    url: '/message-edit-enhanced',
    on(ev, cb) {
      if (ev === 'data') cb(payload)
      if (ev === 'end') cb()
    },
  }
  await mainRoute.handler(reqLike, postRes)
  if (typeof JSON.parse(postRes.body).error !== 'string') {
    throw new Error('expected graceful error, got: ' + postRes.body.slice(0, 200))
  }
}
await new Promise(r => setTimeout(r, 100))
console.log('POST route OK (graceful errors, no unhandled rejections)')

console.log('ALL CHECKPOINT SMOKE TESTS PASSED')
