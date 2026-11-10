"use strict"

// OpenCode Desktop GUI plugin.
//
// Home groups sessions by `session.time.updated`. Viewing or restoring a session
// can advance that timestamp even when no message was exchanged, which moves a
// session from "Yesterday" to "Today" (and reorders the list).
//
// There are two writers to fight, so the plugin has two halves:
//
// 1. Main process (`main`): the server advances `session_v2.time_updated` for
//    bookkeeping events as well. The plugin keeps that column pinned to the
//    newest *real message* in `session_message` with SQLite triggers, so the
//    correction happens inside the same write. A session without any real
//    message keeps its creation time.
//
// 2. Window (`setup`): the desktop renderer treats `session.permissions` as
//    activity and moves `time.updated` forward in memory only (see
//    `SESSION_ACTIVITY` and the `createDesktopData` overlay). Opening a session
//    makes the app grant it browser-tool permissions, closing it revokes them
//    again, and both publish `session.permissions`. That in-memory bump is what
//    sends a session to "Today" until the next restart. The window half wraps
//    `window.fetch` and drops those frames before the renderer parses them.
//
// Switching the model/agent/location, compaction, idle markers and other
// bookkeeping are not conversation activity and are ignored. The triggers live
// in the database, so they keep working while the plugin is enabled and survive
// app restarts. See README.md for how to remove them.

const { Plugin } = require("@opencode/plugin/gui")
const { DatabaseSync } = require("node:sqlite")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

// `session_message.type` values that are not a real message. Everything else
// (user, assistant, synthetic, system, skill, shell, ...) counts as activity.
const NON_MESSAGE_TYPES = ["idle", "compaction", "agent-switched", "model-switched", "location-switched"]
const TYPE_LIST = NON_MESSAGE_TYPES.map((type) => `'${type}'`).join(", ")

const TRIGGERS = {
  session: "opencode_fair_session_date_session",
  message: "opencode_fair_session_date_message_insert",
}

// Retry quickly while the desktop is booting and the database may not exist
// yet, then fall back to a slow safety net that re-installs the triggers if a
// future app version recreates the database.
const BOOT_RETRY_MS = 1_000
const BOOT_RETRIES = 30
const RECONCILE_MS = 60_000

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Newest timestamp among real messages of a session, or NULL when it has none. */
function lastRealMessage(session) {
  return `(
    SELECT MAX(COALESCE(m.time_updated, m.time_created))
    FROM session_message AS m
    WHERE m.session_id = ${session}
      AND m.type NOT IN (${TYPE_LIST})
  )`
}

// Runs after the server (or the ORM's `$onUpdate`) writes `time_updated`.
// The update of the same row is safe: SQLite does not re-fire the trigger
// recursively by default, and the WHEN guard is false the second time.
const CREATE_SESSION_TRIGGER = `CREATE TRIGGER ${TRIGGERS.session}
AFTER UPDATE OF time_updated ON session_v2
FOR EACH ROW
WHEN NEW.time_updated IS NOT COALESCE(${lastRealMessage("NEW.id")}, NEW.time_created)
BEGIN
  UPDATE session_v2
  SET time_updated = COALESCE(${lastRealMessage("NEW.id")}, NEW.time_created)
  WHERE id = NEW.id;
END`

// A message row is often inserted without a separate session update. Move the
// session forward so a real message always counts as activity.
const CREATE_MESSAGE_TRIGGER = `CREATE TRIGGER ${TRIGGERS.message}
AFTER INSERT ON session_message
FOR EACH ROW
WHEN NEW.type NOT IN (${TYPE_LIST})
  AND ${lastRealMessage("NEW.session_id")} > (SELECT time_updated FROM session_v2 WHERE id = NEW.session_id)
BEGIN
  UPDATE session_v2
  SET time_updated = ${lastRealMessage("NEW.session_id")}
  WHERE id = NEW.session_id;
END`

const BACKFILL = `UPDATE session_v2
SET time_updated = COALESCE(${lastRealMessage("session_v2.id")}, time_created)
WHERE time_updated IS NOT COALESCE(${lastRealMessage("session_v2.id")}, time_created)`

// Counted before the update: SQLite's `changes` counter is reset by the
// trigger's own update, so it cannot report the top-level row count reliably.
const STALE_COUNT = `SELECT COUNT(*) AS n FROM session_v2
WHERE time_updated IS NOT COALESCE(${lastRealMessage("session_v2.id")}, time_created)`

