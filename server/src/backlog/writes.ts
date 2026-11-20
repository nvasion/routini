// ─────────────────────────────────────────────────────────────────────────────
// Status writes: sends each due backlog_writes row to its source through the
// adapter, then completes or retries it. Contract:
// docs/work-intake-backlog.md section 7.
// ─────────────────────────────────────────────────────────────────────────────

import type { AppContext } from '../http/common.js'
import { getOrgById } from '../repos/identity.js'
import { getRun } from '../repos/runs.js'
import {
  claimDueWrites,
  completeWrite,
  getItem,
  getSource,
  retryWrite,
  type BacklogItem,
  type BacklogWrite,
} from '../repos/backlog.js'
import { adapterCtx } from './context.js'
import { getAdapter } from './index.js'

/** `<publicUrl>/o/<org slug>/runs/<n>` for the item's last run, or null when there is none (or the org/run has gone). */
async function lastRunLink(app: AppContext, orgId: string, item: BacklogItem): Promise<string | null> {
  if (!item.lastRunId) return null
  const [org, run] = await Promise.all([getOrgById(app.db, orgId), app.db.org(orgId, (q) => getRun(q, orgId, item.lastRunId!))])
  if (!org || !run) return null
  return `${app.config.publicUrl}/o/${org.slug}/runs/${run.number}`
}

/** The write's note, the item's last run link, and its pull request — whatever of those exist, one per line. */
async function buildComment(app: AppContext, write: BacklogWrite, item: BacklogItem): Promise<string> {
  const lines: string[] = []
  if (write.note) lines.push(write.note)
  const link = await lastRunLink(app, write.orgId, item)
  if (link) lines.push(link)
  if (item.pullRequestUrl) lines.push(item.pullRequestUrl)
  return lines.join('\n')
}

async function processWrite(app: AppContext, write: BacklogWrite): Promise<void> {
  const { source, item } = await app.db.org(write.orgId, async (q) => ({
    source: await getSource(q, write.orgId, write.sourceId),
    item: await getItem(q, write.orgId, write.itemId),
  }))
  // The item or source is gone (cascaded delete raced the claim): nothing left to write.
  if (!source || !item) {
    await app.db.org(write.orgId, (q) => completeWrite(q, write.orgId, write.id))
    return
  }

  const mapped = source.mapping.out[write.state]
  if (!mapped) {
    // The mapping no longer writes this state (edited after the write was queued): complete without writing.
    await app.db.org(write.orgId, (q) => completeWrite(q, write.orgId, write.id))
    return
  }

  try {
    const comment = mapped.comment ? await buildComment(app, write, item) : undefined
    await getAdapter(source.kind).write(
      adapterCtx(app, write.orgId),
      source.config,
      { externalId: item.externalId, title: item.title, url: item.url },
      { value: mapped.value, comment },
    )
    await app.db.org(write.orgId, (q) => completeWrite(q, write.orgId, write.id))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await app.db.org(write.orgId, (q) => retryWrite(q, write.orgId, write.id, message))
  }
}

/** Claims every due write and sends each; one write's failure never stops the others. */
export async function writesTick(app: AppContext): Promise<void> {
  const writes = await app.db.system((q) => claimDueWrites(q, 20))
  for (const write of writes) {
    try {
      await processWrite(app, write)
    } catch (err) {
      console.error(`[backlog] writes tick: write ${write.id} failed:`, err instanceof Error ? err.message : err)
    }
  }
}
