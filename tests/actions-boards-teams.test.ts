// Azure Boards and Microsoft Teams actions: spec validation, the two Azure
// DevOps REST calls (WIQL query + work item batch), the Teams webhook post,
// templating between steps, and that credentials never leak into run state.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { Worker } from '../server/src/engine/worker'
import type { FetchFn } from '../server/src/integrations/providers'

const ADO_PAT = 'adopat-SECRET'
const TEAMS_WEBHOOK = 'https://prod-01.westus.logic.azure.com/workflows/abc?sig=SECRETSIG'

interface FakeCall {
  url: string
  init: RequestInit
}

let t: TestApp
let u: TestUser
const base = () => `/api/orgs/${u.orgSlug}`
const calls: FakeCall[] = []

let wiql: { status: number; body: unknown }
let batch: { status: number; body: unknown }
let teams: { status: number }

const integrationFetch: FetchFn = async (url, init) => {
  calls.push({ url, init: init ?? {} })
  if (url.includes('/_apis/wit/wiql')) return new Response(JSON.stringify(wiql.body), { status: wiql.status })
  if (url.includes('/_apis/wit/workitemsbatch')) return new Response(JSON.stringify(batch.body), { status: batch.status })
  if (url.startsWith(TEAMS_WEBHOOK.split('?')[0]!)) return new Response('', { status: teams.status })
  throw new Error(`unexpected fetch to ${url}`)
}

async function createJob(steps: unknown[]) {
  const job = await u.post(`${base()}/jobs`, { name: 'J', steps })
  return job
}

async function createAndRun(steps: unknown[]) {
  const job = await createJob(steps)
  expect(job.status, JSON.stringify(job.body)).toBe(201)
  const run = (await u.post(`${base()}/jobs/${job.body.job.id}/run`)).body.run as { number: number; id: string }
  await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
  return {
    detail: (await u.get(`${base()}/runs/${run.number}`)).body,
    events: (await u.get(`${base()}/runs/${run.id}/events`)).body.events as Array<{ type: string; data: Record<string, unknown> }>,
    run,
  }
}

const connectAzureDevops = (organization = 'contoso', pat = ADO_PAT) => u.put(`${base()}/integrations/azure-devops`, { credentials: { organization, pat } })
const connectTeams = (webhookUrl = TEAMS_WEBHOOK) => u.put(`${base()}/integrations/teams`, { credentials: { webhookUrl } })

const boardsStep = (config: Record<string, unknown> = {}) => ({ id: 'board', kind: 'action', config: { type: 'azure-boards', project: 'Fabrikam Web', ...config } })
const teamsStep = (config: Record<string, unknown> = {}) => ({ id: 'teams', kind: 'action', config: { type: 'teams', message: 'hello', ...config } })

