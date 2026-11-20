# Work intake: backlog and status (contract)

Phase 3 of work intake (design: tynhub-prds `PRD-routini-work-intake.md`). Builds on P1 (step `if`, agent `returns`, read-only repo) and P2 (Factory as a builder, `startFrom`).

A team connects where its work is tracked (a monday board, or a repo of spec files). Routini syncs the items, a scheduled job takes ready items one run each, and Routini writes each item's state back to where it came from. This file is the contract every part is built against: names, shapes, messages and rules are fixed. Follow `CLAUDE.md` (tenancy, migrations, run state, secrets, network safety).

## 1. States

Routini keeps one state per item: `ready | planning | building | finishing | done | blocked | dropped`.

- `ready`: waiting to be picked. `planning`, `building`, `finishing`: a run has it (the item is leased: `run_id` set). `done`: a run opened a PR. `blocked`: a run failed or ended without a PR; it waits for a person. `dropped`: the source says it won't be done.
- **Nothing automatic moves an item out of `blocked`.** Only a person does, either with "Set ready" in Routini or by changing the item's status at the source to a ready value (which the next sync reads). The scheduler never retries a blocked item.

## 2. Tables (migration 11, "Backlog sources, items and status writes")

All four are tenant tables: `org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE` and `SELECT routini_tenant('<table>')`.

```
backlog_sources
  id uuid PK DEFAULT gen_random_uuid(), org_id,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80), UNIQUE (org_id, name),
  kind text NOT NULL CHECK (kind IN ('monday','repo')),
  config jsonb NOT NULL, mapping jsonb NOT NULL,
  default_repo_url text, default_base_branch text NOT NULL DEFAULT 'main', factory_project_id text,
  enabled boolean NOT NULL DEFAULT true,
  sync_every_min integer NOT NULL DEFAULT 5 CHECK (sync_every_min BETWEEN 1 AND 1440),
  next_sync_at timestamptz NOT NULL DEFAULT now(), last_sync_at timestamptz, last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()

backlog_items
  id uuid PK, org_id, source_id uuid NOT NULL REFERENCES backlog_sources(id) ON DELETE CASCADE,
  external_id text NOT NULL, UNIQUE (source_id, external_id),
  title text NOT NULL, body text NOT NULL DEFAULT '', url text,
  repo_url text, base_branch text, labels text[] NOT NULL DEFAULT '{}',
  external_state text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('ready','planning','building','finishing','done','blocked','dropped')),
  state_note text, position double precision,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL, last_run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  built_by text, pull_request_url text, drop_after_run boolean NOT NULL DEFAULT false,
  created_at, updated_at
  INDEX (org_id, state), INDEX (source_id)

backlog_item_events
  id uuid PK, org_id, item_id uuid NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(), kind text NOT NULL, data jsonb NOT NULL DEFAULT '{}'
  INDEX (item_id, at)

backlog_writes
  id uuid PK, org_id, item_id uuid NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES backlog_sources(id) ON DELETE CASCADE,
  state text NOT NULL, note text, attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
  done_at timestamptz, failed_at timestamptz, created_at
  UNIQUE INDEX (item_id) WHERE done_at IS NULL AND failed_at IS NULL   -- one pending write per item
```

Caps: title 300, body 20000, labels at most 20 of at most 60 chars, state_note 2000, 500 items per fetch.

## 3. Repository module `server/src/repos/backlog.ts`

`ItemState`, `ITEM_STATES`, `StatusMapping`, `SourceItem`, `AdapterCtx`, `StatusWrite` and `SourceAdapter` already exist in `server/src/backlog/types.ts`: import them from there (repos/backlog.ts re-exports ItemState and StatusMapping). Do not redefine them. Further types (exported, camelCase, ISO strings for times):

```ts
export interface BacklogSource { id; orgId; name; kind: 'monday' | 'repo'; config: Record<string, unknown>; mapping: StatusMapping;
  defaultRepoUrl: string | null; defaultBaseBranch: string; factoryProjectId: string | null; enabled: boolean; syncEveryMin: number;
  nextSyncAt: string; lastSyncAt: string | null; lastSyncError: string | null; createdAt: string; updatedAt: string }
export interface BacklogItem { id; orgId; sourceId; externalId; title; body; url: string | null; repoUrl: string | null; baseBranch: string | null;
  labels: string[]; externalState: string; state: ItemState; stateNote: string | null; position: number | null; runId: string | null;
  lastRunId: string | null; builtBy: string | null; pullRequestUrl: string | null; dropAfterRun: boolean; createdAt: string; updatedAt: string }
export interface BacklogWrite { id; orgId; itemId; sourceId; state: ItemState; note: string | null; attempts: number; nextAttemptAt: string;
  lastError: string | null; doneAt: string | null; failedAt: string | null; createdAt: string }
export type SourceInput = { name: string; kind: 'monday' | 'repo'; config: Record<string, unknown>; mapping: StatusMapping;
  defaultRepoUrl?: string | null; defaultBaseBranch?: string; factoryProjectId?: string | null; enabled?: boolean; syncEveryMin?: number }
```

