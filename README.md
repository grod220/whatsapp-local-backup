# Clemcast

A growing WhatsApp archive across phones and exports. Every import adds to the history already on this computer. Earlier messages and media stay available when a newer export contains less history.

## Import and browse

```sh
npm install
npm run parse
```

This imports **all** matching WhatsApp export ZIPs in Downloads, including older copies of the same chat. To choose exports or a backup destination:

```sh
npm run parse -- "/path/to/WhatsApp Chat - Clemcast.zip"
npm run parse -- --backup-to "/Volumes/Backup/clemcast-2026-09-10.zip" "/path/to/export.zip"
```

Successful runs create a uniquely named cumulative ZIP on the Desktop by default. Existing backup ZIPs are never replaced. `npm run preview` opens the local viewer. Publishing is separate: `npm run deploy` verifies the collection before publishing `output/`.

## Publish to Cloudflare Pages

Use Node.js 22 or newer. `npm install` includes the project's local Wrangler CLI; a global installation is not needed. Authenticate with Cloudflare once, then deploy:

```sh
npx wrangler login
npm run deploy
```

The default Pages project is `clemcast`; set `DEPLOY_PROJECT` to use another project. Unchanged output skips deployment. A failed deployment leaves the saved deploy hash unchanged, so retrying will still publish the pending changes. If dependencies were installed without development tools, run `npm install --include=dev` first.

## Storage and retention

- **`output/`** is the cumulative message database, media collection, and offline viewer. Imports preserve every existing record, ID, and media file. Matching media is reused by content hash; different bytes with the same exported filename are retained separately.
- **`archive/objects/`** stores small historical versions of messages and metadata. New snapshots do **not** copy media into this directory.
- **`archive/snapshots/`** records the files and SHA-256 hashes belonging to each historical snapshot. `archive/latest.json` selects the latest one. Every historical media reference is checked before making a portable backup, including unreferenced attachments.
- **`sources/`** preserves exact original WhatsApp ZIPs by SHA-256, including exports that fail to parse. `archive/receipts/` records their original filenames. Legacy originals already in `archive/sources/` are also retained.

Old full-object archives from the earlier format remain readable. Their duplicate local media is only removed by the explicit compaction command after a verified offsite backup is available. Unknown objects, metadata, snapshots, and original exports are never removed by compaction.

Import safety includes complete-file atomic writes, a single-process lock, verification of media hashes, and checks that existing records have not shrunk or changed. An unreadable or shortened history stops the import. No import cleans up old media or deduplicates existing records away.

### Matching across phones

Messages are matched by full timestamp, author, text, attachment, and occurrence count. Repeated identical messages in one export survive. Indistinguishable records across exports use the greatest observed occurrence count; the original ZIPs remain available separately. Changed timestamp precision, contact names, or timezone can produce extra displayed copies. WhatsApp exports do not supply reliable cross-device IDs, so uncertain matches are kept conservatively.

Unresolved media references and apparent parsing artifacts are retained. A warning identifies files named in the transcript but absent from the export. Exporting again with media may supply them. The parser interprets dates in the computer's local timezone; `--days-first` and `--months-first` select ambiguous date order. Original transcript bytes remain in `sources/`.

## Portable backup format (v2)

```sh
npm run backup
npm run backup -- "/Volumes/Backup/clemcast-2026-09-10.zip"
npm run verify-backup -- "/path/to/backup.zip"
```

A v2 ZIP contains:

- `output/`, including the offline viewer and each media file once.
- `archive/`, including all retained message/metadata history, snapshot inventories, and source receipts. Duplicate media objects and raw source ZIPs are excluded.
- `backup.json`, a versioned checksum inventory and list of separately retained source exports.
- `README.txt`, with recovery instructions.

Unzip and open `output/index.html` in a browser. Reading the current collection requires no server or project installation. The ZIP preserves the cumulative viewer and its snapshot history. **Original WhatsApp ZIPs are separate**: save each file in `sources/` to offsite storage once, for example a `RawSources` subfolder beside the dated cumulative backups. Including overlapping originals in every cumulative ZIP would repeatedly duplicate their media. `backup.json` records which originals belong to the archive, but does not contain their bytes.

Imports and backups do not automatically upload anything to Google Drive. Keep dated cumulative ZIPs in Clement/Clemcast, retain previous backups, and verify a downloaded copy. Keep the original source collection separately. Git excludes all private data directories; cloning this repository does not restore your conversations.

## Restore

For complete recovery or a new computer, unzip a cumulative backup and copy **both** its `output/` and `archive/` directories into this project before importing. Restore the separate original ZIPs into `sources/` when available. Move damaged working directories aside rather than overwriting the only remaining copies.

To reconstruct a snapshot in a **new** directory with this project's tooling:

```sh
npm run restore -- "/path/to/unpacked/archive" recovered-output
npm run restore -- "/path/to/unpacked/archive" recovered-old-output SNAPSHOT_HASH
```

The adjacent unpacked `output/` supplies the media. Both legacy v1 and current v2 snapshots are supported. Files and checksums are verified before the destination is created, and the viewer is regenerated. Existing restore destinations are never replaced.

To repair local metadata using intact local media, `npm run restore` writes `restored-output/`. **Small local snapshots alone cannot repair missing or damaged media**: use a complete backup for that. To combine a local snapshot with media from a downloaded backup:

```sh
npm run restore -- archive recovered-output latest "/path/to/unpacked/output"
```

Historical snapshots are for inspection and recovery; imports enforce the latest cumulative history, so a smaller historical snapshot cannot silently replace the live collection. If reimporting a hash-named original ZIP, pass `--group clemcast` to identify its existing chat.

## One-time removal of duplicate local media

After creating the v2 backup, saving it offsite, downloading it, and verifying a full restore:

```sh
npm run compact-archive -- "/path/to/downloaded-backup.zip"
```

This checks the downloaded ZIP's stored bytes against **all current files and retained snapshots**. Only media objects already duplicated in `output/` and covered by that verified ZIP are removed. It does not remove metadata objects, original exports, snapshots, output files, or older portable backups. Compaction is explicit and safe to repeat; imports never invoke it automatically. The command verifies bytes but cannot establish where a file was downloaded from; the offsite upload/download step must happen first.

## Renamed chats and interrupted operations

Chat names choose groups; distinct names with colliding slugs get separate directories. To merge a renamed chat into an existing group:

```sh
npm run parse -- --group clemcast "/path/to/WhatsApp Chat - New Name.zip"
```

Exactly equal exported chat names cannot automatically distinguish unrelated conversations; rename one export to keep it separate. A trailing ` (1)`, ` (2)`, etc. is treated as a downloaded duplicate filename. When changing computers, transfer the full collection before deploying; deployment cannot discover another computer's unrelated history.

If a process is killed, `.backup-lock/` may remain. Confirm the recorded PID in `.backup-lock/owner.json` has stopped before removing that lock directory and retrying. A failed import may leave additional source files or media retained; rerunning preserves previous records.

## Validation

```sh
npm run check
npm test
```

Tests cover additive imports, corrupt/missing history, duplicate messages, media collisions, source retention, atomic writes, locking, old and new snapshot restoration, standalone portable recovery, historical media coverage, and compaction refusing damaged or stale backups.
