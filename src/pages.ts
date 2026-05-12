import type { Session } from "./sessions"

// ---------------------------------------------------------------------------
// Template engine
// ---------------------------------------------------------------------------

const TEMPLATES_DIR = new URL("../templates/", import.meta.url)

/** In-memory cache so each file is only read from disk once. */
const templateCache = new Map<string, string>()

async function loadView(relativePath: string): Promise<string> {
  if (templateCache.has(relativePath)) return templateCache.get(relativePath)!
  const text = await Bun.file(new URL(relativePath, TEMPLATES_DIR)).text()
  templateCache.set(relativePath, text)
  return text
}

/**
 * Resolves all `<!--#include partial="name.html"-->` comments in a template
 * by inlining the corresponding file from `templates/partials/`.
 * Partials are resolved recursively (depth-limited to avoid cycles).
 */
async function resolvePartials(html: string, depth = 0): Promise<string> {
  if (depth > 5) return html
  const matches = [...html.matchAll(/<!--#include partial="([^"]+)"[^>]*-->/g)]
  const replacements = await Promise.all(
    matches.map(async ([tag, name]) => {
      const partial = await loadView(`partials/${name!}`)
      return [tag, await resolvePartials(partial, depth + 1)] as const
    }),
  )
  for (const [tag, resolved] of replacements) {
    html = html.replace(tag, resolved)
  }
  return html
}

/**
 * Replaces all `{{key}}` tokens in a string with the corresponding value.
 * Keys not present in the map are left as-is.
 */
function applyTokens(html: string, tokens: Record<string, string>): string {
  return html.replace(/\{\{(\w+)\}\}/g, (match, key: string) => tokens[key] ?? match)
}

/** Load a view, resolve its partials, then substitute tokens. */
async function render(viewPath: string, tokens: Record<string, string> = {}): Promise<string> {
  const raw = await loadView(viewPath)
  const withPartials = await resolvePartials(raw)
  return applyTokens(withPartials, tokens)
}

// ---------------------------------------------------------------------------
// Page renderers
// ---------------------------------------------------------------------------

export async function renderUploadPage(session: Session | null, nonce: string): Promise<string> {
  const config = session
    ? JSON.stringify({
        id: session.id,
        uploadToken: session.uploadToken,
        downloadToken: session.downloadToken,
        name: session.fileName,
        size: session.fileSize,
      })
    : "{}"

  return render("upload.html", {
    title: "StreamDrop — Encrypted File Transfer",
    heading: "StreamDrop",
    subtitle: "End-to-end encrypted. Zero storage. Real-time.",
    session_id: escapeHtml(session?.id ?? "—"),
    nonce,
    config,
    server_url: process.env.STREAMDROP_SERVER || "https://streamdrop.app",
  })
}

export async function renderDownloadPage(session: Session, nonce: string): Promise<string> {
  const config = JSON.stringify({
    id: session.id,
    downloadToken: session.downloadToken,
    name: session.fileName,
    size: session.fileSize,
  })

  return render("download.html", {
    title: "StreamDrop — Receive File",
    heading: "Receive",
    subtitle: "Decryption happens locally in your browser. The server never sees your file.",
    session_id: escapeHtml(session.id),
    nonce,
    config,
  })
}

export async function renderNotFoundPage(nonce: string): Promise<string> {
  return render("not-found.html", {
    title: "StreamDrop — Not Found",
    heading: "StreamDrop",
    subtitle: "Encrypted file transfer.",
    nonce,
  })
}

export async function renderServiceUnavailablePage(nonce: string): Promise<string> {
  return render("service-unavailable.html", {
    title: "StreamDrop — Busy",
    heading: "StreamDrop",
    subtitle: "Encrypted file transfer.",
    nonce,
  })
}

export async function renderPrivacyPage(nonce: string): Promise<string> {
  return render("privacy.html", {
    title: "StreamDrop — Privacy Policy",
    nonce,
  })
}

export async function renderTermsPage(nonce: string): Promise<string> {
  return render("terms.html", {
    title: "StreamDrop — Terms of Service",
    nonce,
  })
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
