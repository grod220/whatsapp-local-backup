# Clemcast

A growing family archive assembled from overlapping WhatsApp exports. Original exports and source observations are preserved; a separate, reversible reconciliation produces the reading view.

## Everyday use

Requires Node.js 22 or newer.

```sh
npm ci
npm run parse
```

Export the chat **with media** from WhatsApp and save the ZIP in Downloads. `npm run parse` performs the whole workflow:

1. Preserve original ZIPs, import observations, reconcile posts, and rebuild the reader.
2. Create and verify a complete local incremental checkpoint.
3. Upload only file contents not already in the shared Google Drive backup store; verify every retained object against Drive checksums and download every new object to verify its bytes.
4. Prove recovery and preservation of earlier data, then promote the dated snapshot to the current recovery point.
5. Update the website, skipping unchanged output.

An unchanged rerun uploads **zero data objects** and reuses its dated snapshot. Routine runs create no full recovery ZIP. Each unique file is stored once; exact original WhatsApp ZIPs are retained, so new exports can still contain overlapping media internally. Storage grows for new originals, new media and changed file versions, rather than another copy of the entire archive.

A failure returns a nonzero status, retains the local checkpoint, and blocks website publication. Rerun the same command to retry. If Downloads contains no matching exports, `parse` backs up and publishes the existing archive. An empty project requires an export. Use `npm run preview` to browse locally.

### Your Google Drive folder

Use the existing **Clemcast — Backups** folder; its folder ID and sharing stay the same. It contains:

```text
Clemcast — Backups/
  START HERE - Clemcast backups.txt
  Latest backup - 2026-10-31 10-30 - verified.txt
  Backup data - keep this folder/
    CURRENT.json
    repository.json
    snapshots/    (small dated complete file inventories)
    objects/      (shared immutable file bytes)
```

Open **Latest backup** for the date, archive counts and recovery command. Keep **Backup data**: the text report is a guide, not a standalone backup. Dates shown in the report and filename use the configured display timezone; snapshot filenames contain UTC timestamps.

`CURRENT.json` is replaced only after the candidate passes all preservation checks and Drive readback. Previous dated snapshots and their shared bytes remain recoverable. Earlier messages, source observations, decisions, originals and media cannot disappear from the active archive. Existing unique bytes and historical recovery points are never pruned automatically.

On the first run, older full ZIPs and multipart packages in this folder are downloaded, checked and migrated file for file. Their exact original WhatsApp exports remain exact bytes. Only the generated backup containers are retired to **Drive Trash**, after the combined recovery point and every migrated payload pass verification and recovery proofs. Unknown files and changed legacy artifacts are refused, not deleted. Trash is never permanently emptied by this app.

Migrated older files are also retained through durable references in `archive/legacy-recovery/`, reusing existing immutable media/source files where possible. This keeps manual standalone recovery ZIPs complete without copying current media into another local legacy tree.

The local repository is `.incremental-backup/repository/`; it and all archive data stay out of Git and the website. A verified local `LOCAL.json` checkpoint is written before Drive is contacted. One archive workspace should publish at a time; an observed competing Drive update stops promotion. Interrupted immutable uploads can be retried.

### One-time connections

