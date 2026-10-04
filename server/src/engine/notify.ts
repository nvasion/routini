// Email notification when a run finishes, per the org's notification settings.
// SMTP itself is operator configuration (SMTP_* env); with no SMTP_HOST this is a no-op.

import type { AppContext } from '../http/common.js'
import { getOrgSettings } from '../repos/settings.js'
import type { Run } from '../repos/runs.js'
import { createTransporter, sendTaskOutcomeNotification, type MailTransporter } from '../services/email.js'

export function runNotifier(app: Pick<AppContext, 'db'>, transporter: () => MailTransporter | null = createTransporter) {
  return async (run: Run): Promise<void> => {
    if (run.status === 'canceled') return
    const { notifications: n } = await app.db.org(run.orgId, (q) => getOrgSettings(q, run.orgId))
    if (!n.enabled || !n.recipientEmail) return
    if (run.status === 'succeeded' && !n.notifyOnSuccess) return
    if (run.status === 'failed' && !n.notifyOnFailure) return
    await sendTaskOutcomeNotification(
      {
        taskId: `#${run.number}`,
        taskName: run.jobSnapshot.name,
        taskType: 'run',
        status: run.status,
        timestamp: run.finishedAt ?? new Date().toISOString(),
        error: run.error ?? undefined,
      },
      n.recipientEmail,
      transporter(),
    )
  }
}
