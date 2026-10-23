import { params } from './common.js';
import { mountMain } from './main-view.js';
import { mountProgress, mountComplete, mountNewDownload, mountLinks, mountDrop, mountCountdown } from './views.js';
import { mountGrabber } from './grabber-view.js';
import { mountLinkGrabber } from './linkgrabber-view.js';

const VIEWS = {
  main: mountMain,
  progress: mountProgress,
  complete: mountComplete,
  newdl: mountNewDownload,
  links: mountLinks,
  drop: mountDrop,
  countdown: mountCountdown,
  grabber: mountGrabber,
  linkgrabber: mountLinkGrabber,
};

const root = document.getElementById('app');
(VIEWS[params.get('view')] || mountMain)(root).catch((e) => {
  root.textContent = 'Failed to load: ' + e.message;
  console.error(e);
});
