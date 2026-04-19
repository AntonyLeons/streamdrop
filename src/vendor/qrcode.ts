let cached: string | undefined
let building: Promise<string> | undefined

export async function getQRCodeVendorJS() {
  if (cached) return cached
  if (building) return building

  building = (async () => {
    const entry = new URL("./qrcode-entry.ts", import.meta.url).pathname
    const result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "iife",
      minify: true,
    })

    if (!result.success) {
      throw new Error(result.logs.map((l) => l.message).join("\n") || "vendor_build_failed")
    }

    const out = result.outputs[0]
    if (!out) throw new Error("vendor_build_failed")
    const text = await out.text()
    cached = text
    return text
  })()

  return building
}
