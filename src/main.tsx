import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { params } from '@/services/ipc';
import { WindowRoot } from '@/app/WindowRoot';

// Every OpenDM window loads this page; ?view= says which one it is (see open_view in app.rs).
const VIEWS = {
  main: lazy(() => import('@/app/MainWindow')),
  progress: lazy(() => import('@/windows/ProgressWindow')),
  complete: lazy(() => import('@/windows/CompleteWindow')),
  newdl: lazy(() => import('@/windows/NewDownloadWindow')),
  links: lazy(() => import('@/windows/LinksWindow')),
  drop: lazy(() => import('@/windows/DropWindow')),
  countdown: lazy(() => import('@/windows/CountdownWindow')),
};

const view = (params.get('view') || 'main') as keyof typeof VIEWS;
const View = VIEWS[view] || VIEWS.main;
if (view === 'drop') document.documentElement.classList.add('transparent-window');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WindowRoot>
      <Suspense fallback={null}>
        <View />
      </Suspense>
    </WindowRoot>
  </StrictMode>,
);