Install [rclone](https://rclone.org/install/) (on macOS: `brew install rclone`), then connect Google Drive and Cloudflare:

```sh
npm run setup-drive
npx wrangler login
```

The first Drive setup requires a dedicated Google **Desktop app** OAuth client; rclone's shared client is retiring in 2026 and is quota-blocked. In a personal Google Cloud project, enable the Google Drive API, configure an external OAuth app for your own account, and create a Desktop app client. Download its JSON and run `npm run setup-drive -- "/path/to/client.json"`. Follow [rclone's official client setup guide](https://rclone.org/drive/#making-your-own-client-id). Set the OAuth app to **In production** after configuration; Google's Testing mode expires refresh tokens after seven days. This publishes the OAuth app configuration, not your archive or Drive files. Personal use under Google's user limit does not require distributing the app.

`setup-drive` uses a browser Google sign-in. Google credentials live in `~/.config/clemcast/rclone.conf`, outside the repository and recovery ZIPs. Commands target only the folder ID in `clemcast.config.json`; OAuth's Drive scope itself grants broader Drive access. Cleanup moves verified superseded containers to recoverable Trash; it never deletes unique recovery data or empties Trash. Reconnect only if Google revokes access; a recovered/new computer needs its own connections.

The generated `backup-client.html` and `backup-privacy.html` pages describe the backup utility for Google's OAuth app configuration. They contain no archive records or credentials.

To import and create a verified local incremental checkpoint while offline:

```sh
npm run parse -- --local-only
```

To select an export and optionally also create a standalone recovery ZIP:

```sh
npm run parse -- --backup-to /Volumes/Backup/clemcast-new.zip "/path/to/WhatsApp Chat - Clemcast.zip"
```

`clemcast.config.json` sets the default source and display timezone to `Europe/Rome`. An already imported ZIP reuses its recorded source timezone, even if the computer or default timezone changes. For an export made with a different phone timezone, specify it explicitly:

```sh
npm run parse -- --timezone Asia/Tokyo "/path/to/WhatsApp Chat - Clemcast.zip"
```

Original wall clocks, parser versions, date-order choices, and interpreted instants are retained. Ambiguous/nonexistent DST times stop parsing rather than silently choosing an interpretation. Use the appropriate fixed-offset timezone for such an export. `--days-first` and `--months-first` resolve ambiguous date order. No source timestamp is inferred from the computer's timezone.

An identical ZIP with the same parsing settings adds no observations. A changed parsing interpretation is retained as a new batch, linked back to the same original records where their identities agree.

## Preservation and reconciliation

The project's terms are defined in [CONTEXT.md](CONTEXT.md).

- `sources/` stores exact original ZIPs by SHA-256, including failed imports. Legacy originals in `archive/sources/` remain supported.
- `output/GROUP/data.json` preserves the cumulative legacy record index, including every pre-migration record and ID. It is deliberately not rewritten into a deduplicated database.
- `output/GROUP/evidence.json` retains each source export's observations separately, including repeated identical entries, raw parsed bodies/authors, exported wall clocks, source record positions, parser version, and timezone interpretation. The exact original transcript remains inside its ZIP.
- `output/GROUP/reconciliation.json` maps observations to stable post IDs and records the reason for each grouping. Every observation belongs to exactly one post, notice, or export artifact. Rebuilding is deterministic and preserves existing post IDs; merged IDs have retained aliases.
- `output/GROUP/decisions.json` is an append-only record of reviewed links and separations. Later decisions for a pair supersede earlier ones without removing the history.
- `output/GROUP/attachments/` retains every saved media file. A content hash identifies bytes, not a post: deliberately sending the same photo twice remains two posts.
- `archive/objects/` and `archive/snapshots/` retain checksummed historical metadata, evidence, decisions and media inventories. Local metadata snapshots reference media in `output/`; they cannot repair missing media without a complete backup.

Reconciliation matches exact content/author/media/instant across record streams while preserving occurrence counts within each export. One-second drift requires substantial content and independent matching anchors. Large legacy clock differences require at least three independent content anchors for the same record streams, offset and month. Missing-media entries can inherit an established clock alignment only when adjacent identified records already agree. Contact renames and changed text remain separate unless explicitly reviewed.

A placeholder is linked to media only for a complete ordered sequence with equal counts and matching media types within the surrounding upload interval. Partial or ambiguous sequences remain unresolved. These are evidence-based interpretations; every automatic link records its rule and can be split if it is wrong.

## Reading and inspection

The default reading view shows reconciled posts. **Archive details** opens:

- **Group activity** for notices and export headings.
- **Unresolved media** for entries whose files have not been confidently identified.
- **All preserved records** for every legacy and source observation.

**Archive details → Import details** opens a maintenance page with original record IDs, source export hashes, timestamp/body variants, saved attachments, and grouping reasons. The normal reading view has no per-post inspection links. Group activity and unresolved-media views retain links for investigating individual entries. The inspection page works offline without a server.

An “omitted” entry is not proof that another nearby saved file is the same attachment. Unresolved entries stay recoverable and visible until there is sufficient evidence. Checksums establish the integrity of saved data; they cannot establish that a phone export included everything that ever existed in WhatsApp.

To correct a grouping, copy observation IDs from the inspection page:

```sh
npm run reconcile -- clemcast --separate OBSERVATION_A OBSERVATION_B --reason "Verified these are distinct messages"
npm run reconcile -- clemcast --link OBSERVATION_A OBSERVATION_B --reason "Verified both appearances in the original exports"
```

A later link reverses an earlier separation for that pair, and vice versa. Conflicting transitive decisions are refused before the log is changed. Run `npm run backup` afterward, then publish. Every input record and earlier decision stays preserved.

## Complete recovery backups

```sh
npm run backup
npm run backup -- /Volumes/Backup/clemcast-new.zip
npm run verify-backup -- /path/to/backup.zip
```

The default **v3 complete recovery ZIP** contains `output/`, all retained `archive/` history, every original ZIP in `sources/`, checksummed inventories, and the exact project tooling/configuration needed to resume importing. Originals missing locally prevent creating a complete backup. Existing backups are never replaced.

`npm run parse` uses the incremental Drive store by default. `npm run backup` explicitly creates a standalone local ZIP for occasional portability or another disk. It includes migrated legacy recovery history as well as the current archive. Existing ZIPs are never replaced. Periodically test recovery into a new directory.

A smaller **v2 reader backup** remains available explicitly:

```sh
npm run backup -- --reader /path/to/reader-backup.zip
```

It includes the cumulative viewer, media and metadata history but excludes original ZIPs and tooling. Missing originals are reported. Earlier v2 backups remain readable and verifiable.

Verification checks all stored SHA-256 values, follows every historical snapshot reference, validates observation/post coverage, checks original-export inventories, and requires all recovery dependencies. A checksum-consistent package that omits a required photo, original export, or snapshot fails verification.

## Recover from Drive or an incremental folder

```sh
npm run backup-history
npm run recover-drive -- /path/to/new-clemcast-recovery
npm run recover-drive -- /path/to/new-historical-recovery --snapshot DATED_SNAPSHOT_NAME.json
```

Recovery downloads shared objects, verifies checksums and the complete recovery references, and creates a new directory only after verification. It retains historical objects and manifests beside the recovered current files. Existing destinations are refused. A recovered project needs `npm ci` and its own Google connection to resume automatic uploads.

If you download the **entire** Clemcast Drive folder, keep its structure. Recover offline with:

```sh
npm run recover-incremental -- "/path/to/downloaded/Clemcast — Backups" /path/to/new-recovery
npm run recover-incremental -- .incremental-backup/repository /path/to/new-local-recovery --local
```

Older migrated containers are listed by `backup-history` with their original names. A standalone ZIP also includes their durable file inventories in `archive/legacy-recovery/snapshots/`; recover one after unpacking the ZIP with:

```sh
npm run recover-legacy -- /path/to/unpacked-project DATED_LEGACY_SNAPSHOT.json /path/to/new-legacy-files
```

## Recover a standalone ZIP

```sh
npm run recover -- /path/to/complete-backup.zip /path/to/new-recovery-directory
```

Recovery verifies the package before extraction, creates a new directory, and checks recovered history, media and originals. Existing destinations are refused. For a v3 backup with tooling, run `npm ci` in the recovered directory, then `npm run audit` or `npm run preview`. To resume on another existing checkout, transfer `output/`, `archive/`, and `sources/` together. Git excludes all private archive directories.

To inspect a historical snapshot in another new output directory:

```sh
npm run restore -- /path/to/recovered/archive /path/to/new-historical-output SNAPSHOT_HASH
```

The adjacent recovered `output/` supplies media. Both legacy v1 and current v2 snapshots are supported. Earlier legacy snapshots may predate source observations and reconciliation. They preserve their original record sets.

## Migration from the legacy record index

Migration requires an already verified complete backup covering the current collection. Assign a timezone to each retained source explicitly; establish it from the original transcripts and independent matching posts before running:

```sh
npm run migrate -- clemcast /path/to/complete-before-migration.zip SOURCE_SHA256=Europe/Rome OTHER_SOURCE_SHA256=Asia/Tokyo
```

Migration retains legacy `data.json` bytes exactly, preserves all existing attachment references, adds source evidence, and builds reconciliation. Create a new complete backup after migration. No migration deletes legacy records or media.

## Publish

```sh
npx wrangler login
npm run deploy
```

The project's local Wrangler CLI publishes `output/` to the `clemcast` Pages project; `DEPLOY_PROJECT` can override the project. Deployment checks archive continuity, every generated reading/raw/activity/unresolved day file, and the source inspection links. A stale or incomplete rebuild blocks publication. Unchanged output skips deployment; a failed deployment leaves the saved deployment hash unchanged.

## Validation and operations

```sh
npm run check
npm test
npm run audit
```

Tests cover additive imports, source retention and replay, host-independent timezone interpretation and DST, occurrence-preserving reconciliation, deliberate photo resends, uncertain matches, reversible decisions, legacy recovery, complete recovery with originals, corruption/truncation detection, interrupted rebuilds, chunk retries, and backup compaction safeguards.

Imports and backups use atomic complete-file writes and a single-process lock. An import refuses shortened/changed retained records or observations. If a killed process leaves `.backup-lock/`, confirm the PID in `owner.json` has stopped before removing that lock directory.

Chat names choose groups. Download suffixes such as ` (1)` are treated as copies. To target an existing group after a chat rename, use `--group clemcast`; distinct chats with colliding slugs remain separate. Exactly equal exported chat names cannot establish that two unrelated conversations are the same.

Old archives that copied media into `archive/objects/` remain readable. After saving a complete backup offsite, downloading it, and testing recovery, `npm run compact-archive -- /path/to/downloaded.zip` removes only media objects already duplicated in `output/` and covered by that verified backup. It retains all metadata, source ZIPs, snapshots, output media, unknown objects, and earlier backups. Imports never run compaction automatically.
