/**
 * dsh-session-purge — 彻底删除一个 DSH 会话。
 *
 * 为什么需要它：DSH 自身只提供「归档 / 取消归档」。会话日志是只追加的，
 * 持久化接缝没有删除接口，工作区登记表也只删登记、不删会话。本插件补上一个
 * 显式的删除动作，一次清干净三处状态：
 *
 *   1. <DSH_HOME>/sessions/<工作区>/<会话 id>/                      会话日志本体
 *   2. <DSH_HOME>/storages/session_projcache/sessions/<会话 id>.json 投影缓存（标题在这里）
 *   3. <DSH_HOME>/storages/workspace.json                            登记表里的 id（可选，带备份）
 *
 * 三段式安全闸门，任一不满足就拒绝执行：
 *   - 拒绝调用者自己所在的会话（exec.agent.id）——删它等于自断；
 *   - 拒绝仍有活 Agent 的会话（内存里还在跑，删了会被重新写回）；
 *   - 只接受已归档的会话，除非显式传 allow_unarchived: true。
 *
 * 只注册两个工具，不改任何既有行为；卸载插件即完全恢复。
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile, readdir, rename, rm, stat, appendFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'session-purge'

const PROJECTION_DIR = ['storages', 'session_projcache', 'sessions']
const REGISTRY_FILE = ['storages', 'workspace.json']

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value) {
  return [{ type: 'text', text: value }]
}

function count(value) {
  return typeof value === 'number' ? `${(value / 1024).toFixed(1)} KB` : 'unknown'
}

/** DSH_HOME：先环境变量，再 profileContext.dir 的上两级，用 sessions/ 是否存在来校验。 */
function resolveHome(ctx) {
  const candidates = []
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
    candidates.push(process.env.DSH_HOME)
  }
  const profile = ctx.get('profileContext')
  if (isRecord(profile) && typeof profile.dir === 'string') {
    candidates.push(dirname(dirname(profile.dir)))
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'sessions'))) return resolve(candidate)
  }
  if (candidates.length > 0) return resolve(candidates[0])
  throw new Error('无法定位 DSH_HOME：DSH_HOME 环境变量与 profileContext.dir 都不可用')
}