function databaseCandidates() {
  const dirs = []
  for (const value of [process.env.OPENCODE_DATA, process.env.OPENCODE_DATA_DIR]) {
    if (value) dirs.push(value)
  }
  dirs.push(path.join(os.homedir(), ".local", "share", "opencode"))
  dirs.push(path.join(os.homedir(), "AppData", "Local", "opencode"))

  const files = []
  const override = process.env.OPENCODE_DB
  if (override && override !== ":memory:") {
    files.push(path.isAbsolute(override) ? override : path.join(dirs[0], override))
  }

  for (const dir of dirs) {
    for (const name of ["opencode.db", "opencode-local.db", "opencode-dev.db", "opencode-beta.db"]) {
      files.push(path.join(dir, name))
    }
  }
  return [...new Set(files)]
}

function hasSessionTables(db) {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session_message')")
    .get()
  return Number(row?.n) === 2
}

function hasTriggers(db) {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)")
    .get(TRIGGERS.session, TRIGGERS.message)
  return Number(row?.n) === 2
}

/**
 * Installs the triggers and corrects existing rows in one transaction, so the
 * server never observes a half-corrected database. Returns the number of
 * sessions whose timestamp was rewritten, or undefined when the file is not a
 * session database.
 */
function apply(file, force) {
  let db
  try {
    db = new DatabaseSync(file, { timeout: 5_000 })
    db.exec("PRAGMA busy_timeout = 5000")

    if (!hasSessionTables(db)) return undefined
    if (!force && hasTriggers(db)) {
      const stale = Number(db.prepare(STALE_COUNT).get()?.n ?? 0)
      if (stale > 0) db.prepare(BACKFILL).run()
      return stale
    }

    db.exec("BEGIN IMMEDIATE")
    try {
      for (const name of Object.values(TRIGGERS)) db.exec(`DROP TRIGGER IF EXISTS ${name}`)
      db.exec(CREATE_SESSION_TRIGGER)
      db.exec(CREATE_MESSAGE_TRIGGER)
      const stale = Number(db.prepare(STALE_COUNT).get()?.n ?? 0)
      if (stale > 0) db.prepare(BACKFILL).run()
      db.exec("COMMIT")
      return stale
    } catch (error) {
      try {
        db.exec("ROLLBACK")
      } catch {}
      throw error
    }
  } finally {
    try {
      db?.close()
    } catch {}
  }
}

function findDatabases() {
  const result = []
  for (const file of databaseCandidates()) {
    try {
      if (fs.existsSync(file)) result.push(file)
    } catch {}
  }
  return result
}

// ---------------------------------------------------------------------------
// Window half: drop `session.permissions` frames before the renderer sees them.

const FETCH_MARKER = "__opencodeFairSessionDateFetch"
const IGNORED_EVENT = "session.permissions"

// The event stream can already be open when the plugin loads, and the app only
// reconnects through the patched `fetch` after a resync. Nudging the page's
// `online` handler makes it reconnect until a filtered stream is seen: that
// handler drops the live request and the reconnect goes through `fetch` again.
const POKE_DELAYS_MS = [0, 500, 1_500, 3_000, 6_000, 12_000]

/** True when an event-stream block carries a `session.permissions` frame. */
function carriesIgnoredEvent(block) {
  let data = ""
  for (const line of block.split("\n")) {
    if (!line.startsWith("data:")) continue
    data += (data === "" ? "" : "\n") + line.slice(5).trimStart()
  }
  if (data === "") return false
  try {
    const event = JSON.parse(data)
    return Boolean(event) && event.type === IGNORED_EVENT
  } catch {
    return false
  }
}

/** Re-emits an event stream without the frames the desktop counts as activity. */
function eventFilter(onDrop) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  const split = (controller, final) => {
    // Normalise line endings the way the client's SSE parser does, but keep a
    // trailing `\r` until the next chunk so a split `\r\n` still matches.
    const trailingCarriageReturn = !final && buffer.endsWith("\r")
    if (trailingCarriageReturn) buffer = buffer.slice(0, -1)
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    if (trailingCarriageReturn) buffer += "\r"

    for (let boundary = buffer.indexOf("\n\n"); boundary !== -1; boundary = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      if (carriesIgnoredEvent(block)) {
        onDrop?.()
        continue
      }
      controller.enqueue(encoder.encode(block + "\n\n"))
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      split(controller, false)
    },
    flush(controller) {
      buffer += decoder.decode()
      split(controller, true)
      if (buffer === "") return
      if (carriesIgnoredEvent(buffer)) {
        onDrop?.()
        return
      }
      controller.enqueue(encoder.encode(buffer))
      buffer = ""
    },
  })
}

