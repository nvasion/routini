// Screenshots of the real console for the public pages (see scripts/shots.sh,
// which starts the stack this talks to): client/src/assets/shots/<name>-<theme>.webp.
//
// Seeds a demo org ("Northwind") through the API: four hosts, each a real
// routini-runner in its own container, and jobs. Then it runs them for real
// under the default policy (commands on prod hosts wait for an admin, and
// Jordan approves them): health checks, a disk check on web-01, a log
// rotation left waiting in the Inbox, and an Alertmanager alert that opens an
// incident and runs the runbook on the alert's host. The runbook's agent step
// uses the agents/fake image, which replays a recorded transcript instead of
// calling a model. When the alert clears, the incident gets its postmortem.
//
// Env: BASE_URL (Vite), API_URL (server), RUNNER_IMAGE, CONTAINER_PREFIX, OUT,
// PLAYWRIGHT, CHROMIUM, DEBUG_OUT, ONLY.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT ? pathToFileURL(process.env.PLAYWRIGHT).href : 'playwright')
const BASE = (process.env.BASE_URL ?? 'http://localhost:5199').replace(/\/$/, '')
const API = (process.env.API_URL ?? 'http://localhost:3901').replace(/\/$/, '')
const RUNNER_IMAGE = process.env.RUNNER_IMAGE ?? 'routini/runner:shots'
const CONTAINER_PREFIX = process.env.CONTAINER_PREFIX ?? 'routini-shots-'
const OUT = process.env.OUT ?? 'client/src/assets/shots'
const DEBUG_OUT = process.env.DEBUG_OUT
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null
const VIEW = { width: 1440, height: 900 }
// File suffix -> data-theme id.
const THEME_IDS = { routini: 'routini', light: 'tynhub-light', dark: 'tynhub-dark' }

mkdirSync(OUT, { recursive: true })
if (DEBUG_OUT) mkdirSync(DEBUG_OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── API ───────────────────────────────────────────────────────────────────────
let token = ''
let org = ''
async function api(method, path, body, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && !opts.bearer ? { authorization: `Bearer ${token}` } : {}), ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}
const o = (p) => `/api/orgs/${org}${p}`

async function until(what, fn, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(1000)
  }
}

// ── Account ───────────────────────────────────────────────────────────────────
const email = 'jordan.rivera@example.com'
const password = 'shots-demo-password'
await api('POST', '/api/auth/signup', { email, password, displayName: 'Jordan Rivera', orgName: 'Northwind' })
const login = await api('POST', '/api/auth/login', { email, password })
token = login.token
org = login.orgs[0].slug

