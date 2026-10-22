# Icons and logos

Every image the Kalibrate listings need. All files live in `plugins/kalibrate/assets/`, because Claude Code
and Codex only accept an icon path inside the plugin folder and Cursor resolves its logo from the plugin root.
None of these files exist yet: export them before the repository is published.

## Source mark

The source is the dashboard `favicon.svg` in the private Kalibrate repository: a navy rounded square
(`#0F2A43`), a light K stroke (`#E8EEF1`) and a green dot (`#6BD49A`) on a 32 by 32 view box. Export images from
it with a design tool. Do not copy any code or other file from the private repository into this one.

Export on a square canvas. Keep the mark centred with the same padding at every size, and check the 64 px
version is still readable, since it is shown in a composer at small size.

## Files

| File | Size | Format | Used by | Referenced from |
|---|---|---|---|---|
| `kalibrate-512.png` | 512 x 512 px | PNG | Claude plugin directory icon; Claude connector directory icon (uploaded in the portal); OpenAI plugin directory `logo`; MCP Registry icon | `.claude-plugin/plugin.json` `icon`, `.codex-plugin/plugin.json` `interface.logo`, `server.json` `icons` |
| `kalibrate-64.png` | 64 x 64 px | PNG | Codex and ChatGPT `composerIcon` (square, at least 48 x 48); MCP Registry small icon; server `serverInfo.icons` | `.codex-plugin/plugin.json` `interface.composerIcon`, `server.json` `icons` |
| `kalibrate.svg` | square view box | SVG | Cursor Marketplace logo; MCP Registry vector icon; server `serverInfo.icons` | `.cursor-plugin/plugin.json` `logo`, `server.json` `icons` |
| `kalibrate-400.png` | 400 x 400 px | PNG | Cline MCP marketplace (attached to the submission issue, not referenced by any manifest) | none |

## Limits per surface

| Surface | Rule | Status |
|---|---|---|
| Claude plugin directory | `icon` is a path to an image inside the plugin; image files are allowed in the bundle (non-image files must stay under 256 KiB) | Size and format not stated: UNCONFIRMED, 512 px PNG planned |
| Claude connector directory | Icon required in the Listing step | Size and format not stated: UNCONFIRMED, upload the 512 px PNG |
| OpenAI plugin directory (ChatGPT and Codex) | `logo` and `composerIcon` square, at least 48 x 48, PNG, JPEG, WebP or SVG, at most 5 MiB, raster at most 4096 px; dark variants optional | Confirmed |
| Cursor Marketplace | `logo` committed in the repository, relative path, SVG accepted | Pixel size not stated: UNCONFIRMED |
| Cline MCP marketplace | 400 x 400 PNG | Confirmed |
| Official MCP Registry | `icons[].src` an https URL of at most 255 characters; PNG, JPEG, SVG or WebP; optional `sizes` and `theme` | Confirmed (schema 2025-12-11) |
| MCP `serverInfo.icons` | Served by the Kalibrate server itself; it defaults to the dashboard mark | Server side, not in this repository |

The `server.json` icon URLs point at `raw.githubusercontent.com` for this repository's `main` branch, so the
files must be committed before the registry entry is published.
