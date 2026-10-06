// Public guide: from a new account to a job running on your own server, then
// guardrails, alerts, Claude Code and self-hosting. Brief on purpose.

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PublicLayout, REPO_URL, useSignupOpen } from './PublicLayout'

interface Section {
  id: string
  title: string
  body: ReactNode
}

const Code = ({ children }: { children: string }) => <pre className="code doc-code">{children}</pre>
const Path = ({ children }: { children: ReactNode }) => <span className="doc-path">{children}</span>

function sections(signupOpen: boolean | null): Section[] {
  return [
    {
      id: 'account',
      title: 'Create your account',
      body: (
        <>
          <p>
            {signupOpen === false ? (
              <>
                This server has signup closed. <Link to="/login">Sign in</Link> with the account an admin made for you, or continue with TynHub if your org is linked.
              </>
            ) : (
              <>
                <Link to="/signup">Create an account</Link> with your email, or use <strong>Continue with TynHub</strong> when your server offers it.
              </>
            )}{' '}
            Your account starts with its own org: a workspace for jobs, servers and people. You can invite others under <Path>Settings → Members</Path>.
          </p>
          <p className="muted">On a server you run yourself, the first account owns the server, and further signups are closed unless you open them.</p>
        </>
      ),
    },
    {
      id: 'model',
      title: 'Add a model key',
      body: (
        <p>
          Coding agents run on your own model account. Open <Path>Settings → Models</Path>, pick a provider (Anthropic, OpenRouter, OpenAI, Google, DigitalOcean and
          others) and paste your key. Keys are encrypted and never shown again. You can skip this until you want agents: jobs with HTTP or command steps work without it.
        </p>
      ),
    },
    {
      id: 'server',
      title: 'Connect a server',
      body: (
        <>
          <p>
            Go to <Path>Fleet → Add server</Path>, give it a name and group, and copy the install command onto the server (systemd), or run the Docker one:
          </p>
          <Code>{`curl -fsSL https://raw.githubusercontent.com/nvasion/routini-runner/main/scripts/install.sh \\
  | sudo sh -s -- --url https://your-routini --token rre_…`}</Code>
          <p>
            The runner dials out to Routini over HTTPS. It opens no ports, and Routini stores no SSH keys. The server appears in Fleet with live disk, memory and load, and
            admins can open an audited terminal on it. Prefer SSH? Add the host under <Path>Settings → Hosts</Path> with a key from <Path>Settings → Credentials</Path>.
          </p>
        </>
      ),
    },
    {
      id: 'job',
      title: 'Create your first job',
      body: (
        <>
          <p>
            A job is a <strong>trigger</strong> plus <strong>steps</strong>. Open <Path>Jobs → New job</Path>:
          </p>
          <ul>
            <li>
              <strong>Trigger:</strong> manual, a schedule (cron with a time zone), a webhook, or an alert.
            </li>
            <li>
              <strong>Steps:</strong> an HTTP check, a <em>command</em> on a server, an IMAP check, a Factory build, a coding <em>agent</em>, or an <em>approval</em> that waits
              for a person.
            </li>
          </ul>
          <p>
            Try a schedule of <span className="mono">0 */6 * * *</span> with a command step on your server running <span className="mono">df -h /</span>. Press{' '}
            <strong>Run now</strong> and watch the output stream into the run timeline. Then add an agent step with a repository and a prompt: it works in a sandbox, runs
            your check (for example <span className="mono">npm test</span>), and opens a pull request.
          </p>
        </>
      ),
    },
    {
      id: 'guardrails',
      title: 'Set your guardrails',
      body: (
        <p>
          Under <Path>Settings → Policy</Path>, add rules such as &ldquo;commands on servers tagged <span className="mono">prod</span> need an admin&rsquo;s
          approval&rdquo;. The job editor shows each step&rsquo;s decision as you build it. Approvals appear in your <Path>Inbox</Path>. With the credential broker on,
          agents only see placeholders: real keys are added outside their sandbox, and anything not on your allow-list is blocked.
        </p>
      ),
    },
    {
      id: 'alerts',
      title: 'Turn alerts into runbooks',
      body: (
        <>
          <p>
            Create a token in <Path>Settings → Alerts</Path> and point Alertmanager (or Grafana, or any webhook) at the URL shown there. A firing alert opens an incident; give a
            job an <strong>Alert</strong> trigger and it runs on the affected server (&ldquo;The alert&rsquo;s host&rdquo;). Use values from the alert in commands and prompts:
          </p>
          <Code>{`df -h {{alert.labels.mount}}            # passed safely, never as shell code
Summarize: {{steps.diag.stdout}}        # an earlier step's output, in an agent prompt`}</Code>
          <p>When the alert resolves, the incident closes and Routini drafts a postmortem from the timeline. You edit it from there.</p>
        </>
      ),
    },
    {
      id: 'mcp',
      title: 'Use Routini from Claude Code',
      body: (
        <>
          <p>
            Create a token in <Path>Settings → API tokens</Path>. The page gives you the command:
          </p>
          <Code>{`claude mcp add --transport http routini https://your-routini/mcp \\
  --header "Authorization: Bearer rtk_…"`}</Code>
          <p>
            Then ask: &ldquo;what failed overnight?&rdquo;, &ldquo;run the disk check on web-01&rdquo;, &ldquo;what&rsquo;s open right now?&rdquo;. Commands follow your
            policy like any run, and approving is never something a client can do.
          </p>
        </>
      ),
    },
    {
      id: 'self-host',
      title: 'Run it yourself',
      body: (
        <>
          <p>Routini is open source. On any machine with Docker:</p>
          <Code>{`git clone ${REPO_URL}.git && cd routini
make local        # stack + a connected runner on http://localhost:8088`}</Code>
          <p>
            For a server install, copy <span className="mono">.env.example</span> to <span className="mono">.env</span>, set the three secrets, run{' '}
            <span className="mono">make agents</span>, then <span className="mono">docker compose up --build -d</span>. The README covers configuration, the credential broker
            and signing in with TynHub.
          </p>
        </>
      ),
    },
  ]
}

export function GettingStartedPage() {
  const signupOpen = useSignupOpen()
  const list = sections(signupOpen)
  return (
    <PublicLayout>
      <div className="doc">
        <aside className="doc-toc" aria-label="On this page">
          <span className="nav-label">Getting started</span>
          <ol>
            {list.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </aside>
        <article className="doc-body">
          <h1 className="page-title">Getting started</h1>
          <p className="lead">From a new account to a job running on your own server in about five minutes, then the parts that make it safe to leave running.</p>
          {list.map((s, i) => (
            <section key={s.id} id={s.id} className="doc-section" aria-labelledby={`${s.id}-h`}>
              <h2 id={`${s.id}-h`}>
                <span className="step-n">{i + 1}</span> {s.title}
              </h2>
              {s.body}
            </section>
          ))}
          <div className="card doc-next">
            <strong>Ready?</strong>
            <span className="muted">Everything above runs on your own model keys, hosted or on your own machine.</span>
            <div className="inline">
              {signupOpen !== false ? (
                <Link className="btn primary" to="/signup">
                  Create your account
                </Link>
              ) : (
                <Link className="btn primary" to="/login">
                  Sign in
                </Link>
              )}
              <a className="btn" href={REPO_URL} target="_blank" rel="noreferrer">
                Read the README
              </a>
            </div>
          </div>
        </article>
      </div>
    </PublicLayout>
  )
}