// ── Fleet: real runners, one container per "server" ───────────────────────────
// Each runner is the routini-runner image in its own container, so hosts get
// their own hostname and OS. web-02's /var/log is a small tmpfs filled to ~91%,
// which is what the disk alert below reports and what its runbook finds.
const HOSTS = [
  { name: 'web-01', group: 'web', tags: ['prod', 'nginx'] },
  { name: 'web-02', group: 'web', tags: ['prod', 'nginx'], args: ['--mount', 'type=tmpfs,destination=/var/log,tmpfs-size=512m,tmpfs-mode=1777'] },
  { name: 'db-01', group: 'db', tags: ['prod', 'postgres'] },
  { name: 'build-01', group: 'build', tags: ['ci'], agents: true },
]
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const RUNNER_URL = `http://host.docker.internal:${new URL(API).port}`
for (const h of HOSTS) {
  const { token: enrollToken } = await api('POST', o('/runners/enrollments'), { name: h.name, group: h.group, tags: h.tags })
  const name = `${CONTAINER_PREFIX}${h.name}`
  const common = ['run', '-d', '--name', name, '--hostname', h.name, '--add-host', 'host.docker.internal:host-gateway', ...(h.args ?? [])]
  if (h.agents) {
    // Agents need the host's Docker, and capabilities.agents set before the runner connects.
    const gid = docker('run', '--rm', '-v', '/var/run/docker.sock:/s', 'debian:bookworm-slim', 'stat', '-c', '%g', '/s')
    const cmd = `routini-runner enroll --url ${RUNNER_URL} --token ${enrollToken} --name ${h.name} && routini-runner agents enable && exec routini-runner run`
    docker(...common, '-v', '/var/run/docker.sock:/var/run/docker.sock', '--group-add', gid, '--entrypoint', 'bash', RUNNER_IMAGE, '-c', cmd)
  } else {
    docker(...common, '-e', `ROUTINI_RUNNER_URL=${RUNNER_URL}`, '-e', `ROUTINI_RUNNER_TOKEN=${enrollToken}`, '-e', `ROUTINI_RUNNER_NAME=${h.name}`, RUNNER_IMAGE)
  }
}
docker('exec', '-u', 'root', `${CONTAINER_PREFIX}web-02`, 'bash', '-c', 'mkdir -p /var/log/nginx /var/log/journal && head -c 400M /dev/zero > /var/log/journal/system.journal && head -c 66M /dev/zero > /var/log/nginx/access.log')
let lastHosts = []
const hosts = await until('four runner hosts online', async () => {
  const { hosts } = await api('GET', o('/hosts'))
  lastHosts = hosts
  return hosts.length === HOSTS.length && hosts.every((h) => h.runner?.online) ? hosts : null
}).catch((e) => {
  console.error(JSON.stringify(lastHosts, null, 2))
  throw e
})
const hostId = Object.fromEntries(hosts.map((h) => [h.name, h.id]))

// ── Settings: Claude Code through a gateway (the fake image never calls it) ───
await api('PUT', o('/settings'), {
  ai: { defaultAgent: 'claude', agents: { claude: { endpoint: 'gateway', model: 'claude-sonnet-5', gatewayUrl: 'https://models.northwind.internal' } } },
})

// ── Jobs ──────────────────────────────────────────────────────────────────────
const step = (id, name, kind, config, extra = {}) => ({ id, name, kind, config, when: 'on_success', retries: 0, ...extra })
const job = (spec) => api('POST', o('/jobs'), { enabled: true, description: '', ...spec }).then((r) => r.job)

const diskCheck = await job({
  name: 'Disk check',
  description: 'Every six hours: disk usage on web-01.',
  trigger: { kind: 'cron', expr: '0 */6 * * *', tz: 'UTC' },
  steps: [step('disk', 'Disk usage', 'action', { type: 'ssh', hostId: hostId['web-01'], command: 'df -h /' })],
})
const bumps = await job({
  name: 'Nightly dependency bumps',
  description: 'Patch and minor updates for the storefront, as a pull request with the tests passing.',
  trigger: { kind: 'cron', expr: '0 3 * * 1-5', tz: 'America/Los_Angeles' },
  steps: [
    step('bump', 'Bump dependencies', 'agent', {
      agent: 'claude',
      prompt: 'Update patch and minor dependency versions. Read each changelog for breaking changes, run the tests, and summarize what changed in the PR description.',
      repo: { url: 'https://github.com/northwind/storefront', baseBranch: 'main' },
      check: { command: 'npm test' },
      output: 'pr',
      runOn: { pool: { group: 'build', tags: ['ci'] } },
    }),
  ],
})
const rotate = await job({
  name: 'Rotate nginx logs',
  description: 'Force a log rotation on the web servers.',
  trigger: { kind: 'manual' },
  steps: [
    step('ok', 'Approve the rotation', 'approval', { message: 'Rotate and reload nginx on web-01 and web-02?', minRole: 'admin' }),
    step('rotate-1', 'Rotate on web-01', 'action', { type: 'ssh', hostId: hostId['web-01'], command: 'sudo logrotate -f /etc/logrotate.d/nginx' }),
    step('rotate-2', 'Rotate on web-02', 'action', { type: 'ssh', hostId: hostId['web-02'], command: 'sudo logrotate -f /etc/logrotate.d/nginx' }),
  ],
})
await job({
  name: 'Disk runbook',
  description: 'When a disk alert fires: look at the mount on the alert’s host, then have an agent say what to clean up.',
  trigger: { kind: 'alert', match: { alertnames: ['DiskAlmostFull'] } },
  steps: [
    step('df', 'Disk usage on the mount', 'action', { type: 'ssh', host: 'alert', command: 'df -h {{alert.labels.mount}}' }),
    step('logs', 'Largest log directories', 'action', { type: 'ssh', host: 'alert', command: 'du -xh --max-depth=1 {{alert.labels.mount}} | sort -h | tail -5' }),
    step('advise', 'Recommend a fix', 'agent', { agent: 'claude', prompt: 'An alert says the disk is almost full. Using this output, say what is filling it and the safest fix:\n{{steps.df.stdout}}\n{{steps.logs.stdout}}', output: 'none' }),
  ],
})
const health = await job({
  name: 'API health',
  description: 'The storefront API answers.',
  trigger: { kind: 'cron', expr: '*/15 * * * *', tz: 'UTC' },
  steps: [step('ping', 'GET /health', 'action', { type: 'http', url: 'https://routini.tynhub.com/health', expectStatus: 200 })],
})