Functions (tenant ones take `(q, orgId, ...)` and filter by org_id; `system` ones are for the scheduler only):

- `listSources`, `getSource(q, orgId, id)`, `createSource(q, orgId, input)`, `updateSource(q, orgId, id, partial)`, `deleteSource(q, orgId, id)`
- `listItems(q, orgId, { state?, sourceId?, q?, limit? })` (order: state group, then position, created_at; `q` matches title, case-insensitive), `getItem`, `listItemEvents(q, orgId, itemId)` (newest first, max 200)
- `insertItem(q, orgId, sourceId, fields, state)` and `updateItemFields(q, orgId, itemId, fields)` where fields = title, body, url, repoUrl, baseBranch, labels, externalState, position (caps applied here)
- `addItemEvent(q, orgId, itemId, kind, data)`
- `setItemState(q, orgId, itemId, state, opts: { note?: string | null; event: string; data?: object })`: updates state and state_note, adds the event, and, when the item's source has `mapping.out[state]`, queues a write (insert, or update the item's pending write in place: new state/note, attempts 0, next_attempt_at now). Returns the item.
- system `pickReadyItems(q, orgId, { sourceIds?, labels? }, limit)`: `state = 'ready' AND run_id IS NULL`, source enabled, any of sourceIds, all of labels; ordered by position NULLS LAST, created_at; `FOR UPDATE SKIP LOCKED`.
- `leaseItem(q, orgId, itemId, runId)`: sets run_id and state `planning` through setItemState (event `picked`, data { runId }).
- system `claimDueSources(q, limit)`: in one statement, pushes `next_sync_at` to now + sync_every_min for enabled due sources (FOR UPDATE SKIP LOCKED) and returns them. `recordSync(q, orgId, id, error | null)` sets last_sync_at and last_sync_error.
- system `claimDueWrites(q, limit)`: same claim pattern on pending writes (`done_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()`), pushing next_attempt_at 5 minutes ahead. `completeWrite(q, orgId, id)`. `retryWrite(q, orgId, id, error)`: attempts + 1, last_error, next_attempt_at = now + min(60, 2^(attempts-1)) minutes; at 8 attempts sets failed_at instead. `listFailedWrites(q, orgId)` (with item title and source name). `resetWrite(q, orgId, id)`: clears failed_at, attempts 0, due now.

## 4. Triggers, runs and templates

- Cron trigger gains an optional block: `{ kind: 'cron'; expr; tz; backlog?: { sourceIds?: string[]; labels?: string[]; maxPerFire: number } }`. Validation: sourceIds at most 20 uuids, labels at most 10 of 1-60 chars, maxPerFire integer 1-20. Messages name the field, like the rest of spec.ts.
- `schedulerTick` (engine/scheduler.ts): for a due job whose trigger has `backlog`, in the same transaction: `pickReadyItems(..., maxPerFire)`, and per item `createRun(q, job, { kind: 'backlog', itemId, sourceId, scheduledFor })` then `leaseItem`. No ready items means no run. next_run_at advances as today.
- `RunTrigger` gains `{ kind: 'backlog'; itemId: string; sourceId: string; scheduledFor?: string; userId?: string }` (server repos/runs.ts and client types).
- Template root `item` (engine/template.ts ROOTS, TemplateData.item), filled by `buildTemplateData` for backlog runs: `{ id, title, body, url, repo, baseBranch, labels, source, externalId, factoryProjectId }` where repo = item.repo_url ?? source.default_repo_url, baseBranch = item.base_branch ?? source.default_base_branch, source = source name, factoryProjectId = source.factory_project_id. Item text is untrusted (like alert labels): same insertion rules.
- Step `if` paths may also start with `item.`.
- `AgentConfig.repo` gains the variant `{ fromItem: true; readOnly?: boolean }`. prepareStep resolves it to `{ url, baseBranch, readOnly }` from the item data. Errors: "This step uses the item's repository, but the run was not started from a backlog item" and "Item '<title>' has no repository; set one on the item or its source". `startFrom` accepts a fromItem repo.
- Factory step: `projectId` may be exactly `{{item.factoryProjectId}}` and `repoUrl` exactly `{{item.repo}}` (renderStep renders both; an empty projectId after rendering fails "The item's source has no Factory project").
- `StepBase.stage?: 'planning' | 'building' | 'finishing'`. When a step of a backlog run starts running and has `stage`, the item moves to that state (event `stage`, data { step }).

