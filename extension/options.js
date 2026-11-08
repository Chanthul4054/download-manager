'use strict';
const $ = (id) => document.getElementById(id);

chrome.storage.local.get({ enabled: true, port: 52790 }).then((s) => {
  $('enabled').checked = s.enabled;
  $('port').value = s.port;
});

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ enabled: $('enabled').checked, port: Number($('port').value) || 52790 });
  $('status').textContent = 'Testing…';
  $('status').className = '';
  chrome.runtime.sendMessage({ type: 'odm-test' }, (r) => {
    if (r?.alive && !r.cfg) {
      $('status').textContent = r.refused
        ? 'OpenDM did not allow this browser. Click the OpenDM toolbar button to ask again.'
        : 'OpenDM is running. Choose Allow in the prompt it shows to connect this browser.';
      $('status').className = 'bad';
    } else if (r?.alive) {
      $('status').textContent = `Connected to OpenDM ${r.cfg.version}. Browser integration is ${r.cfg.enabled ? 'on' : 'off'} in the app.`;
      $('status').className = 'ok';
    } else {
      $('status').textContent = 'Could not reach OpenDM. Make sure the app is running and the port matches.';
      $('status').className = 'bad';
    }
  });
});
