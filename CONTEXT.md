# Clemcast

A growing family archive assembled from overlapping WhatsApp exports.

## Language

**Source export**: The exact ZIP received from WhatsApp, including its original transcript and any supplied media.

**Observation**: One appearance of a message in a source export, or one preserved legacy record whose original export may be unknown.

**Post**: A message in the conversation, supported by one or more observations. Sending the same text or photo again creates another post.

**Reconciliation**: A reversible interpretation linking observations to posts, with the evidence for each link retained.

**Unresolved media**: An observation referring to media that has not been confidently linked to a saved attachment.

**Recovery backup**: A verified collection containing the source exports, observations, reconciliation decisions, media, and history needed to recover the archive.

**Retained file version**: Earlier file bytes identified by SHA-256. Durable recovery mappings reuse immutable sources/media or retain otherwise missing bytes in `archive/legacy-recovery/objects/`.

**Recovery history**: Checksummed file inventories and retained versions inside the complete ZIP, distinct from metadata snapshots in `archive/snapshots/`.

**Current backup**: The single dated `YYYY-MM-DD - Clemcast.zip` in the Google Drive folder named `Clemcast`. It directly contains the site output, original exports, history and tooling. Safe replacement requires retention checks and full Drive download verification before superseded containers move to recoverable Trash. Changed ZIPs upload in full; unchanged runs reuse the verified copy.

**Legacy recovery history**: The verified file contents of older generated full backup ZIPs, including files absent from the current reader. Durable mappings in `archive/legacy-recovery/` keep this history recoverable from a standalone ZIP too.

**Generated backup container**: A derived recovery ZIP, distinct from an exact WhatsApp source export or authentic posted attachment. When retained inside historical backups it is expanded into a complete checksummed member inventory. Its original file contents remain recoverable, without retaining another full ZIP envelope in each new backup.

**Expanded container**: A v4 recovery descriptor in `archive/legacy-recovery/containers/`. It records the original generated ZIP hash, size, member paths and content hashes, with durable locations for each payload. Older references resolve through this descriptor; recovery produces a `.contents/` directory. Expansion requires comparison against the complete original container before cloud replacement. Source exports, posted media, and current post records never use this exception.

**Reading album**: A reversible display group of three or more consecutive saved photos/videos by one author, bounded to one minute from the first item and one display day. Text, other senders, notices, unsupported media and unresolved media split batches. Album manifests reference individual post IDs; they never merge canonical posts or source observations.

**Video poster**: A small derived JPEG used for a media preview. It is kept separately from the unchanged original attachment, can be rebuilt, and is included in the site and recovery ZIP.