// ── Runs ──────────────────────────────────────────────────────────────────────
const runJob = (j) => api('POST', o(`/jobs/${j.id}/run`), {}).then((r) => r.run)
const runDone = (r) => until(`run #${r.number}`, async () => {
  const { run } = await api('GET', o(`/runs/${r.number}`))
  return ['succeeded', 'failed', 'canceled', 'waiting'].includes(run.status) ? run : null
})
/** Approves each step the run waits on (as Jordan, an admin) until it finishes. */
async function approveThrough(r, comment) {
  for (;;) {
    const cur = await runDone(r)
    if (cur.status !== 'waiting') return cur
    const { steps } = await api('GET', o(`/runs/${r.number}`))
    const w = steps.find((s) => s.status === 'waiting')
    // Just approved: the run is still marked waiting until the step starts.
    if (w) await api('POST', o(`/runs/${r.number}/steps/${w.idx ?? w.index}/approve`), { comment })
    await sleep(1000)
  }
}
for (let i = 0; i < 3; i++) await runDone(await runJob(health))
// web-01 is tagged prod, so the default policy holds the command for an admin.
const diskRun = await approveThrough(await runJob(diskCheck), 'Read-only, fine to run.')
// Left waiting: this is the approval the Inbox shows.
const rotateRun = await runDone(await runJob(rotate))

// ── Alert → incident → runbook ────────────────────────────────────────────────
const alertToken = (await api('POST', o('/alerts/token'), {})).token
const alert = (status) => ({
  receiver: 'routini',
  status,
  alerts: [
    {
      status,
      labels: { alertname: 'DiskAlmostFull', severity: 'warning', instance: 'web-02', mount: '/var/log' },
      annotations: { summary: '/var/log on web-02 is 91% full', description: 'The /var/log filesystem on web-02 has less than 10% free.' },
      startsAt: new Date(Date.now() - 6 * 60000).toISOString(),
      ...(status === 'resolved' ? { endsAt: new Date().toISOString() } : {}),
    },
  ],
})
await api('POST', `/api/alerts/${org}`, alert('firing'), { bearer: alertToken })
const openIncident = await until('incident with its runbook run', async () => {
  const { incidents } = await api('GET', o('/incidents?status=open'))
  if (!incidents?.length) return null
  const detail = await api('GET', o(`/incidents/${incidents[0].number}`))
  return detail.runs?.length ? detail : null
})
// The runbook's commands target a prod host, so policy holds them for approval too.
const runbookRun = await approveThrough(openIncident.runs[0], 'Go ahead: read-only diagnostics.')
// The alert clears: the incident resolves and Routini drafts the postmortem.
await api('POST', `/api/alerts/${org}`, alert('resolved'), { bearer: alertToken })
const incident = await until('resolved incident with a postmortem draft', async () => {
  const detail = await api('GET', o(`/incidents/${openIncident.incident.number}`))
  return detail.incident.status === 'resolved' && detail.incident.postmortem ? detail : null
})

