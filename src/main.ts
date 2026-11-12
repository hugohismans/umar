import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/greek-400.css';
import '@fontsource/ibm-plex-sans/greek-500.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './style.css';
import { Physics } from './client';
import { Bench } from './views/bench';
import { Learn } from './views/learn';
import { Microscope } from './views/microscope';

const TABS = ['microscope', 'bench', 'learn', 'physics'] as const;
type Tab = (typeof TABS)[number];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const boot = $('boot');
let ready = false;
let learn: Learn | null = null;
let bench: Bench | null = null;
let physics: Physics;
let dictD: Float32Array;

function currentTab(): Tab {
  const h = location.hash.replace(/^#\/?/, '');
  return (TABS as readonly string[]).includes(h) ? (h as Tab) : 'microscope';
}

function show() {
  const tab = currentTab();
  for (const t of TABS) $(`view-${t}`).hidden = t !== tab;
  document.querySelectorAll<HTMLAnchorElement>('.tabs a').forEach((a) => {
    const on = a.dataset.tab === tab;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  // the static physics page is readable while the tables are being computed
  boot.hidden = ready || tab === 'physics';
  if (ready && tab === 'bench' && !bench) bench = new Bench($('view-bench'), physics, dictD);
  if (ready && tab === 'learn' && !learn) learn = new Learn($('view-learn'), physics);
  learn?.setActive(tab === 'learn');
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', show);
show();

physics = new Physics((done, total) => {
  $('boot-bar').style.width = `${(100 * done) / total}%`;
  $('boot-sub').textContent = `Exact Mie series for ${done} of ${total} spheres × 401 wavelengths`;
});

physics.ready.then((r) => {
  dictD = r.dictD;
  ready = true;
  new Microscope($('view-microscope'), physics, dictD);
  show();
});
