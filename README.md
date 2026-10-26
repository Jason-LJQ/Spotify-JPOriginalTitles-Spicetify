# JP Original Title (Spicetify)

Restore original Japanese track, album and artist names in Spotify Desktop, with previous values available in Credits.

Based on [Spotify JPOriginalTitles for iOS](https://github.com/Jason-LJQ/Spotify-JPOriginalTitles). The Spicetify extension has independent builds and releases, with additional desktop matching safeguards.

![Illustration of original title restoration](assets/preview.png)

## Features

- Enhances structured HTTP responses and native metadata delivery before Spotify renders them.
- Uses original-release metadata, canonical links and verified associated-album or single-hop sibling matches. Unresolved names retain Spotify's values.
- Looks up artist names with Chinese-first and conservative Japanese fallback rules, retaining playable artist links.
- Rejects canonical candidates whose recording identifiers and exact durations both conflict. Independently queried artist identities take priority over unverified positional associations.
- Adds **Original Metadata** to Credits. **Title**, **Artist** and **Album** show only nonempty values actually replaced by the extension.
- Saves track and album lookups, verified artist information and previous fields in a dedicated IndexedDB database. Cached lookups are reused after restarting Spotify.
- Shares duplicate lookups across pages and skips unnecessary album lookups after a verified direct match.
- Shows changed song names as **Original title｜Previous title** (U+FF5C, no spaces) by default, with an option to show only the original title. Album and artist names keep their original-name display.
- Includes optional Strict Mode, diagnostics, plugin-cache reset and viewed-metadata refresh.

The extension does not translate titles, rename playlists, change Spotify's language, replace audio or unlock restricted releases. It was developed on macOS; Windows and Linux compatibility has not been established.

## Install from Marketplace

1. Install [Spicetify](https://spicetify.app/) and [Marketplace](https://github.com/spicetify/marketplace).
2. Open **Marketplace → Extensions** and search for **JP Original Title (Spicetify)**.
3. Install the extension and reload Spotify.

The public repository uses the `spicetify-extensions` topic and a root `manifest.json` for [automatic discovery](https://github.com/spicetify/marketplace/wiki/Publishing-to-Marketplace). A new repository may take time to appear in GitHub's search index or an existing Marketplace session.

Use one installation method at a time. Remove a previous manual installation before installing the Marketplace copy.

## Manual installation

Download `jp-original-titles.js` from the [latest release](https://github.com/Jason-LJQ/Spotify-JPOriginalTitles-Spicetify/releases/latest) and place it in your Spicetify **Extensions** directory. On macOS this is normally `~/.config/spicetify/Extensions/`.

Enable it with the standard Spicetify commands:

```sh
spicetify config extensions jp-original-titles.js
spicetify apply
```

For a client with custom patches, the optional local installer below adds only this extension without reapplying Spicetify.

To remove a manual installation:

```sh
spicetify config extensions jp-original-titles.js-
spicetify apply
```

## Management and updates

Open **JP Original Title (Spicetify)** in Spotify's profile menu, or use its topbar button.

**Show original and previous song titles** is on by default. Turn it off to show only the restored song name. Changing it refreshes metadata viewed in this session; reopen existing pages to update their displayed titles. Saved lookups and previous names are retained.

Diagnostic logging and Strict Mode are off by default. Strict Mode blocks enhanced responses when a lookup or parser fails and can prevent affected pages from loading.

**Reset Plugin Cache** clears this extension's saved lookups, learned names, artist verification and previous fields. **Refresh Viewed Spotify Metadata** expires supported metadata for entities observed in the current session. Settings and the installation-prompt choice survive a plugin-cache reset. Records have no row-count eviction.

Marketplace resolves the manifest and extension bundle from `main`. For manual updates, replace the JavaScript file with the latest release and reload Spotify. Release assets and their SHA-256 checksums are available on GitHub.

## Limitations

- Matching starts from the iOS v7.0.2 baseline, with additional Mac recording-conflict and artist-identity safeguards. Ambiguous or undiscoverable matches retain Spotify's values.
- A track can adopt an original album name while an independently unverified album page retains its existing heading.
- Extra lookups can delay metadata delivery. Exact recording checks use TRACK_V4 rather than rounded GraphQL durations.
- Native cache files, playback-resume files, system media information and other Connect devices are outside the extension's storage controls.
- Previous names cannot be reconstructed retrospectively. Some existing client caches need metadata refresh or a restart.
- Spotify and Spicetify updates can change the private interfaces used by this extension.

## Build and local installation

Requires Node.js 22 or later and Python 3 for the optional installer. The installed extension has no Node.js or iOS repository dependency.

```sh
npm ci
npm test
npm run check
npm run build
npm run check:marketplace
npm run install:local
```

Restart Spotify after local installation. The installer preserves other extensions and guarded Spotify/SpotX assets, and prints a restore-snapshot path:

```sh
python3 tools/install-local.py --restore /absolute/path/to/manifest.json
```

Restoration refuses to overwrite files changed after the snapshot.

## Maintenance

`manifest.json` points to the bundled `dist/jp-original-titles.js`. Commit the rebuilt bundle when changing the source; CI checks that the published artifact matches it. Each GitHub release also provides the single-file extension for manual installation.

This repository builds independently. The sibling iOS project and shared workspace logs are optional local development resources; they are not required by Marketplace or the extension.
