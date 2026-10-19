Add an endpoint `GET /items/:id` to the catalog API in `src/app.mjs`:

- a known id answers 200 with that item as JSON;
- an id that does not exist answers 404 with `{"error":"not found"}`;
- an id that is not a positive integer answers 400 with `{"error":"invalid id"}`;
- other methods on `/items/:id` answer the way the existing routes do.

Add tests for the new endpoint.
