# @pipeworx/phillips

Realized auction prices from Phillips — look up an artist or maker and get
their recent past lots with the price actually paid (hammer plus buyer's
premium), the estimate range it sold against, currency, lot and sale number,
saleroom, department and sale date; pull full detail for any single lot.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1558+ live data sources.

## Tools

- `phillips_results_search(artist?, artist_id?, category?, include_upcoming?, limit?)`
  — realized prices for one maker. Resolves the name against Phillips' own
  artist index, then reads that maker's artist page. `category` is a free-text
  filter matched against department, saleroom, sale number and lot title (e.g.
  "jewels", "watches", "editions", "photographs", "design", "London"). Pass
  `artist_id` from a previous result to skip name resolution entirely.
- `phillips_lot_details(lot_id, slug?)` — full detail for one lot, keyed by the
  `lot_id` a `phillips_results_search` result carries. Adds the hammer price
  (before premium) and the full sale name.

Tool names are house-prefixed on purpose. Bonhams shipped first with bare
`results_search`/`lot_details`; with three art houses live those two names
would collide across packs and `ask_pipeworx` routing would have nothing to
disambiguate on. New house packs should keep the `{house}_` prefix.

## Auth

Keyless. Public pages, no login required.

## Data sources

Phillips' **keyword search is closed to crawlers** — robots.txt (checked
2026-09-05) disallows `/Search`, `/search` AND `/SEARCH`, so all three case
variants of the obvious path are out, along with `/bin/`, `/phillips/otis` and
`/*/filter/`. This pack therefore does not search at all; it goes by maker,
through three paths robots.txt leaves open:

- `https://www.phillips.com/sitemap.xml` — 13,031 `/artist/{makerId}/{name}`
  URLs. This is the artist-name → makerId index names are resolved against.
  Fetched at most once per isolate. **The names in it are percent-encoded AND
  HTML-escaped** (`Jennifer%20&amp;%20Kevin%20McCoy`); take both layers off
  before you use one, or the URL you build goes out double-encoded and 404s.
- `https://www.phillips.com/artist/{makerId}/{slug}` — the artist landing page.
  Realized prices are server-rendered here, and the same rows also ship as JSON
  in the `React.createElement(PhillipsReact.ArtistLanding, {...})` hydration
  props: the `maker` prop is a JSON *string* holding
  `pastLots {currentPage, totalPages, totalCount, resultsPerPage, data[]}`.
  Each row carries `hammerPlusBP` (the realized price), `lowEstimate`,
  `highEstimate`, `currencySign`, `saleNumber`, `lotNumber`, `objectNumber`
  (the lot id) and `auctionStartDateTimeOffset`. **`hammerPlusBP` is `0` for a
  lot that did not sell**, which is an absent price, not a price of zero.
- `https://www.phillips.com/detail/{slug}/{objectNumber}` — the lot page.

The `{slug}` segment of both `/artist/` and `/detail/` URLs is decorative — any
non-empty value resolves the same record, only the numeric id is read.

### Coverage ceiling, and why it is there

The artist page serves **one page of past lots — 24 rows**. Page 2 onward is
fetched by the browser from a different host (`api.phillips.com`), and there is
no query parameter that pages the HTML page itself (`?page=2`, `?p=2` and
`?pastLotsPage=2` were each tried and all return page 1). So
`phillips_results_search` returns the 24 most recent past lots and reports
`total_past_lots` alongside them, so a caller can see how much archive it is
not seeing — Banksy returns 24 of 272, Patek Philippe 24 of 3,728.

### Reading the lot page

The lot page is a different stack from the rest of the site (Remix; the state
blob is a flattened key-then-value array, not an addressable object), so this
pack reads it from three places and prefers the rendered HTML:

- **JSON-LD `Product`** — title, maker, image, currency, sold/unsold. Note
  `offers.price` is the **low estimate**, not a realized price; do not treat it
  as one.
- **Rendered HTML** — `Sold For {cur}{amount}` and `Estimate {cur}{low}–{high}`.
  The estimate MUST come from here: the only `lowEstimate`/`highEstimate` pair
  in the state blob belongs to the page's currency-conversion table, so reading
  it returns a plausible number in the wrong currency (HK$622,000–830,000 for a
  lot whose real estimate is £60,000–80,000).
- **State blob**, for the two fields nothing else carries — `hammerPrice` and
  `auctionStartDateTime`. Because key-to-value adjacency in a flattened array
  is not guaranteed, the hammer price is dropped rather than returned if it
  exceeds the realized price.

### Sale numbers encode department and saleroom

A sale number is `{2-letter saleroom}{2-digit department}{2-digit sequence}{2-digit year}`
— `UK010526` is London, department 01, sale 05, 2026. The department mapping
below was derived from, and agreed with, all 892 past auctions listed on
`/auctions/past` (2026-09-05): `01` Modern & Contemporary Art, `03` Editions &
Works on Paper, `04` Photographs, `05` Design, `06` Jewels, `07` Editions,
Photographs and Design, `08` Watches. `00` and `09` are **not** departments —
they are sale formats (special/collaboration, and online) that run across
departments — and are labelled as such rather than guessed at. Salerooms seen:
`NY` New York, `UK` London, `HK` Hong Kong, `CH`/`GE` Geneva.

## Related packs

`@pipeworx/bonhams` and `@pipeworx/sothebys` cover the same question at the
other two houses. Christie's is out of scope (closed, internal API).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "phillips": {
      "url": "https://gateway.pipeworx.io/phillips/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/phillips/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1558+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "phillips": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-phillips"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-phillips
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Phillips data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
