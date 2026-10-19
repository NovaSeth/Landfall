# catalog-api

A small catalog API. `src/app.mjs` maps a plain request object (`{ method, url }`) to a plain response
(`{ status, headers, body }`), so the routing logic is tested without opening a socket.

| Route | Answer |
|---|---|
| `GET /health` | `{"ok":true}` |
| `GET /items` | every item as a JSON array |

Unknown paths answer 404 with `{"error":"not found"}`. A known path with another method answers 405 with an
`allow` header listing the accepted methods.

Run the tests with `npm test`.
