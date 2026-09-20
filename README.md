# Email Rendering Lab

Local workbench for render previews.

Run `npm install`, then `npm run dev`. Tests: `npm test`.

## Read-only snapshots

`POST /api/snapshots` pins a template revision, a client capability profile and
all referenced resources into a read-only snapshot, shared via a local short
link (`/#/s/<id>`) — nothing leaves the local service.

- Resources are content-addressed (SHA-256) and deduplicated; identical bytes
  are stored once, also across snapshots.
- Each snapshot manifest records every resource digest plus an HMAC signature
  over the whole manifest. Reads re-verify the signature and re-hash every
  resource; tampered or missing content is rejected with 409, never rendered
  partially.
- Snapshots expire (default TTL 7 days). `POST /api/maintenance/cleanup`
  removes expired snapshots and deletes only resources no remaining snapshot
  references. Reads hold a shared lock and cleanup the exclusive lock, so a
  read racing cleanup always sees a complete page.
- The snapshot view (`#/s/<id>`) is strictly read-only: it shows degradation
  explanations and MIME part locating for the pinned client profile, and
  clearly distinguishes the pinned revision from the current editable draft.