## 5. Run end -> item (engine finishRun, backlog runs only)

- succeeded and any step output has `pullRequest.url` -> `done`; store pull_request_url and built_by (`factory-task` or `factory-orchestration` if a step output has `factory.kind` task/orchestration, else `routini`).
- succeeded without a PR -> `blocked`, note "Run #N finished without opening a pull request".
- failed -> `blocked`, note = the run's error. canceled -> `blocked`, note "Canceled in run #N".
- Always: run_id cleared, last_run_id set, event `run.finished` { runId, number, status }. If drop_after_run, the item goes to `dropped` instead (note "Dropped at the source while a run had it") and drop_after_run is cleared.

## 6. Source adapters `server/src/backlog/`

`types.ts` (exists; see it for SourceItem, AdapterCtx, StatusWrite, SourceAdapter). New: `index.ts` exporting `getAdapter(kind: 'monday' | 'repo'): SourceAdapter`.

- `mapping.ts`: `parseMapping(raw): StatusMapping` (out keys must be states, values 1-100 chars; in.ready 1-20 values; in.dropped 0-20). It rejects any out value for planning, building, finishing, done or blocked that matches in.ready: "'<value>' is written for <state> and read as ready; items would loop". `matchesAny(external, list)`: case-insensitive prefix match ("Planned (2026-11-11)" matches "Planned").
- `glob.ts`: `globToRegExp(glob)` supporting `**`, `*`, `?` (no dependency).
- `monday.ts`: config `{ boardId: string /* digits */, groupId?: string, statusColumnId: string, repoColumnId?: string, labelsColumnId?: string }`. POST `https://api.monday.com/v2` with headers `authorization: <apiToken>` (raw, monday integration) and `api-version: 2024-10`. Fetch: `boards(ids: [boardId]) { items_page(limit: 500) { items { id name url group { id } column_values { id text } } } }`, keeping groupId when set; state = status column text; repoUrl = repo column text; labels = labels column text split on commas. write: `change_simple_column_value(board_id, item_id, column_id: statusColumnId, value)` and, with a comment, `create_update(item_id, body)`. GraphQL `errors` -> throw with the first message.
- `repo.ts` (a repo used for tracking, on GitHub; github integration token, Bearer, always the fixed host `https://api.github.com`): config `{ repoUrl, branch /* default main */, glob, status: { kind: 'frontmatter'; key } | { kind: 'line'; prefix }, repoKey? }`. repoUrl must parse with `parseGithubRepo` (integrations/github.ts), else "repoUrl must be a https://github.com/<owner>/<repo> URL"; branch matches `^[A-Za-z0-9._/-]{1,200}$`; path segments are URL-encoded.
  - fetch: GET `/repos/{o}/{r}/git/trees/{branch}?recursive=1`, keep blobs matching the glob (more than 200 -> "Narrow the glob: N files match, the limit is 200"), GET `/repos/{o}/{r}/contents/{path}?ref={branch}` each (base64). externalId = path; title = front-matter `title`, else the first `# ` heading, else the file name; body = file text; url = `https://github.com/{o}/{r}/blob/{branch}/{path}`; state = the front-matter value, or the rest of the first line starting with prefix (trimmed); repoUrl = front-matter `repoKey` value when set.
  - write (the status writer). It never touches the default branch. Branch `routini/status/<slug of path>` (lowercase, non-alphanumerics to `-`, max 80).
    1. Find an open PR with `head={o}:{branch}`.
    2. If there is none, create the branch from the tracking branch head (an existing ref is reused).
    3. Read the file on the status branch, change only the status field, and PUT it with its sha on that branch. Front matter: the `key:` line between the leading `---` lines, inserted if missing. Line kind: the first line starting with prefix becomes `<prefix> <value>`.
    4. If there was no PR, open one: title `Routini: <title> -> <value>`, body with the comment text.
    One PR per item; later writes update it.

## 6b. More sources (P4)

Each adapter lives in its own file under `server/src/backlog/` (a placeholder exists; replace it, keep the export name). Same rules as section 6:
- parseConfig throws SpecError naming the field;
- every request goes through `ctx.fetch` with `redirect: 'manual'`;
- at most 500 items per fetch (page as needed);
- tracker error bodies become short messages without credentials;
- position = the order the tracker returned.

