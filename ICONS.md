# Icons and logos

Every image the KoalaFix listings use. All files live in `plugins/koalafix/assets/`, because Claude Code and Codex
only accept an icon path inside the plugin folder and Cursor resolves its logo from the plugin root.

## Source mark

The KoalaFix K (since 29 Oct 2026): a serif K in chestnut (`#552814`) with a green leaf (`#4E8A52`), centred on a
cream rounded square (`#FAF6EC`, corner radius 112 on a 512 view box) with transparent corners. The source is
`koalafix.svg`; the PNGs were rendered from it at 2048 px and scaled down, so every size has the same proportions.
The brand originals live in the vault (`gtm/brand/k-logo-2026-10/koalafix-k-app-icon*`). The violet K of the first
listings is retired: no listing, package or store page uses it.

## Files

| File | Size | Format | Used by | Referenced from |
|---|---|---|---|---|
| `koalafix-512.png` | 512 x 512 px | PNG | Claude plugin directory icon; Claude connector directory icon (uploaded in the portal); OpenAI plugin directory `logo` | `.claude-plugin/plugin.json` `icon`, `.codex-plugin/plugin.json` `interface.logo` |
| `koalafix-64.png` | 64 x 64 px | PNG | Codex and ChatGPT `composerIcon` (square, at least 48 x 48) | `.codex-plugin/plugin.json` `interface.composerIcon` |
| `koalafix-48.png` | 48 x 48 px | PNG | Small-icon slots (OpenAI's minimum size) | none |
| `koalafix.svg` | 512 x 512 view box | SVG | Cursor Marketplace logo | `.cursor-plugin/plugin.json` `logo` |

The MCP Registry entry (`server.json`) uses the icon the KoalaFix server serves itself, `https://mcp.koalafix.com/favicon.svg`,
so the registry does not depend on this repository.

## Limits per surface

| Surface | Rule |
|---|---|
| Claude plugin directory | `icon` is a path to an image inside the plugin; non-image files must stay under 256 KiB |
| Claude connector directory | Icon required in the Listing step; size not stated, the 512 px PNG is uploaded |
| OpenAI plugin directory (ChatGPT and Codex) | `logo` and `composerIcon` square, at least 48 x 48, PNG, JPEG, WebP or SVG, at most 5 MiB, raster at most 4096 px |
| Cursor Marketplace | `logo` committed in the repository, relative path, SVG accepted |
| Official MCP Registry | `icons[].src` an https URL of at most 255 characters; PNG, JPEG, SVG or WebP |