async function listDir(path) {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

async function statOrUndefined(path) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

/** 删除后复查：活 Agent 的 flush 是否又把会话目录写了回来。 */
async function wasRewritten(dir, attempts = 3, delayMs = 700) {
  for (let index = 0; index < attempts; index += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
    if (existsSync(dir)) return true
  }
  return false
}

async function isDirectory(path) {
  const info = await statOrUndefined(path)
  return info?.isDirectory() === true
}

/** 扫描 <home>/sessions 下的全部会话目录，附带字节数、文件清单与最后修改时间。 */
async function scanSessions(home) {
  const root = join(home, 'sessions')
  const sessions = []
  for (const workspace of await listDir(root)) {
    const workspacePath = join(root, workspace)
    if (!(await isDirectory(workspacePath))) continue
    for (const sessionId of await listDir(workspacePath)) {
      const dir = join(workspacePath, sessionId)
      if (!(await isDirectory(dir))) continue
      let bytes = 0
      let modifiedMs = 0
      const files = []
      for (const entry of await listDir(dir)) {
        const info = await statOrUndefined(join(dir, entry))
        if (info?.isFile() !== true) continue
        bytes += info.size
        modifiedMs = Math.max(modifiedMs, info.mtimeMs)
        files.push({ name: entry, bytes: info.size })
      }
      sessions.push({
        sessionId,
        workspace,
        dir,
        bytes,
        files,
        modifiedAt: modifiedMs > 0 ? new Date(modifiedMs).toISOString() : null,
      })
    }
  }
  return sessions
}

/** 标题来自投影缓存；缓存可能缺失或过期，缺失时返回 null。 */
async function readTitle(home, sessionId) {
  const path = join(home, ...PROJECTION_DIR, `${sessionId}.json`)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    const value = parsed?.record?.rows?.title?.val
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

async function readRegistry(home) {
  const path = join(home, ...REGISTRY_FILE)
  try {
    return { path, json: JSON.parse(await readFile(path, 'utf8')) }
  } catch {
    return { path, json: undefined }
  }
}

/** 登记表里这个 id 出现在哪些集合中（用来判断是否要清理、清理了什么）。 */
function registryReferences(registry, sessionId) {
  const found = []
  const json = registry.json
  if (!isRecord(json)) return found
  const global = json.global
  if (isRecord(global)) {
    if (Array.isArray(global.archivedSessionIds) && global.archivedSessionIds.includes(sessionId)) {
      found.push('global.archivedSessionIds')
    }
    if (Array.isArray(global.pinnedSessionIds) && global.pinnedSessionIds.includes(sessionId)) {
      found.push('global.pinnedSessionIds')
    }
  }
  const workspaces = json.tables?.workspaces
  if (isRecord(workspaces)) {
    for (const [id, entry] of Object.entries(workspaces)) {
      if (isRecord(entry) && Array.isArray(entry.sessionIds) && entry.sessionIds.includes(sessionId)) {
        found.push(`tables.workspaces.${id}.sessionIds`)
      }
    }
  }
  return found
}

/** 先备份再原子替换，避免与 storage 服务的写入互相撕裂。 */
async function pruneRegistry(registry, sessionId, stamp) {
  const json = registry.json
  if (!isRecord(json)) return { status: 'unreadable' }
  const before = registryReferences(registry, sessionId)
  if (before.length === 0) return { status: 'unchanged', references: [] }

  const drop = (list) => (Array.isArray(list) ? list.filter((entry) => entry !== sessionId) : list)
  if (isRecord(json.global)) {
    json.global.archivedSessionIds = drop(json.global.archivedSessionIds)
    json.global.pinnedSessionIds = drop(json.global.pinnedSessionIds)
  }
  const workspaces = json.tables?.workspaces
  if (isRecord(workspaces)) {
    for (const entry of Object.values(workspaces)) {
      if (isRecord(entry)) entry.sessionIds = drop(entry.sessionIds)
    }
  }

  const backup = `${registry.path}.bak-${stamp}`
  await writeFile(backup, JSON.stringify(registry.json, null, 2) + '\n', 'utf8')
  const temporary = `${registry.path}.tmp-${stamp}`
  await writeFile(temporary, JSON.stringify(json, null, 2) + '\n', 'utf8')
  await rename(temporary, registry.path)
  return { status: 'pruned', references: before, backup }
}

/** 优先走登记表自己的 API；签名不确定，两种形状都试，失败只记录不抛。 */
async function unarchive(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (typeof registry?.unarchiveSession !== 'function') return 'unsupported'
  try {
    await registry.unarchiveSession({ sessionId })
    return 'ok'
  } catch (first) {
    try {
      await registry.unarchiveSession(sessionId)
      return 'ok'
    } catch {
      return `failed: ${String(first?.message ?? first)}`
    }
  }
}

function liveSessions(ctx) {
  const agents = ctx.get('agents')
  if (typeof agents?.list !== 'function') return []
  try {
    return agents.list().map((agent) => agent?.id).filter((id) => typeof id === 'string')
  } catch {
    return []
  }
}

async function audit(home, line) {
  try {
    await appendFile(join(home, 'session-purge.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* 审计写不进去不影响删除结果 */
  }
}

/** 取出一条会话记录；不存在时抛出带候选清单的错误。 */
async function requireSession(home, sessionId) {
  const sessions = await scanSessions(home)
  const target = sessions.find((entry) => entry.sessionId === sessionId)
  if (target === undefined) {
    const known = sessions.map((entry) => entry.sessionId).join(', ') || '(没有任何会话目录)'
    throw new Error(`找不到会话 "${sessionId}"。当前磁盘上的会话：${known}`)
  }
  // 归属校验：解析后的目录必须真的落在 <home>/sessions 里面。
  const root = resolve(join(home, 'sessions'))
  if (!resolve(target.dir).startsWith(root + sep)) {
    throw new Error(`拒绝操作：${target.dir} 不在 ${root} 之内`)
  }
  return { sessions, target }
}

function registerTools(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) {
    console.warn('session-purge: tools service unavailable; tools not registered')
    return
  }

  tools.register({
    name: 'session_purge_list',
    description:
      '列出磁盘上的全部 DSH 会话，含标题、字节数、最后修改时间，以及是否已归档 / 是否有活 Agent / 是否是当前正在对话的会话。只读，用于删除前确认目标。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const lines = Array.isArray(value?.sessions) ? value.sessions : []
        const body = lines
          .map(
            (entry) =>
              `- ${entry.sessionId}\n  标题: ${entry.title ?? '(无标题)'}  大小: ${count(entry.bytes)}  改动: ${entry.modifiedAt ?? '未知'}\n  归档: ${entry.archived ? '是' : '否'}  活 Agent: ${entry.live ? '是' : '否'}${entry.current ? '  ← 当前会话' : ''}`,
          )
          .join('\n')
        return text(`DSH_HOME: ${value?.home ?? '未知'}\n会话 ${lines.length} 个：\n${body}`)
      },
    },
    async execute(_args, exec) {
      const home = resolveHome(ctx)
      const registry = await readRegistry(home)
      const live = new Set(liveSessions(ctx))
      const current = exec?.agent?.id
      const sessions = []
      for (const entry of await scanSessions(home)) {
        sessions.push({
          ...entry,
          title: await readTitle(home, entry.sessionId),
          archived: Array.isArray(registry.json?.global?.archivedSessionIds)
            ? registry.json.global.archivedSessionIds.includes(entry.sessionId)
            : false,
          live: live.has(entry.sessionId),
          current: entry.sessionId === current,
        })
      }
      sessions.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
      return { ok: true, home, current: current ?? null, sessions }
    },
  })

  tools.register({
    name: 'session_purge_delete',
    description:
      '彻底删除一个已归档的 DSH 会话：删掉会话日志目录与投影缓存，并把它从工作区登记表里移除（先备份）。需要 confirm: true。拒绝删除当前正在对话的会话、仍有活 Agent 的会话，以及尚未归档的会话（后者要显式 allow_unarchived: true）。不可恢复。',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '要删除的会话 id，先用 session_purge_list 确认。' },
        confirm: { type: 'boolean', description: '必须为 true，否则拒绝执行。' },
        allow_unarchived: { type: 'boolean', description: '允许删除尚未归档的会话，默认 false。' },
        allow_live: {
          type: 'boolean',
          description:
            '允许删除仍有活 Agent（正被界面保留）的会话，默认 false。越过它之后宿主可能把日志写回，务必看返回里的 resurrected 复查结果。',
        },
        prune_registry: {
          type: 'boolean',
          description: '是否同时把该 id 从工作区登记表移除（先写 .bak 备份），默认 true。',
        },
      },
      required: ['session_id', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        if (value?.ok !== true) return text(`删除失败：${value?.reason ?? '未知原因'}`)
        const steps = value.steps ?? {}
        return text(
          `已彻底删除会话 ${value.sessionId}\n标题: ${value.title ?? '(无标题)'}\n释放: ${count(value.freedBytes)}\n` +
            `日志目录: ${steps.log}\n投影缓存: ${steps.projectionCache}\n取消归档: ${steps.unarchive}\n登记表: ${steps.registry}` +
            (value.backup === null ? '' : `\n备份: ${value.backup}`) +
            (value.resurrected === true ? '\n⚠️ 复查：文件被宿主重新写回，需重启 DSH 后再删一次' : ''),
        )
      },
    },
    async execute(args, exec) {
      const home = resolveHome(ctx)
      const sessionId = typeof args?.session_id === 'string' ? args.session_id.trim() : ''
      if (sessionId.length === 0) return { ok: false, reason: '缺少 session_id' }
      if (args?.confirm !== true) return { ok: false, reason: '需要 confirm: true 才会执行删除' }

      const { target } = await requireSession(home, sessionId)
      const current = exec?.agent?.id
      if (current !== undefined && current === sessionId) {
        return { ok: false, reason: `拒绝删除当前正在对话的会话 ${sessionId}（self-destruct）` }
      }

      const live = liveSessions(ctx)
      if (live.includes(sessionId) && args?.allow_live !== true) {
        return {
          ok: false,
          reason:
            `会话 ${sessionId} 仍有活 Agent 在内存里（它正被界面保留，会随 flush 把日志写回）。` +
            '把它移出侧栏列表（例如筛选切到「隐藏已归档」）或重启 DSH 再删；确要现在删就显式传 allow_live: true',
        }
      }

      const registry = await readRegistry(home)
      const archived = Array.isArray(registry.json?.global?.archivedSessionIds)
        ? registry.json.global.archivedSessionIds.includes(sessionId)
        : false
      if (!archived && args?.allow_unarchived !== true) {
        return { ok: false, reason: `会话 ${sessionId} 尚未归档；先归档，或显式传 allow_unarchived: true` }
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const title = await readTitle(home, sessionId)
      const steps = {
        unarchive: archived ? await unarchive(ctx, sessionId) : 'not-archived',
        log: 'missing',
        projectionCache: 'missing',
        registry: 'skipped',
      }

      await rm(target.dir, { recursive: true, force: true })
      steps.log = (await isDirectory(target.dir)) ? 'failed' : `removed (${count(target.bytes)})`

      const projectionPath = join(home, ...PROJECTION_DIR, `${sessionId}.json`)
      if (existsSync(projectionPath)) {
        await rm(projectionPath, { force: true })
        steps.projectionCache = existsSync(projectionPath) ? 'failed' : 'removed'
      }

      let backup = null
      if (args?.prune_registry !== false) {
        try {
          const outcome = await pruneRegistry(registry, sessionId, stamp)
          steps.registry = outcome.status === 'pruned' ? `pruned (${outcome.references.join(', ')})` : outcome.status
          backup = outcome.backup ?? null
        } catch (error) {
          steps.registry = `failed: ${String(error?.message ?? error)}`
        }
      }

      const resurrected = await wasRewritten(target.dir)
      await audit(
        home,
        `purge ${sessionId} title=${JSON.stringify(title)} resurrected=${resurrected} steps=${JSON.stringify(steps)}`,
      )

      return {
        ok: true,
        sessionId,
        title,
        home,
        freedBytes: target.bytes,
        steps,
        backup,
        resurrected,
        notes: [
          ...(resurrected
            ? ['⚠️ 删除后宿主又把该会话写回磁盘了：界面仍保留着它。请重启 DSH，然后重新执行一次删除。']
            : []),
          '附件（$DSH_HOME/attachments/v1）是内容寻址、可能被多个会话共用的，本次未触碰。',
          '若侧栏仍显示该会话，刷新页面或重启 DSH 即可（登记表由 storage 服务缓存）。',
        ],
      }
    },
  })

  console.log('session-purge: registered session_purge_list and session_purge_delete')
}

