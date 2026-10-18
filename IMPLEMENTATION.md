# Implementation contract

Baseline: iOS JPOriginalTitles v7.0.2. Repositories and installed artifacts are independent.
This file describes internal interfaces; user-facing documentation is README.md.

## Modules

- `wire.mjs`: exports `encodeRequest(entities, context)`, `decodeMetadata(bytes)`,
  `parseTrack(bytes, uri)`, `parseAlbum(bytes, uri)`, `parseArtist(bytes, uri)`, and
  generic `fields`, `ld`, `vi`, `concat`, `replaceString` for lossless wire adapters.
  Metadata decoder returns `{ entries, tracks:Map, albums:Map, artists:Map }`.
  Each entry is `{uri, kind, status, value:Uint8Array}`.
  A track is `{uri,name,originalTitle,versionTitle,albumURI,albumName,
  artists:[{uri,name}],canonicalURI,isrc,duration,number,disc,performanceLanguages}`.
  Durations/positions are decoded exact integers, not GraphQL rounded values.
  Album is `{uri,name,originalURI,tracks:[uri],complete}`.
  Artist is `{uri,name}`. Empty names are valid completed results.
- `resolver.mjs`: exports class `Resolver`.
  Constructor `{request,store,isStrict,log}`. `request(entities,language,signal)`
  returns protobuf bytes; entities are `{uri,kinds:[number]}`.
  `resolve(uris,{signal}={})` returns `{tracks:Map,sourceTracks:Map,albums:Map,artistNames:Map,
  failures:[],complete:boolean}`. Track mappings are requested URI -> preferred
  metadata, preserving requested playback identity. Resolver exposes `clear()`
  and `stats()`. Lookup cache is in process; persistent names use store.
  `sourceTracks` contains metadata before adoption. `observedUris` records only
  client-requested entities for explicit metadata refresh. Mac recording and
  verified artist-alias safeguards supplement the iOS baseline; see the local
  investigation log for the exact behavior and evidence boundaries.
- `transform.mjs`: exports `createTransformer({resolver,store,isStrict,log})`
  returning `{rewriteJSON, rewriteNative, rewritePlayer, rewriteMetadata}`.
  All methods are asynchronous, leave input unmodified, commit old-value and
  artist-name deltas before delivering changes, and return the same envelope
  shape. `rewriteJSON(value,{signal,priority=1})` handles GraphQL and typed
  entity objects. `rewriteNative(message,{signal})` handles decoded Esperanto
  MetadataService messages. `rewritePlayer(message,{signal})` handles player
  messages. `rewriteMetadata(bytes,{signal})` handles HTTP protobuf responses.
  Unrelated fields, local files and user playlist names are preserved.
- `storage.mjs`: exports class `Store`, async `open()`, `commit({artistNames,
  previous})`, `reset()`, `stats()`, `getArtistNames():Map`, `getPrevious(uri)`.
  `previous` is `[{uri,field,value,priority}]`, fields title/artists/album,
  values string or string[]. Explicit empty `value` suppresses previous values;
  equal-priority conflicts suppress; lower priority never overrides higher.
  Commit is atomic and fails closed. No row-count eviction. An optional
  `prepare({getPrevious})` callback validates the final delivery using projected
  values inside the serialized commit, before either table is written. A failed
  preparation leaves both tables unchanged. High-priority suppression records
  remain durable so lower-priority responses cannot repopulate hidden values.
- `hooks.mjs`: exports `installHooks({Spicetify,transformer,log})` returning
  `{dispose(), status(), refresh()}`. Narrow HTTP response and native callback
  adapters; own lookups bypass enhancement. All wrappers restore on dispose,
  preserve cancellation and serialize per-stream callback delivery.
- `wire-overlay.mjs`: overlays explicitly identified changes onto original native
  protobuf bytes, preserving unknown fields at supported message boundaries.
  Ambiguous normalized map entries are rejected before storage commit. Native
  service/method coverage is explicit; unsupported methods pass through.
- `network.mjs`: exports `createRequest({Spicetify,fetch,log})` returning the
  resolver request callback. Authentication stays in process. Captured original
  fetch avoids recursive interception. No credentials in logs.
- `management.mjs`: exports `installManagement({Spicetify,store,resolver,hooks,
  settings,log})` returning `{dispose()}`. Namespaced settings, diagnostics,
  export, plugin reset, runtime state refresh and explicit platform limits.
- `index.mjs`: entrypoint; waits for APIs, opens store, constructs components,
  supports version prompt, publishes namespaced status/dispose API.

## Build and tests

ES modules and Node built-in test runner; esbuild produces one browser IIFE
`dist/jp-original-titles.js`. Tests must exercise wire handling, selection,
batch/retry, delivery, persistence/previous fields, hooks and cancellation.
No installed runtime dependency on the iOS checkout or Node.js.
