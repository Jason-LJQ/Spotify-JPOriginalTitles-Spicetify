export const SETTINGS_KEY = 'jp-original-title-spicetify.settings';
export const observedURIs = resolver => [...new Set([
  ...(resolver.observedUris || []), ...(resolver.clients?.keys?.() || [])
])];

export async function applyResetActions({ plugin, metadata, store, resolver, refreshMetadata }) {
  if (!plugin && !metadata) return false;
  const uris = observedURIs(resolver);
  if (metadata) await refreshMetadata(uris);
  if (plugin) { await store.reset(); resolver.clear(); }
  return true;
}

export function createSettings(storage = globalThis.localStorage) {
  let value = { strict: false, logging: false, installChoice: false, combineTitles: true };
  try { value = { ...value, ...JSON.parse(storage.getItem(SETTINGS_KEY) || '{}') }; } catch { /* Retain safe defaults. */ }
  return {
    get strict() { return value.strict === true; },
    get logging() { return value.logging === true; },
    get installChoice() { return value.installChoice === true; },
    get combineTitles() { return value.combineTitles !== false; },
    snapshot() { return { ...value }; },
    update(patch) { const next = { ...value, ...patch }; storage.setItem(SETTINGS_KEY, JSON.stringify(next)); value = next; }
  };
}

export function installManagement({ Spicetify: S, store, resolver, hooks, settings, log, diagnostics, buildID, version, channel = 'local-development' }) {
  const disposables = [];
  const element = (tag, content, parent) => {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    parent?.append(node); return node;
  };
  const notify = message => S.showNotification?.(message);
  async function refreshMetadata(uris = observedURIs(resolver)) {
    const api = S.Platform.PlaylistAPI?._metadataExtensionsAPI;
    if (!api?.expire) throw new Error('Metadata refresh is unavailable in this Spotify client');
    await api.expire(...uris.map(uri => [uri, 178, ...(uri.startsWith('spotify:track:') ? [10, 186] : uri.startsWith('spotify:album:') ? [9] : [8])]));
    resolver.clear();
    resolver.restore?.();
    await hooks.refresh?.();
    return uris.length;
  }
  const saveFile = () => {
    const report = { name: 'JP Original Title (Spicetify)', channel, version, buildID,
      settings: settings.snapshot(), hooks: hooks.status(), lookup: resolver.stats(), storage: store.stats(), diagnostics: diagnostics() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'jp-original-title-diagnostics.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  function button(parent, label, action) {
    const node = element('button', label, parent); node.type = 'button';
    node.style.cssText = 'padding:8px 14px;margin:6px 8px 6px 0;border:1px solid #777;border-radius:18px;background:transparent;color:inherit;cursor:pointer';
    node.addEventListener('click', async () => {
      node.disabled = true;
      try { await action(); } catch (error) { log('management-error', error.message); notify(error.message); }
      finally { node.disabled = false; }
    });
    return node;
  }
  function checkbox(parent, label, checked, change) {
    const row = element('label', undefined, parent); row.style.cssText = 'display:flex;gap:10px;align-items:center;margin:12px 0';
    const input = element('input', undefined, row); input.type = 'checkbox'; input.checked = checked;
    element('span', label, row); input.addEventListener('change', () => change?.(input.checked)); return input;
  }
  function show() {
    const body = element('div'); body.style.cssText = 'max-width:640px;line-height:1.6;padding-bottom:12px';
    element('p', `${version ? `v${version}` : 'Local development build'} · ${buildID}`, body);
    const summary = element('p', undefined, body);
    const update = () => { const s = store.stats(); summary.textContent = `${s.lookupEntities ?? 0} cached tracks/albums · ${s.artistNames} artist names · ${s.previousFields} previous fields · ${(s.bytes / 1024).toFixed(1)} KB stored data (estimate)`; };
    update();
    const combined = checkbox(body, 'Show original and previous song titles', settings.combineTitles, async value => {
      combined.disabled = true;
      try {
        settings.update({ combineTitles: value });
        await refreshMetadata();
        notify('Title display saved. Reopen the page to update existing titles.');
      } catch (error) {
        combined.checked = settings.combineTitles;
        log('title-display-refresh-error', error.message);
        notify('Reopen pages or restart Spotify to apply the saved title display setting.');
      } finally { combined.disabled = false; }
    });
    element('p', 'Show changed songs as Original title｜Previous title. Turn off to show only the original title.', body);
    checkbox(body, 'Strict Mode', settings.strict, value => settings.update({ strict: value }));
    element('p', 'Strict Mode blocks enhanced responses when a lookup or parsing fails. It can prevent pages from loading.', body);
    checkbox(body, 'Diagnostic logging', settings.logging, value => settings.update({ logging: value }));
    const actions = element('div', undefined, body);
    button(actions, 'Export Diagnostics', saveFile);
    button(actions, 'Clear Diagnostics', () => { diagnostics(true); notify('Diagnostics cleared.'); });
    element('hr', undefined, body);
    const plugin = checkbox(body, 'Reset Plugin Cache', false);
    const metadata = checkbox(body, 'Refresh Viewed Spotify Metadata', false);
    element('p', 'Metadata refresh covers entities observed by this extension. Playback resume, login, audio downloads and other extensions are retained.', body);
    element('p', 'Playback resume reset is unavailable in a desktop extension.', body);
    button(body, 'Apply', async () => {
      const applied = await applyResetActions({ plugin: plugin.checked, metadata: metadata.checked,
        store, resolver, refreshMetadata });
      if (!applied) { notify('Select an action first.'); return; }
      plugin.checked = false; metadata.checked = false;
      settings.update({ lastReset: new Date().toISOString() }); update(); notify('Selected actions completed.');
    });
    if (settings.snapshot().lastReset) element('p', `Last reset: ${new Date(settings.snapshot().lastReset).toLocaleString()}`, body);
    const detail = element('details', undefined, body); element('summary', 'Connection Status', detail);
    element('pre', JSON.stringify(hooks.status(), null, 2), detail).style.cssText = 'white-space:pre-wrap;font-size:12px';
    S.PopupModal.display({ title: 'JP Original Title (Spicetify)', content: body, isLarge: true });
  }
  if (S.Menu?.Item) { const item = new S.Menu.Item('JP Original Title (Spicetify)', false, show); item.register(); disposables.push(() => item.deregister()); }
  if (S.Topbar?.Button) {
    try { const item = new S.Topbar.Button('JP Original Title', 'edit', show); disposables.push(() => item.element?.remove()); } catch { /* The profile menu remains available. */ }
  }
  function offerSetup() {
    if (settings.installChoice) return;
    const body = element('div');
    element('p', 'Clear plugin data and refresh metadata already viewed in this session?', body);
    element('p', 'Playback resume and audio downloads are retained.', body);
    button(body, 'Cancel', () => { settings.update({ installChoice: true }); S.PopupModal.hide(); });
    button(body, 'Confirm', async () => {
      await applyResetActions({ plugin: true, metadata: true, store, resolver, refreshMetadata });
      settings.update({ installChoice: true }); S.PopupModal.hide();
    });
    S.PopupModal.display({ title: 'JP Original Title (Spicetify)', content: body });
  }
  return { show, offerSetup, refreshMetadata, dispose() { for (const dispose of disposables.reverse()) dispose(); } };
}
