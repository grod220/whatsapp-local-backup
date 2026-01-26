export interface MessageWithId {
  id: string;
  date: Date;
  author: string | null;
  message: string;
  attachment?: string;
  system?: true;
}

export interface AttachmentManifest {
  contentHashes: Record<string, string>; // contentHash -> filename
}
