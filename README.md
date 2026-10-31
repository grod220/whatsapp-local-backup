# Clemcast

A growing family archive assembled from overlapping WhatsApp exports. Original exports and source observations are preserved; a separate, reversible reconciliation produces the reading view.

## Everyday use

Requires Node.js 22 or newer.

```sh
npm ci
npm run parse
```

Export the chat **with media** from WhatsApp and save the ZIP in Downloads. `npm run parse` performs the whole workflow:

1. Preserve the original export ZIPs, import observations, reconcile posts, and rebuild the reader.
2. Create and verify a complete local recovery ZIP.
3. Check that earlier records, original exports, media and recovery history survive in the replacement.
4. Upload the ZIP, download it in full, and verify its SHA-256 and all recovery dependencies.
5. Promote the dated ZIP, move superseded backup containers to recoverable Drive Trash, then update the website.

A failure returns a nonzero status, keeps a verified local ZIP, and blocks website publication. Rerun the same command to retry. If Downloads contains no matching exports, `parse` backs up and publishes the existing archive. An empty project requires an export. Use `npm run preview` to browse locally.

### Your Google Drive folder

The existing folder is named **Clemcast**, with the same folder ID and sharing. After a successful run it contains one file:

```text
Clemcast/
  2026-10-31 - Clemcast.zip
```

The filename date uses the configured timezone (`Europe/Rome`). It identifies when that backup was created; an unchanged run keeps the existing name and uploads nothing. Download and unzip it normally:

```text
output/       Site pages, messages and saved photos/videos
sources/      Exact original WhatsApp exports
archive/      Metadata snapshots and earlier recovery history
src/, scripts/, tests/, package.json, ...   Tools to continue the archive
backup.json   Checksums and recovery inventory
README.txt    Offline recovery instructions
```

Open **output/index.html** to read the site without installing anything. Keep the whole unzipped directory for complete recovery. The site payload is directly in the ZIP, with its normal filenames.

**Replacement is safe before it is tidy.** A new ZIP is uploaded under a temporary name while the old copy remains. The command downloads and verifies the entire candidate, proves the old file contents remain recoverable, and checks that the current records have not been shortened. Only then does it rename the candidate and move superseded copies to Trash. A failed run can leave extra temporary or previous ZIPs; a successful retry verifies them before cleanup. Unknown files or observed competing updates stop replacement. Use one publishing workspace at a time. The app never permanently empties Trash.

Backups are incremental in what they preserve: unchanged media and originals are reused, and earlier changed file versions are retained through `archive/legacy-recovery/`. Generated recovery ZIPs found in retained history are automatically unpacked into checksummed file references. Their unique contents are retained once; the redundant generated ZIP envelope is omitted. Original WhatsApp export ZIPs and genuine posted attachments always remain exact bytes. This avoids keeping another complete copy for every run. Exact WhatsApp export ZIPs are preserved unchanged, so overlapping original exports still take additional space. New records, originals, media and retained history naturally grow the archive.

**A changed ordinary ZIP must be uploaded in full.** ZIP replacement is not an incremental network transfer. An unchanged run reuses the verified ZIP and checks Drive's SHA-256 without uploading another copy. Local generated ZIPs are cached under ignored `backups/automatic/`; after successful replacement only the current generated ZIP is kept there. User-created backups and original exports are never pruned.

The former Drive object folder and guide files are migrated file for file into durable recovery history inside the ZIP before they move to Trash. Every old payload, including files absent from the current site, stays recoverable. Historical generated ZIP envelopes recover as `.contents/` directories containing their original file trees. Their original container hashes and complete member inventories remain in `archive/legacy-recovery/containers/`. Local legacy source containers remain available as a safety copy; they are excluded from new ZIPs only after the full member inventory and every retained payload pass verification.

### One-time connections

