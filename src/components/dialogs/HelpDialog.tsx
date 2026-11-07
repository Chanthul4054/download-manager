import * as React from 'react';
import { Copy, FolderOpen, Lightbulb } from 'lucide-react';
import { invoke } from '@/services/ipc';
import { useApp } from '@/stores/app';
import { copyText } from '@/app/commands';
import { Dialog } from '@/components/ui/overlay';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/cn';

const H2 = ({ children }: { children: React.ReactNode }) => <h3 className="mt-5 mb-1.5 text-sm font-semibold text-fg first:mt-0">{children}</h3>;
const P = ({ children }: { children: React.ReactNode }) => <p className="mb-2 text-sm leading-relaxed text-fg-2">{children}</p>;
const UL = ({ children, ordered }: { children: React.ReactNode; ordered?: boolean }) => {
  const C = ordered ? 'ol' : 'ul';
  return <C className={cn('mb-2 flex flex-col gap-1 pl-5 text-sm leading-relaxed text-fg-2', ordered ? 'list-decimal' : 'list-disc')}>{children}</C>;
};
const Code = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-fg select-text">{children}</code>;

function ExtensionFolder() {
  const [dir, setDir] = React.useState('…');
  React.useEffect(() => void invoke('util:extensionDir').then(setDir), []);
  return (
    <div className="my-2 flex flex-col gap-2 rounded-lg border border-line bg-subtle/50 p-2.5">
      <code className="font-mono text-xs break-all text-fg select-text">{dir}</code>
      <div className="flex gap-1.5">
        <Button size="sm" onClick={() => invoke('util:openPath', dir)}>
          <FolderOpen />
          Open folder
        </Button>
        <Button size="sm" onClick={() => copyText(dir, 'Path copied')}>
          <Copy />
          Copy path
        </Button>
      </div>
    </div>
  );
}

const TOPICS: Record<string, [string, () => React.ReactNode]> = {
  start: [
    'Getting started',
    () => (
      <>
        <H2>Ways to start a download</H2>
        <UL>
          <li>Click a download link in Chrome or Edge with the OpenDM extension installed; matching file types are taken over automatically.</li>
          <li>Right-click a link and choose “Download with OpenDM”, or “Download all links” on a page.</li>
          <li>Copy an address to the clipboard (when clipboard monitoring is on).</li>
          <li>Use New download, or drag a link onto the window or the floating drop target.</li>
          <li>Use Batch download for numbered addresses such as pic01.jpg … pic99.jpg.</li>
          <li>From the command line (below).</li>
        </UL>
        <H2>Keys</H2>
        <P>Hold the bypass key (Alt by default) while clicking a link to let the browser download it. Hold the force key (Insert by default) to always download with OpenDM.</P>
        <H2>Command line</H2>
        <P>
          <Code>OpenDM /d URL [/p folder] [/f name] [/a] [/n] [/q]</Code> or <Code>OpenDM /s</Code>
        </P>
        <UL>
          <li>/d URL — download a file</li>
          <li>/p — folder to save to; /f — file name</li>
          <li>/a — add to the main queue without starting</li>
          <li>/n — silent: no dialogs</li>
          <li>/q — exit after the download finishes</li>
          <li>/s — start the main queue</li>
        </UL>
        <H2>How downloads are accelerated</H2>
        <P>Files are split dynamically: each new connection takes the second half of the largest remaining piece. A connection that finishes its piece continues into the next one if that piece has not started yet, so no time is lost reconnecting. Progress is saved every few seconds, so downloads resume correctly after a pause, crash or power cut.</P>
        <H2>Shortcuts</H2>
        <UL>
          <li>Ctrl+N new download · Ctrl+B batch · Ctrl+L LinkGrabber · Ctrl+G site grabber</li>
          <li>Ctrl+F search · F3 next match · Ctrl+, settings · Ctrl+1…8 pages</li>
          <li>In the list: Enter open, Alt+Enter properties, Space pause or resume, Del remove, Shift+Del remove and delete the file</li>
          <li>Ctrl+= and Ctrl+- change the text size</li>
        </UL>
      </>
    ),
  ],
  extension: [
    'Browser extension',
    () => (
      <>
        <H2>Install the OpenDM browser extension</H2>
        <P>The extension lets OpenDM take over downloads, adds right-click menu items, and shows a “Download this video” panel on web players.</P>
        <UL ordered>
          <li>Open chrome://extensions (or edge://extensions).</li>
          <li>Turn on Developer mode.</li>
          <li>
            Click “Load unpacked” and choose the OpenDM extension folder:
            <ExtensionFolder />
          </li>
          <li>Pin the OpenDM icon. Clicking it turns integration on or off for the browser.</li>
        </UL>
        <P>
          The extension talks to the app on 127.0.0.1, port <b className="text-fg">{useApp.getState().settings.general.integrationPort}</b>. If you change the port, change it in the extension options too.
        </P>
      </>
    ),
  ],
  queues: [
    'Scheduler and queues',
    () => (
      <>
        <H2>Queues</H2>
        <P>The Main Download queue downloads its files one or several at a time and removes each file when it finishes. If a file fails it moves to the end of the queue; a file that is alone is retried every 30 seconds, or up to the retry limit you set.</P>
        <P>Synchronization queues re-check every file on the server and download it again only when it changed. Files stay in the queue.</P>
        <H2>Scheduling</H2>
        <P>Each queue can start and stop at set times on chosen days or a single date. When it finishes it can open a file, exit OpenDM, or shut down, restart, sleep or hibernate the computer (with a 30-second chance to cancel). These actions do not run when you stop the queue yourself.</P>
        <H2>Download limits</H2>
        <P>Settings → Speed and limits caps how much is downloaded per period (for example 200 MB per hour). Downloads pause at the limit and resume on their own.</P>
      </>
    ),
  ],
  linkgrabber: [
    'LinkGrabber',
    () => (
      <>
        <H2>LinkGrabber</H2>
        <P>The LinkGrabber (Ctrl+L) is a waiting area for links. Links you add are checked online in the background — name, size and whether the file still exists — and sorted into packages before anything is downloaded.</P>
        <UL>
          <li>Add links by pasting text with “Add links”, from “Download all links” in the browser, from a clipboard batch or a text-file import. Turn on “Collect every address copied to the clipboard” to gather links while you browse.</li>
          <li>Parts of a split archive (name.part1.rar, name.z01, name.7z.001 …) are grouped into one package. Single files go into “Various files”, dead links into “Offline”.</li>
          <li>With deep analysis, a web page address is replaced by the files it links to.</li>
          <li>Use the filters to hide hosts, file types or offline links. “Start all” adds what is visible and checked.</li>
          <li>Right-click to rename packages, choose a save folder, move links into a new package, split a package by host, or check links again.</li>
        </UL>
        <P>Packages with several files are saved into a subfolder named after the package. Auto-confirm can add links to the download list on its own a few seconds after the last check.</P>
      </>
    ),
  ],
  grabber: [
    'Site grabber',
    () => (
      <>
        <H2>Site grabber</H2>
        <P>The grabber explores a web site and collects files that match your filters — for example every image or every PDF.</P>
        <UL ordered>
          <li>Start page, project name and optional login.</li>
          <li>Where to save files, and whether to keep the site folder structure.</li>
          <li>Which pages to explore: link levels on this site and on other sites, parent folders, sub-domains, include and exclude filters.</li>
          <li>Which files to collect: types, path filters, size limits, duplicates.</li>
        </UL>
        <P>Explore first and check the files you want, or let the grabber download everything it finds. Projects are saved and can be scheduled for a one-time run or periodic synchronization.</P>
      </>
    ),
  ],
};

