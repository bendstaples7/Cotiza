# Jobber read contract

Jobber list reads no longer use an empty array to mean “the call failed.”

## Result

`JobberReadMeta` (and `JobberReadResult<T>`, which adds `records`) is the shared shape.

| `status` | Meaning |
| --- | --- |
| `live` | The Jobber API was called and returned one or more records. |
| `empty` | The Jobber API was called and returned zero records. This is a real empty result. |
| `cached` | Records come from a recent successful read or from saved rows. The live API was not called again, and it did not fail. |
| `failed` | The live read did not succeed. `records` may still hold a cache, webhook rows, or the saved catalog. |

Other fields:

- `source`: `live`, `cache`, `webhook`, `stored`, `mixed`, or `none`.
- `fetchedAt`: when those records were obtained, if known.
- `liveLookupFailed`: true only when the live Jobber call failed. A genuine empty list keeps this false.
- `error.code`: `auth`, `timeout`, `throttled`, `graphql`, `database`, `network`, or `unavailable`.

Saved webhook rows do not set `available` to true. `GET /api/quotes/jobber/status` makes a live probe. `available` is true only when that probe succeeds. `webhookActive` is separate.

## Response changes

`GET /api/quotes/jobber/requests`

```json
{ "requests": [], "available": false, "read": { "status": "failed", "source": "webhook", "fetchedAt": null, "liveLookupFailed": true, "error": { "code": "timeout", "message": "..." } } }
```

`available` is true only for a successful live read in that response (`live` or `empty`). A cache hit is `status: "cached"` and `available: false`. If the live call failed and webhook rows are included, `source` is `webhook` or `mixed` and `liveLookupFailed` is true.

`GET /api/quotes/jobber/status`

```json
{ "available": false, "webhookActive": true, "read": { "status": "failed", "source": "none", "fetchedAt": null, "liveLookupFailed": true, "error": { "code": "auth", "message": "..." } } }
```

`GET /api/quotes/catalog`

```json
{ "catalog": [], "jobber": { "status": "failed", "source": "stored", "fetchedAt": null, "liveLookupFailed": true, "error": { "code": "database", "message": "..." } } }
```

`catalog` is always the saved product table. `jobber` describes the Jobber lookup. A failed lookup does not turn Jobber products off.

Catalog sync outcomes are `synced`, `empty`, or `failed`. `empty` means Jobber successfully returned no products and stored rows are left as they are. `failed` means no insert and no deactivate, even if an older cache still has products.

## Callers

`checkJobberStatus()` now returns `{ available, webhookActive, read }` instead of a boolean.

`fetchJobberRequests()` adds `read`.

`fetchCatalog()` still returns the product array. `fetchCatalogResult()` also returns `jobber`.