Install [rclone](https://rclone.org/install/) (on macOS: `brew install rclone`), then connect Google Drive and Cloudflare:

```sh
npm run setup-drive
npx wrangler login
```

The first Drive setup requires a dedicated Google **Desktop app** OAuth client; rclone's shared client is retiring in 2026 and is quota-blocked. In a personal Google Cloud project, enable the Google Drive API, configure an external OAuth app for your own account, and create a Desktop app client. Download its JSON and run `npm run setup-drive -- "/path/to/client.json"`. Follow [rclone's official client setup guide](https://rclone.org/drive/#making-your-own-client-id). Set the OAuth app to **In production** after configuration; Google's Testing mode expires refresh tokens after seven days. This publishes the OAuth app configuration, not your archive or Drive files. Personal use under Google's user limit does not require distributing the app.

`setup-drive` uses a browser Google sign-in. Google credentials live in `~/.config/clemcast/rclone.conf`, outside the repository and recovery ZIPs. Commands target only the folder ID in `clemcast.config.json`; OAuth's Drive scope itself grants broader Drive access. Cleanup moves verified superseded containers to recoverable Trash; it never deletes unique recovery data or empties Trash. Reconnect only if Google revokes access; a recovered/new computer needs its own connections.

The generated `backup-client.html` and `backup-privacy.html` pages describe the backup utility for Google's OAuth app configuration. They contain no archive records or credentials.

To import and create a verified local recovery ZIP while offline:

```sh
npm run parse -- --local-only
```

To select an export and also save the complete ZIP to another disk:

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

A later link reverses an earlier separation for that pair, and vice versa. Conflicting transitive decisions are refused before the log is changed. Run `npm run parse` afterward to back up and publish. Every input record and earlier decision stays preserved.

## Complete recovery backups

```sh
npm run backup
npm run backup -- /Volumes/Backup/clemcast-new.zip
npm run verify-backup -- /path/to/backup.zip
```

The default **complete recovery ZIP** contains `output/`, all retained `archive/` history, every original ZIP in `sources/`, checksummed inventories, and the exact project tooling/configuration needed to resume importing. Originals missing locally prevent creating a complete backup. Existing backups are never replaced.

`npm run parse` creates the complete ZIP and safely replaces the Drive copy automatically. `npm run backup` creates an extra standalone local ZIP for another disk. Manual destination ZIPs are never overwritten. Periodically test recovery into a new directory.

A smaller **v2 reader backup** remains available explicitly:

```sh
npm run backup -- --reader /path/to/reader-backup.zip
```

It includes the cumulative viewer, media and metadata history but excludes original ZIPs and tooling. Missing originals are reported. Earlier v2 backups remain readable and verifiable.

Compacted recovery ZIPs use portable format v4; older v2 reader and v3 complete ZIPs remain supported. V4 validates every expanded-container dependency, including unique old files absent from the current site. Before replacing a pre-compaction backup, the command compares each original generated container’s complete member names and checksums against its retained inventory. An accidentally copied generated backup in site output blocks publication.

Verification checks all stored SHA-256 values, follows every historical snapshot reference, validates observation/post coverage, checks original-export inventories, and requires all recovery dependencies. A checksum-consistent package that omits a required photo, original export, or snapshot fails verification.

## Recover from Drive

Download and unzip the dated ZIP directly, or use:

```sh
npm run recover-drive -- /path/to/new-clemcast-recovery
```

This downloads the current ZIP, verifies every checksum and recovery reference, and creates a new directory only after verification. Existing destinations are refused. Run `npm ci` in the recovered project, then `npm run audit` or `npm run preview`. A new computer needs its own Google and Cloudflare connections to resume automatic backups and publication.

Older file sets retained inside the ZIP are listed locally by `npm run backup-history`. To restore one into a new directory after unzipping:

```sh
npm run recover-legacy -- /path/to/unpacked-project LEGACY_SNAPSHOT.json /path/to/new-legacy-files
```

`npm run recover-incremental` remains available only for compatibility with previously downloaded object-store backups. It is not the current Drive format.

## Recover a standalone ZIP

```sh
npm run recover -- /path/to/complete-backup.zip /path/to/new-recovery-directory
```

Recovery verifies the package before extraction, creates a new directory, and checks recovered history, media and originals. Existing destinations are refused. For a complete backup with tooling, run `npm ci` in the recovered directory, then `npm run audit` or `npm run preview`. To resume on another existing checkout, transfer `output/`, `archive/`, and `sources/` together. Git excludes all private archive directories.

To inspect a historical snapshot in another new output directory:

```sh
npm run restore -- /path/to/recovered/archive /path/to/new-historical-output SNAPSHOT_HASH
```

The adjacent recovered `output/` supplies media. Both legacy v1 and current v2 metadata snapshots are supported. Earlier legacy snapshots may predate source observations and reconciliation. They preserve their original record sets.

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
