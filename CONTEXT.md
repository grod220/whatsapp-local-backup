# Clemcast

A growing family archive assembled from overlapping WhatsApp exports.

## Language

**Source export**: The exact ZIP received from WhatsApp, including its original transcript and any supplied media.

**Observation**: One appearance of a message in a source export, or one preserved legacy record whose original export may be unknown.

**Post**: A message in the conversation, supported by one or more observations. Sending the same text or photo again creates another post.

**Reconciliation**: A reversible interpretation linking observations to posts, with the evidence for each link retained.

**Unresolved media**: An observation referring to media that has not been confidently linked to a saved attachment.

**Recovery backup**: A verified collection containing the source exports, observations, reconciliation decisions, media, and history needed to recover the archive.

**Backup object**: Immutable file bytes identified by SHA-256, stored once and shared across recovery points.

**Backup snapshot**: A dated complete file inventory referencing backup objects. It is a recovery point, distinct from a metadata snapshot in `archive/snapshots/`.

**Current backup**: The verified backup snapshot referenced by `CURRENT.json`. Promotion requires retention checks, Drive checksum verification and a recovery proof.

**Legacy recovery history**: The verified file contents of older generated full backup ZIPs, including files absent from the current reader. Durable mappings in `archive/legacy-recovery/` keep this history recoverable from a standalone ZIP too.