export function HelpDialog({ topic = 'start', onOpenChange }: { topic?: string; onOpenChange: (o: boolean) => void }) {
  const [t, setT] = React.useState(TOPICS[topic] ? topic : 'start');
  const Body = TOPICS[t][1];
  return (
    <Dialog open onOpenChange={onOpenChange} title="Help" size="xl" bodyClassName="p-0" footer={<Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button>}>
      <div className="flex h-[28rem] border-t border-line">
        <nav className="flex w-48 shrink-0 flex-col gap-px border-r border-line bg-sidebar p-2">
          {Object.entries(TOPICS).map(([id, [label]]) => (
            <button key={id} onClick={() => setT(id)} className={cn('h-7 rounded-md px-2 text-left text-sm text-fg-2 hover:bg-muted hover:text-fg', t === id && 'bg-muted font-medium text-fg')}>
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <Body />
        </div>
      </div>
    </Dialog>
  );
}

const TIPS = [
  'OpenDM takes over a download from the browser when its type is in Settings → File types.',
  'If a server keeps failing, add the file to a queue and start the queue: it retries every 30 seconds.',
  'Hold Insert while clicking a link to force OpenDM to download it; hold Alt to let the browser download it.',
  'Right-click a column header to choose which columns to show; drag headers to reorder them.',
  'Turn off “Show the Download File Info dialog” in Settings → Downloads for silent downloading.',
  'Drag a finished download out of the list to drop the file into a folder or another program (hold Shift to drag it onto a queue instead).',
  'Save logins for protected servers in Settings → Site logins so you are not asked every time.',
  'Expired link? Right-click the download and choose “Refresh download address” to keep the progress.',
  'Click the speed in the status bar to cap the total download speed without opening settings.',
];

export function TipDialog({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const [i, setI] = React.useState(() => Math.floor(Math.random() * TIPS.length));
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Did you know"
      size="sm"
      footer={
        <>
          <Button onClick={() => setI((i + 1) % TIPS.length)}>Next tip</Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <Lightbulb className="mt-0.5 size-4 shrink-0 text-warn" />
        <p className="min-h-12 text-sm leading-relaxed text-fg-2">{TIPS[i]}</p>
      </div>
    </Dialog>
  );
}
