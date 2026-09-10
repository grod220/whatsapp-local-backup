export interface MessageWithId {
  id: string;
  date: Date;
  author: string | null;
  message: string;
  attachment?: string;
  missingAttachment?: string;
  source?: string; // SHA-256 of the original export in archive/sources
  system?: true;
}

export interface AttachmentManifest {
  contentHashes: Record<string, string>; // contentHash -> filename
}

export interface ChunkInfo {
  filename: string;      // e.g., "2024-01-15.js"
  date: string;          // ISO date string "2024-01-15"
  messageCount: number;
  firstMessageId: string;
  lastMessageId: string;
}

export interface ChunkManifest {
  totalMessages: number;
  chunks: ChunkInfo[];   // Ordered newest-first for easy loading
}
