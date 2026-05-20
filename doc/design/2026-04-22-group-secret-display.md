# Group Secret Display Fix — Design Document

> Date: 2026-04-22
> Issue: CLI `groups` command shows `group_id` (sha256 digest prefix) instead of original `group_secret`, making output unreadable.

## Background

Currently `groups` table stores:
- `group_id` — first 32 chars of `sha256(group_secret)`, used for isolation
- `group_secret_hash` — full sha256 hash for verification

The original `group_secret` (user-provided secret string) is not stored. When admin runs `cli.ts groups`, the output shows the `group_id` digest like `a1b2c3d4...` which is meaningless to the admin who only knows the original secret.

The user has decided the `group_secret` does not need cryptographic protection at rest — its purpose is group isolation, not secrecy. Access to `/admin/groups` is already protected by `API_KEY`.

## Decision: Do Not Migrate Historical Data

This is a major version update. After upgrade:
- Existing groups will have `group_secret = NULL`
- All peers must re-register (fresh `/register` call)
- Admin must clear historical broker DB or start fresh

This avoids complex migration logic for a pre-release project.

## Changes

### 1. Database Schema

`groups` table adds `group_secret` column:

```sql
ALTER TABLE groups ADD COLUMN group_secret TEXT;
```

- New registrations: populated with original secret
- Historical rows: `NULL` → API returns `"(unknown)"`

### 2. `/register` (broker.ts)

Update `insertGroup` prepared statement to include `group_secret`:

```sql
INSERT OR IGNORE INTO groups (group_id, group_secret_hash, created_at, group_secret)
VALUES (?, ?, ?, ?)
```

The `/register` handler passes `body.group_secret` as the 4th parameter.

### 3. `/admin/groups` (broker.ts)

Update SQL query to select `group_secret`:

```sql
SELECT g.group_id, g.group_secret, g.created_at,
       COUNT(CASE WHEN p.status = 'active' THEN 1 END) as active_peers
FROM groups g
LEFT JOIN peers p ON p.group_id = g.group_id
GROUP BY g.group_id
```

Return `group_secret` in JSON. If `NULL`, return `"(unknown)"`.

### 4. CLI `groups` command (cli.ts)

Display `group_secret` instead of `group_id`:

```
2 group(s):
  mygroup  peers=3  created=2026-04-22T10:00:00Z
  another  peers=1  created=2026-04-22T10:05:00Z
```

Historical groups show:
```
  (unknown)  peers=2  created=2026-04-20T08:00:00Z
```

### 5. Documentation

README.md update:
- Add section on clearing historical data before upgrade
- Explain that `group_secret` is stored in plain text (by design)

## Testing

1. Register a new peer → `/admin/groups` returns correct `group_secret`
2. CLI `groups` shows original secret
3. Restart broker with old DB (historical groups) → shows `(unknown)`
4. Re-register peers after upgrade → new groups show correct secrets

## Files Changed

- `broker.ts` — schema migration, `insertGroup` SQL, `/admin/groups` SQL
- `cli.ts` — `groups` command output format
- `README.md` — upgrade notes
- `tests/broker-groups.test.ts` — new test for group_secret in response
