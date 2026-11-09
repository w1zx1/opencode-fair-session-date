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

## Install

The plugin is a normal OpenCode GUI plugin folder:

```
~/.config/opencode/plugins/fair-session-date/
  package.json
  src/gui.cjs
```

Restart OpenCode Desktop after copying it. The plugin logs a line like
`keeping session dates in sync with real message activity` when it is active.

## Notes

- Triggers are stored in the database (`opencode_fair_session_date_session` and
  `opencode_fair_session_date_message_insert`). They keep working while the
  plugin is installed and survive restarts. Removing the plugin folder does not
  remove them — run the SQL below against the active database if you want the
  old behaviour back.
- Only `session_v2.time_updated` is changed. Message contents, titles,
  `time_viewed`, archive state and everything else are left alone.
- The plugin supports the standard data directories and `OPENCODE_DATA`,
  `OPENCODE_DATA_DIR` and `OPENCODE_DB` overrides.

## Remove the triggers

```sql
DROP TRIGGER IF EXISTS opencode_fair_session_date_session;
DROP TRIGGER IF EXISTS opencode_fair_session_date_message_insert;
```

The previously corrected `time_updated` values stay as they are.
