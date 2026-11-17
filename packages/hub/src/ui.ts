import { readFileSync } from "node:fs"

interface Asset {
  body: Uint8Array
  type: string
}

const CSP = "default-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"

function load(file: string, type: string): Asset {
  return { body: readFileSync(new URL(`./ui/${file}`, import.meta.url)), type }
}

const assets = new Map<string, Asset>([
  ["/", load("index.html", "text/html; charset=utf-8")],
  ["/ui/app.js", load("app.js", "text/javascript; charset=utf-8")],
  ["/ui/app.css", load("app.css", "text/css; charset=utf-8")],
])

/**
 * Static UI served from the hub origin. Unauthenticated by design: the page
 * carries no data, and every API call still needs the bearer token.
 */
export function uiAsset(path: string): Response | null {
  const asset = assets.get(path)
  if (!asset) return null
  return new Response(asset.body, {
    headers: {
      "content-type": asset.type,
      "cache-control": "no-store",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
    },
  })
}