console.log('seeded', { org, disk: diskRun.status, rotate: rotateRun.status, runbook: runbookRun.status, incident: incident.incident.status })
if (runbookRun.status !== 'succeeded') throw new Error(`the runbook run #${runbookRun.number} ${runbookRun.status}: ${runbookRun.error ?? ''}`)

// ── Browser ───────────────────────────────────────────────────────────────────
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, reducedMotion: 'reduce' })
const page = await context.newPage()
page.setDefaultNavigationTimeout(180000)
page.on('pageerror', (e) => console.error('[page error]', e.message))
await page.goto(`${BASE}/`)
const lr = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password } })
if (!lr.ok()) throw new Error(`browser login failed: ${lr.status()}`)

async function setTheme(theme) {
  await page.evaluate((t) => localStorage.setItem('routini.theme', t), THEME_IDS[theme])
}
// Console pages hold an SSE stream open, so the network never goes idle: wait
// for the page's own heading (and anything it names) instead.
async function go(path, ready) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.locator('main h1, main .page-title').first().waitFor({ timeout: 60000 })
  if (ready) await page.getByText(ready, { exact: false }).first().waitFor({ timeout: 60000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(800)
}
/** Captures the viewport, scrolled to the top or to the first element with `scrollText`. */
async function capture(name, theme, scrollText) {
  if (ONLY && !ONLY.has(name)) return
  if (scrollText) {
    await page.getByText(scrollText, { exact: true }).first().evaluate((el) => {
      const top = el.getBoundingClientRect().top + window.scrollY - 8
      window.scrollTo(0, top)
    })
  } else {
    await page.evaluate(() => window.scrollTo(0, 0))
  }
  await page.waitForTimeout(150)
  const png = await page.screenshot({ type: 'png' })
  const webp = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    c.getContext('2d').drawImage(img, 0, 0)
    return c.toDataURL('image/webp', 0.86).split(',')[1]
  }, png.toString('base64'))
  const file = join(OUT, `${name}-${theme}.webp`)
  writeFileSync(file, Buffer.from(webp, 'base64'))
  console.log('wrote', file)
  if (DEBUG_OUT) await page.screenshot({ path: join(DEBUG_OUT, `${name}-${theme}.png`), fullPage: true })
}

const incNumber = incident.incident?.number ?? incident.number
// [name, path, text that shows the page has its data, text to scroll to]
const SHOTS = [
  ['fleet', `/o/${org}/fleet`, 'build-01'],
  // The trigger, the agent step and its pool match fit one screen from "Trigger" down.
  ['job', `/o/${org}/jobs/${bumps.id}`, 'can run agents now', 'Trigger'],
  ['run', `/o/${org}/runs/${runbookRun.number}`, 'Recommend a fix'],
  ['inbox', `/o/${org}/inbox`, 'Rotate nginx logs'],
  ['incident', `/o/${org}/incidents/${incNumber}`, 'Disk runbook'],
  ['integrations', `/o/${org}/integrations`, 'Azure DevOps'],
  ['policy', `/o/${org}/settings/policy`, 'Egress allow-list'],
]
try {
  for (const theme of Object.keys(THEME_IDS)) {
    await setTheme(theme)
    for (const [name, path, ready, scrollText] of SHOTS) {
      if (ONLY && !ONLY.has(name)) continue
      await go(path, ready)
      await capture(name, theme, scrollText)
    }
  }
} finally {
  await browser.close()
}