The kinds, integrations and "not connected" labels are already wired (`types.ts`, `index.ts`, `context.ts`, migration 12).

- **`jira.ts`** (`jiraAdapter`, kind `jira`, integration `jira`: `siteUrl`, `email`, `apiToken`; HTTP Basic `email:apiToken`).
  - Config `{ jql: string /* 1-2000 */, repoField?: string /* custom field id like customfield_10050 */ }`.
  - The site URL must be https, without embedded credentials. Unless `ctx.allowPrivateHosts`, check its hostname with `isSsrfSafeHostname` and `resolvedIpIsSsrfSafe` (utils/network.ts), otherwise "The Jira site URL points at a private address".
  - Fetch: GET `{siteUrl}/rest/api/3/search/jql?jql=…&fields=summary,description,status,labels[,repoField]&maxResults=100`, paging with `nextPageToken`. externalId = issue key, title = summary, body = the description's Atlassian Document Format flattened to plain text (paragraphs on new lines), url = `{siteUrl}/browse/{key}`, state = `status.name`, labels = labels, repoUrl = the repoField value when it is a string.
  - Write:
    - If the status already equals the value (case-insensitive), skip.
    - Otherwise GET `/rest/api/3/issue/{key}/transitions` and pick the transition whose `to.name` (or failing that its `name`) equals the value case-insensitively, then POST it. If none matches: "No transition to '<value>' from '<current>'".
    - Comment: POST `/rest/api/3/issue/{key}/comment` with an ADF doc, one paragraph per line.
- **`linear.ts`** (`linearAdapter`, kind `linear`, integration `linear`: `apiKey` sent raw in `authorization`; POST `https://api.linear.app/graphql`).
  - Config `{ teamKey: string /* ^[A-Z][A-Z0-9]{0,9}$ */, labels?: string[] /* all must be present */ }`.
  - Fetch: `issues(filter: { team: { key: { eq } } [, labels: { name: { in } }] }, first: 100, after)`, paged, keeping only issues that carry every configured label. externalId = issue `id`, title, body = description, url, state = `state.name`, labels = label names.
  - Write:
    - Read the team's `states`, find the one named like the value (case-insensitive), then `issueUpdate(id, input: { stateId })`. If none matches: "No workflow state '<value>' in team <teamKey>".
    - Comment: `commentCreate(input: { issueId, body })`.
    - GraphQL `errors`: throw the first message.
- **`azureBoards.ts`** (`azureBoardsAdapter`, kind `azure-boards`, integration `azure-devops`: `organization`, `pat`). Reuse `integrations/azureDevops.ts` (adoBaseUrl, adoAuthHeader, ADO_API_VERSION) and follow engine/boards.ts for WIQL and its "HTML sign-in page instead of JSON" check.
  - Config `{ project: string /* same rule as the azure-boards action's project */, wiql?: string /* max 2000; default: the project's work items not in Closed, Done or Removed */, repoField?: string /* e.g. Custom.Repository */ }`.
  - Fetch: WIQL `$top=500`, then `workitemsbatch` in chunks of 200 with System.Title, System.Description, System.State, System.Tags[, repoField]. externalId = the id as a string, body = the description with HTML tags removed, url = `https://dev.azure.com/{org}/{project}/_workitems/edit/{id}`, state = System.State, labels = System.Tags split on `;` and trimmed.
  - Write:
    - PATCH `{org}/_apis/wit/workitems/{id}?api-version=7.1`, content-type `application/json-patch+json`, body `[{ op: 'add', path: '/fields/System.State', value }]`.
    - Comment: POST `{org}/{project}/_apis/wit/workItems/{id}/comments?api-version=7.1-preview.4` with `{ text }`.
- **`githubIssues.ts`** (`githubIssuesAdapter`, kind `github-issues`, integration `github`: `token`, Bearer, fixed host `https://api.github.com`).
  - Config `{ repoUrl /* parseGithubRepo, same message as the repo source */, labels?: string[] /* filter */, statusPrefix?: string /* default "status:" */ }`.
  - Fetch: GET `/repos/{o}/{r}/issues?state=all&per_page=100&page=N[&labels=a,b]`, skipping pull requests (items with `pull_request`). externalId = the issue number as a string, title, body, url = `html_url`. state = the rest of the first label starting with statusPrefix (trimmed), else `open` or `closed`. labels = the other label names.
  - Write:
    - Value `open` or `closed` (case-insensitive): PATCH the issue state.
    - Anything else: DELETE each label starting with statusPrefix, then POST labels `[<statusPrefix><value>]`, so `status:` + `In progress` becomes `status:In progress`.
    - Comment: POST `/issues/{n}/comments` with `{ body }`.

