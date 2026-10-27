/**
 * Saves `parts` as a file. Parts rather than one string, so an export of a
 * million patients never has to exist as a single string (see `query/pipeline.ts`).
 */
export function download(fileName: string, parts: readonly BlobPart[], type: string): void {
  const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  link.click()
  // Revoked later rather than now: some browsers read the blob only after the
  // click handler returns, and an early revoke saves an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
