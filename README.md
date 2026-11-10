# fair-session-date

OpenCode Desktop GUI plugin that makes Home group sessions by the date of their
**last real message** instead of a later view/open timestamp.

## The problem

Home buckets sessions into `Today`, `Yesterday` and `Older` using
`session.time.updated`. Viewing or restoring a session can advance that
timestamp even when no message was exchanged, so a session from yesterday moves
to `Today` just because it was opened.

## What the plugin does

It keeps `session_v2.time_updated` pinned to the newest real message in
`session_message`:

- `user`, `assistant`, `synthetic`, `system`, `skill`, `shell` and any other
  conversation message count as activity;
- `idle`, `compaction`, `model-switched`, `agent-switched` and
  `location-switched` are bookkeeping and are ignored;
- a session with no messages keeps its creation time.

The correction is implemented as SQLite triggers, so it happens inside the same
write that would have bumped the timestamp — before the server publishes the
event and the client refetches the session. On startup the plugin also
backfills every existing row, so old sessions return to their real dates
immediately.

### Why opening a session still moved it

The desktop app also tracks session activity in the renderer, in memory only:
`SESSION_ACTIVITY` in `app/src/runtime/server/data.ts` includes
`session.permissions`, and the `createDesktopData` overlay replaces a session's
`time.updated` with the event's `created` time.

Opening a session makes the app grant it browser-tool permissions, and closing
the tab revokes them again. Both publish `session.permissions`, so merely
clicking a session and closing it moved the row to `Today` until the next
restart. The database was always correct; only the renderer's overlay drifted.

The plugin's window half wraps `window.fetch` and removes
`session.permissions` frames from the event stream before the renderer parses
them. Nothing else in the app consumes those events, so permissions still work
and are still stored on the server; only the in-memory date bump is gone.

## Install

The plugin is a normal OpenCode GUI plugin folder:

```
~/.config/opencode/plugins/fair-session-date/
  package.json
  src/gui.cjs
```

Restart OpenCode Desktop after copying it. The plugin logs a line like
`keeping session dates in sync with real message activity` when the database
half is active, and the window console shows
`[fair-session-date] filtering session.permissions from the event stream`
once the event stream goes through the filter.

## Notes

- Triggers are stored in the database (`opencode_fair_session_date_session` and
  `opencode_fair_session_date_message_insert`). They keep working while the
  plugin is installed and survive restarts. Removing the plugin folder does not
  remove them — run the SQL below against the active database if you want the
  old behaviour back.
- The filter is installed in the window. The event stream may already be
  connected when the plugin loads, so the plugin nudges the app's reconnect
  handler (`online`) until a filtered stream is in place.
- Only `session_v2.time_updated` is changed in the database. Message contents,
  titles, `time_viewed`, permission rules, archive state and everything else are
  left alone.
- The plugin supports the standard data directories and `OPENCODE_DATA`,
  `OPENCODE_DATA_DIR` and `OPENCODE_DB` overrides.

## Remove the triggers

```sql
DROP TRIGGER IF EXISTS opencode_fair_session_date_session;
DROP TRIGGER IF EXISTS opencode_fair_session_date_message_insert;
```

The previously corrected `time_updated` values stay as they are.
