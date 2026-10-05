// ─────────────────────────────────────────────────────────────────────────────
// Org policy
//
//   GET  /api/orgs/:org/policy             rules + egress allow-list (+ isDefault)
//   PUT  /api/orgs/:org/policy             { rules?, egress? }                  (admin)
//   POST /api/orgs/:org/policy/evaluate    { steps } → decision per step (dry run for the job editor)
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import { ah, badRequest, currentOrg, currentUser, type AppContext } from '../http/common.js'
import { requireRole } from '../http/orgContext.js'
import { evaluatePolicy, parseRules, PolicyError, stepFacts } from '../engine/policy.js'
import { parseSteps, SpecError } from '../engine/spec.js'
import { getPolicy, parseEgress, savePolicy } from '../repos/policy.js'

export function policyRouter(ctx: AppContext): Router {
  const r = Router({ mergeParams: true })

  r.get(
    '/policy',
    ah(async (req, res) => {
      const org = currentOrg(req)
      res.json({ policy: await ctx.db.org(org.id, (q) => getPolicy(q, org.id, ctx.config.mode)), brokerEnabled: Boolean(ctx.broker) })
    }),
  )

  r.put(
    '/policy',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const b = (req.body ?? {}) as Record<string, unknown>
      const policy = await ctx.db.org(org.id, async (q) => {
        const current = await getPolicy(q, org.id, ctx.config.mode)
        let rules = current.rules
        let egress = current.egress
        try {
          if (b['rules'] !== undefined) rules = parseRules(b['rules'])
          if (b['egress'] !== undefined) egress = parseEgress(b['egress'])
        } catch (err) {
          if (err instanceof PolicyError || err instanceof Error) throw badRequest(err.message)
          throw err
        }
        await savePolicy(q, org.id, currentUser(req).id, { rules, egress })
        return getPolicy(q, org.id, ctx.config.mode)
      })
      res.json({ policy, brokerEnabled: Boolean(ctx.broker) })
    }),
  )

  r.post(
    '/policy/evaluate',
    ah(async (req, res) => {
      const org = currentOrg(req)
      let steps
      try {
        steps = parseSteps((req.body ?? {})['steps'])
      } catch (err) {
        if (err instanceof SpecError) throw badRequest(err.message)
        throw err
      }
      const decisions = await ctx.db.org(org.id, async (q) => {
        const policy = await getPolicy(q, org.id, ctx.config.mode)
        const out = []
        for (const s of steps) {
          const d = evaluatePolicy(policy.rules, await stepFacts(q, org.id, s))
          out.push({ stepId: s.id, effect: d.effect, rule: d.rule ? { id: d.rule.id, name: d.rule.name, minRole: d.rule.minRole, reason: d.rule.reason } : null })
        }
        return out
      })
      res.json({ decisions })
    }),
  )

  return r
}