describe('azure-boards and teams actions', () => {
  beforeEach(async () => {
    calls.length = 0
    wiql = { status: 200, body: { workItems: [{ id: 7 }, { id: 3 }, { id: 9 }] } }
    batch = {
      status: 200,
      body: {
        value: [
          { id: 7, fields: { 'System.Title': 'Fix login', 'System.State': 'Active', 'System.WorkItemType': 'Bug', 'System.AssignedTo': { displayName: 'Ada' }, 'System.Tags': 'api; urgent' } },
          { id: 3, fields: { 'System.Title': 'Add docs', 'System.State': 'New', 'System.WorkItemType': 'Task' } },
        ],
      },
    }
    teams = { status: 202 }
    t = await makeTestApp({ engine: { actions: { integrationFetch } } })
    u = await t.signup('boards@example.com')
  })
  afterEach(() => t.close())

  describe('spec validation', () => {
    it('rejects a missing project', async () => {
      const res = await createJob([{ kind: 'action', config: { type: 'azure-boards' } }])
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/config\.project/)
    })

    it('rejects an invalid project name', async () => {
      const res = await createJob([{ kind: 'action', config: { type: 'azure-boards', project: 'a/b' } }])
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/config\.project is not a valid Azure DevOps project name/)
    })

    it('rejects limit 0', async () => {
      const res = await createJob([boardsStep({ limit: 0 })])
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/config\.limit/)
    })

    it('rejects limit 201', async () => {
      const res = await createJob([boardsStep({ limit: 201 })])
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/config\.limit/)
    })

    it('rejects a missing teams message', async () => {
      const res = await createJob([{ kind: 'action', config: { type: 'teams' } }])
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/config\.message/)
    })

    it('rejects a teams title over 200 characters', async () => {
      const res = await createJob([teamsStep({ title: 'x'.repeat(201) })])
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/config\.title/)
    })
  })

  describe('azure boards', () => {
    it('queries work items and fetches their fields', async () => {
      await connectAzureDevops()
      const { detail } = await createAndRun([boardsStep({ limit: 2 })])
      expect(detail.run.status).toBe('succeeded')

      const wiqlCall = calls.find((c) => c.url.includes('/_apis/wit/wiql'))!
      expect(wiqlCall.url).toBe('https://dev.azure.com/contoso/Fabrikam%20Web/_apis/wit/wiql?api-version=7.1&$top=2')
      expect((wiqlCall.init.headers as Record<string, string>)['Authorization']).toBe('Basic ' + Buffer.from(`:${ADO_PAT}`, 'utf8').toString('base64'))

      const batchCall = calls.find((c) => c.url.includes('/_apis/wit/workitemsbatch'))!
      const batchBody = JSON.parse(String(batchCall.init.body))
      expect(batchBody.ids).toEqual([7, 3])

      const output = detail.steps[0].output
      expect(output.count).toBe(2)
      expect(output.items[0]).toEqual({
        id: 7,
        title: 'Fix login',
        state: 'Active',
        type: 'Bug',
        assignedTo: 'Ada',
        tags: ['api', 'urgent'],
        url: 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/7',
      })
      expect(output.summary.split('\n')).toHaveLength(2)
    })

    it('uses the default query (filtering by @project) when none is given', async () => {
      await connectAzureDevops()
      await createAndRun([boardsStep()])
      const wiqlCall = calls.find((c) => c.url.includes('/_apis/wit/wiql'))!
      const body = JSON.parse(String(wiqlCall.init.body))
      expect(body.query).toContain('@project')
    })

    it('returns an empty result without calling the batch endpoint', async () => {
      await connectAzureDevops()
      wiql = { status: 200, body: { workItems: [] } }
      const { detail } = await createAndRun([boardsStep()])
      expect(calls.some((c) => c.url.includes('/_apis/wit/workitemsbatch'))).toBe(false)
      expect(detail.steps[0].output).toEqual({ count: 0, items: [], summary: 'No work items matched.' })
    })

    it('treats a 203 (sign-in page) as an invalid token', async () => {
      await connectAzureDevops()
      wiql = { status: 203, body: '<html>sign in</html>' }
      const { detail } = await createAndRun([boardsStep()])
      expect(detail.steps[0].error).toMatch(/did not accept the token \(sign-in page returned\)/)
    })

    it('surfaces an Azure DevOps error body on a 401', async () => {
      await connectAzureDevops()
      wiql = { status: 401, body: { message: 'TF400813: not authorized' } }
      const { detail } = await createAndRun([boardsStep()])
      expect(detail.steps[0].error).toContain('HTTP 401')
      expect(detail.steps[0].error).toContain('TF400813')
    })

    it('fails clearly when Azure DevOps is not connected', async () => {
      const { detail } = await createAndRun([boardsStep()])
      expect(detail.steps[0].error).toMatch(/Azure DevOps integration is not connected/)
    })
  })

  describe('teams', () => {
    it('posts the rendered message and title', async () => {
      await connectAzureDevops()
      await connectTeams()
      const { detail, events } = await createAndRun([boardsStep({ limit: 2 }), teamsStep({ title: 'Nightly', message: 'Done: {{steps.board.count}}' })])
      expect(detail.run.status).toBe('succeeded')
      const webhookCall = calls.find((c) => c.url.startsWith(TEAMS_WEBHOOK.split('?')[0]!))!
      const body = JSON.parse(String(webhookCall.init.body)) as { attachments: Array<{ content: { body: Array<{ type: string; text: string }> } }> }
      const blocks = body.attachments[0]!.content.body
      expect(blocks.some((b) => b.type === 'TextBlock' && b.text === 'Nightly')).toBe(true)
      expect(blocks.some((b) => b.type === 'TextBlock' && b.text === 'Done: 2')).toBe(true)
      expect(detail.steps[1].output).toEqual({ posted: true })
      expect(events.some((e) => e.type === 'log' && e.data['message'] === 'Posted to Microsoft Teams')).toBe(true)
    })

    it('renders {{steps.board.summary}} into the message', async () => {
      await connectAzureDevops()
      await connectTeams()
      const { detail } = await createAndRun([boardsStep({ limit: 2 }), teamsStep({ message: '{{steps.board.summary}}' })])
      expect(detail.run.status).toBe('succeeded')
      const webhookCall = calls.find((c) => c.url.startsWith(TEAMS_WEBHOOK.split('?')[0]!))!
      const body = JSON.parse(String(webhookCall.init.body)) as { attachments: Array<{ content: { body: Array<{ type: string; text: string }> } }> }
      const text = body.attachments[0]!.content.body.map((b) => b.text).join('\n')
      expect(text).toContain('#7')
      expect(text).toContain('#3')
    })

    it('fails clearly when Teams is not connected', async () => {
      const { detail } = await createAndRun([teamsStep()])
      expect(detail.steps[0].error).toMatch(/Microsoft Teams integration is not connected/)
    })

    it('fails the step when the webhook returns an error status', async () => {
      await connectTeams()
      teams = { status: 500 }
      const { detail } = await createAndRun([teamsStep()])
      expect(detail.steps[0].error).toBe('Teams webhook returned status 500')
    })
  })

  describe('secrets', () => {
    it('never leaks the PAT or the webhook signature into run state', async () => {
      await connectAzureDevops()
      await connectTeams()
      const { detail, events } = await createAndRun([boardsStep({ limit: 2 }), teamsStep({ message: 'Done: {{steps.board.count}}' })])
      const dump = JSON.stringify(detail) + JSON.stringify(events)
      expect(dump).not.toContain(ADO_PAT)
      expect(dump).not.toContain('SECRETSIG')
    })
  })
})
