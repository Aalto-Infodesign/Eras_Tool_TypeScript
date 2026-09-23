/**
 * Handing a string to the user as a file.
 *
 * Trivial, but it lives on its own because several unrelated features export
 * something — clusters, silhouettes, and the selection later — and none of them
 * should have to import from another feature's module to do it.
 */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** Strips everything a filesystem might object to. Typology keys are `A-B-C`. */
export const safeFilename = (value: string): string => value.replace(/[^\w-]+/g, "_")