## 7. Sync and writes (scheduler, one timer)

`Scheduler.start` runs three ticks each interval, each in its own try/catch: due jobs (as today), `syncTick` (backlog/sync.ts), `writesTick` (backlog/writes.ts). Network calls happen outside transactions.

- `syncSource(ctx, source)`: fetch through the adapter, then per SourceItem:
  - **new item** whose state matches `in.ready`: insert as `ready` (event `imported`). A new item that doesn't match is ignored.
  - **known item**: update its fields, then apply these rules:
    - external matches `in.ready` and the item is blocked, dropped or done and not leased -> `ready` (event `ready.source`, note "Set ready in <source name>").
    - external matches `in.dropped` -> `dropped` (event `dropped.source`); if leased, set drop_after_run instead.
  - A known item missing from the fetch is left alone. Errors go to `recordSync`.
- `syncTick`: `claimDueSources(10)` then syncSource each.
- `writesTick`: `claimDueWrites(20)`, adapter.write with value = `mapping.out[state].value` and, when `comment`, a comment with the note plus `<publicUrl>/o/<org slug>/runs/<n>` and the item's PR; then completeWrite or retryWrite.

## 8. HTTP API (`server/src/routes/backlog.ts`, under `/api/orgs/:org`, member unless noted)

| Method and path | Body | Response |
|---|---|---|
| GET /backlog/sources | | `{ sources: BacklogSource[] }` |
| POST /backlog/sources (admin) | SourceInput | 201 `{ source }` (config via adapter.parseConfig, mapping via parseMapping) |
| PUT /backlog/sources/:id (admin) | partial SourceInput | `{ source }` |
| DELETE /backlog/sources/:id (admin) | | 204 |
| POST /backlog/sources/:id/test (admin) | | `{ items: SourceItem[] /* first 20 */, total: number }`, nothing saved |
| POST /backlog/sources/:id/sync | | `{ source }` after syncing now |
| GET /backlog/items?state=&sourceId=&q=&limit= | | `{ items: BacklogItem[] }` |
| GET /backlog/items/:id | | `{ item, source, events: { id, at, kind, data }[] }` |
| POST /backlog/items/:id/ready | | `{ item }`; only from blocked or dropped and not leased, else 409 "Only a blocked or dropped item can be set ready" |
| POST /backlog/items/:id/drop | | `{ item }`; leased -> drop_after_run |
| POST /backlog/items/:id/start | `{ jobId }` | 201 `{ run }`. The job must have a cron trigger with `backlog` (else 400 "That job doesn't take backlog items"); the item must be ready or blocked and not leased (else 409) |
| POST /backlog/writes/:id/retry | | `{ ok: true }` |

`GET /inbox` adds `backlogWrites: { id, itemId, itemTitle, sourceName, state, lastError, attempts, failedAt }[]` (failed writes).

## 9. Console

- Nav: "Backlog" after Inbox, at `/o/:org/backlog`.
- Backlog page:
  - A header with "Sources" chips: name, kind, last sync time or the error in red, and a "Sync now" button each.
  - An admin button "Add source".
  - Filters: state, source, search.
  - The items table: Item (title and source), Routini state pill, value at the source, Last run (#N linked), Built by. Pill colours use the status tokens: ready = info, planning/building/finishing = running, done = ok, blocked = fail, dropped = muted.
  - Clicking a row opens an item panel: title, links (source URL, PR), state note, actions (Start now with a job picker listing backlog jobs, Set ready, Drop), and events newest first.
- Source editor (modal or page):
  - name, kind, kind-specific config fields, default repository and base branch, Factory project, sync every N minutes, enabled;
  - the status mapping: one row per Routini state with the value written there and a "comment" checkbox, plus "Counts as ready" and "Counts as dropped" lists;
  - "Test" previews the first items.
- Job editor, Schedule tab: a "Run once per backlog item" switch with sources (multi-select), labels and "Up to N per run". The agent repository gets a "From the item" option. Steps get a "Stage" select (none, planning, building, finishing).
- Run page: a backlog run links its item in the header ("Item: <title>").
- Inbox: a "Status writes that failed" section with item, source, error and Retry.
- Use the existing components, tokens and patterns (jobForm.ts for pure form logic with tests).