/**
 * Wraps `window.fetch` so event streams reach the renderer without the frames
 * that would advance a session's `time.updated` in memory. Returns the installed
 * filter, or undefined outside a window served by the desktop app.
 */
function installEventFilter(view) {
  if (!view || typeof view.fetch !== "function") return undefined
  const existing = view[FETCH_MARKER]
  if (existing) {
    existing.refs++
    return existing
  }

  const original = view.fetch
  const state = { filtered: false, disposed: false, timers: [], dropped: 0 }

  const log = (message) => {
    try {
      console.info(`[fair-session-date] ${message}`)
    } catch {}
  }

  const wrapped = function (input, init) {
    return Promise.resolve(original.call(this, input, init)).then((response) => {
      if (state.disposed || !response || !response.body || !response.headers) return response
      try {
        const type = response.headers.get("content-type")
        if (!type || type.indexOf("text/event-stream") === -1) return response
        if (!state.filtered) log("filtering session.permissions from the event stream")
        state.filtered = true
        const headers = new Headers(response.headers)
        headers.delete("content-length")
        headers.delete("content-encoding")
        return new Response(
          response.body.pipeThrough(
            eventFilter(() => {
              state.dropped++
              if (state.dropped === 1) log("dropped a session.permissions frame")
            }),
          ),
          {
            status: response.status,
            statusText: response.statusText,
            headers,
          },
        )
      } catch {
        return response
      }
    })
  }

  view.fetch = wrapped

  const filter = {
    refs: 1,
    get filtered() {
      return state.filtered
    },
    dispose() {
      if (filter.refs > 0) filter.refs--
      if (filter.refs > 0 || state.disposed) return
      state.disposed = true
      for (const timer of state.timers) clearTimeout(timer)
      state.timers = []
      if (view.fetch === wrapped) view.fetch = original
      if (view[FETCH_MARKER] === filter) delete view[FETCH_MARKER]
    },
  }
  view[FETCH_MARKER] = filter
  log("window filter installed")

  for (const delay of POKE_DELAYS_MS) {
    state.timers.push(
      setTimeout(() => {
        if (state.disposed || state.filtered) return
        log("reconnecting the event stream to filter it")
        try {
          view.dispatchEvent(new Event("online"))
        } catch {}
      }, delay),
    )
  }

  return filter
}

module.exports = Plugin.define({
  setup(ctx) {
    const view = typeof window === "undefined" ? undefined : window
    const filter = installEventFilter(view)
    if (!filter) return

    let released = false
    const release = () => {
      if (released) return
      released = true
      ctx.signal.removeEventListener("abort", release)
      filter.dispose()
    }
    ctx.signal.addEventListener("abort", release, { once: true })

    return release
  },
  main(ctx) {
    const log = (level, message, data) => {
      try {
        ctx.log.write(level, `[${ctx.id}] ${message}`, data)
      } catch {}
    }

    let stopped = false
    let timer
    let attempts = 0
    let installed = false

    const run = () => {
      let handled = false
      for (const file of findDatabases()) {
        try {
          const changes = apply(file, !installed)
          if (changes === undefined) continue
          handled = true
          if (changes > 0) {
            log("info", "corrected Home session dates", { file, sessions: changes })
          }
        } catch (error) {
          log("debug", `could not update the session database: ${errorText(error)}`, { file })
        }
      }

      if (handled && !installed) {
        installed = true
        log("info", "keeping session dates in sync with real message activity")
      }
      return handled
    }

    const tick = () => {
      if (stopped) return
      const handled = run()
      attempts++
      const delay = handled || attempts >= BOOT_RETRIES ? RECONCILE_MS : BOOT_RETRY_MS
      timer = setTimeout(tick, delay)
    }

    tick()

    const abort = () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
    ctx.signal.addEventListener("abort", abort, { once: true })

    return () => {
      ctx.signal.removeEventListener("abort", abort)
      abort()
    }
  },
})