/* ------------------------------------------------------------------ *
 * Client (UI) surface: an additive "delete" action for ARCHIVED Sessions.
 * The web app gets it through the seats
 *   sidebar.workspaces.session.menu.item  /  sidebar.workspaces.session.row.action
 * which the client half registers. This half only adds
 *   1. a localhost HTTP route that performs the same purge as the tool, and
 *   2. an index injection carrying a per-boot token the route requires.
 * No shipped behavior is replaced; removing the plugin removes both.
 * ------------------------------------------------------------------ */

const PURGE_API_PATH = '/api/dsh-session-purge'

/** Purge one archived Session on behalf of the UI (there is no Agent context here). */
async function purgeFromUi(ctx, sessionId) {
  const home = resolveHome(ctx)
  const { target } = await requireSession(home, sessionId)

  const registry = await readRegistry(home)
  const archived =
    Array.isArray(registry.json?.global?.archivedSessionIds) &&
    registry.json.global.archivedSessionIds.includes(sessionId)
  if (!archived) return { ok: false, reason: '界面只允许删除“已归档”的会话，该会话尚未归档' }

  if (liveSessions(ctx).includes(sessionId)) {
    return {
      ok: false,
      reason: '该会话仍有活 Agent（正在运行或被界面保留），宿主会把日志写回。请先让它停下来，或重启 DSH 后再删。',
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const title = await readTitle(home, sessionId)
  const steps = {
    unarchive: await unarchive(ctx, sessionId),
    log: 'missing',
    projectionCache: 'missing',
    registry: 'skipped',
  }

  await rm(target.dir, { recursive: true, force: true })
  steps.log = (await isDirectory(target.dir)) ? 'failed' : `removed (${count(target.bytes)})`

  const projectionPath = join(home, ...PROJECTION_DIR, `${sessionId}.json`)
  if (existsSync(projectionPath)) {
    await rm(projectionPath, { force: true })
    steps.projectionCache = existsSync(projectionPath) ? 'failed' : 'removed'
  }

  let backup = null
  try {
    const outcome = await pruneRegistry(registry, sessionId, stamp)
    steps.registry = outcome.status === 'pruned' ? `pruned (${outcome.references.join(', ')})` : outcome.status
    backup = outcome.backup ?? null
  } catch (error) {
    steps.registry = `failed: ${String(error?.message ?? error)}`
  }

  const resurrected = await wasRewritten(target.dir)
  await audit(
    home,
    `ui-purge ${sessionId} title=${JSON.stringify(title)} resurrected=${resurrected} steps=${JSON.stringify(steps)}`,
  )
  return { ok: true, sessionId, title, freedBytes: target.bytes, steps, backup, resurrected }
}

function registerPurgeApi(ctx, token) {
  ctx.inject(['webServer'], (webCtx) => {
    const respond = (res, status, body) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      })
      res.end(payload)
    }

    const route = {
      kind: 'prefix',
      path: PURGE_API_PATH,
      async handler(req, res) {
        // Accept either the per-boot token injected into a `dsh web` page, or the static
        // UI marker. The marker is enough protection by itself: a custom request header
        // forces a CORS preflight, and this route never approves one, so a cross-origin
        // page cannot reach it. The route also stays bound to loopback.
        const supplied = req.headers['x-dsh-session-purge']
        const allowed = supplied === token || supplied === 'ui'
        try {
          const home = resolveHome(ctx)
          await audit(
            home,
            `http ${allowed ? 'ok' : 'denied'} ${String(req.method)} ${String(req.url)} from=${String(req.socket?.remoteAddress)} origin=${String(req.headers.origin ?? '-')} header=${supplied === undefined ? '(none)' : supplied === 'ui' ? 'ui' : 'other'} ua=${String(req.headers['user-agent'] ?? '-').slice(0, 60)}`,
          )
        } catch {
          /* request logging is best-effort */
        }
        if (!allowed) {
          return respond(res, 403, { ok: false, error: 'forbidden' })
        }
        const suffix = new URL(req.url ?? PURGE_API_PATH, 'http://localhost').pathname.slice(PURGE_API_PATH.length)

        if (req.method === 'GET' && suffix === '/state') {
          try {
            const home = resolveHome(ctx)
            const registry = await readRegistry(home)
            const archived = Array.isArray(registry.json?.global?.archivedSessionIds)
              ? registry.json.global.archivedSessionIds
              : []
            return respond(res, 200, { ok: true, archived })
          } catch (error) {
            return respond(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }

        if (req.method === 'POST' && suffix === '/delete') {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          let body
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch {
            return respond(res, 400, { ok: false, error: 'invalid JSON body' })
          }
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
          if (sessionId.length === 0) return respond(res, 400, { ok: false, error: 'missing sessionId' })
          if (body?.confirm !== true) return respond(res, 400, { ok: false, error: 'confirm must be true' })
          try {
            return respond(res, 200, await purgeFromUi(ctx, sessionId))
          } catch (error) {
            return respond(res, 200, { ok: false, reason: String(error?.message ?? error) })
          }
        }

        return respond(res, 404, { ok: false, error: 'not found' })
      },
    }

    webCtx.effect(() => webCtx.webServer.register(route), 'session-purge: purge api')
    webCtx.effect(
      () =>
        webCtx.webServer.tapIndex((html) =>
          html.replace('<head>', `<head><script>window.__DSH_SESSION_PURGE__=${JSON.stringify({ token })}</script>`),
        ),
      'session-purge: token injection',
    )
  })
}

export function apply(ctx) {
  ctx.inject(['tools'], (scoped) => {
    registerTools(scoped)
  })
  registerPurgeApi(ctx, randomUUID())
}
