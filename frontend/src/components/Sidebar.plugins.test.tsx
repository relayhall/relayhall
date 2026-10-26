// @vitest-environment jsdom
/**
 * The sidebar's plugin widgets.
 *
 * THE DEFECT THESE TESTS CLOSE. Every healthy `rh.plugin/1` plugin declaring a
 * `sidebar_widget` used to render inside the single circular `.avatar-container`
 * (180px, `overflow:hidden`, `border-radius:50%`). Two widgets therefore shared
 * one circle as flex siblings and were squeezed and clipped together — the
 * owner's browser finding on the parked TST release. The circle now carries
 * exactly ONE identity widget and every other widget gets its own labelled
 * block below it; and because the Orb's own `/avatar` page is a `100px 1fr`
 * grid with textual telemetry rather than a circular graphic, the identity host
 * drops the circular mask (`avatar-container--widget`) whenever it carries a
 * plugin widget instead of the legacy circular `OrbAvatar`.
 */
import '@testing-library/jest-dom/vitest';
import {act,cleanup,render,screen,within} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {Sidebar} from './Sidebar';
import {PluginFrame} from './PluginFrame';
const state=vi.hoisted(()=>({plugins:[] as any[],legacy:vi.fn(()=>vi.fn()),bridge:vi.fn(()=>vi.fn())}));
vi.mock('../contexts/PluginContext',()=>({usePlugins:()=>({plugins:state.plugins,pluginSidebarItems:[],loading:false})}));
vi.mock('../hooks/usePrincipals',()=>({useMyPrincipal:()=>({me:{id:'reader',handle:'reader-account'}})}));
vi.mock('../utils/browserSession',()=>({useBrowserSession:()=>true}));
vi.mock('./StatusOrb',()=>({StatusOrb:({size}:{size:number})=> <span data-size={size}>Connection status</span>}));
vi.mock('../utils/orbStatus',()=>({orbStatusBus:{setConnected:vi.fn()},attachOrbStatusForwarder:state.legacy}));
vi.mock('../utils/pluginBridge',()=>({attachPluginBridge:state.bridge,trustedPluginMessage:()=>false}));
beforeEach(()=>{
 state.plugins=[];vi.clearAllMocks();localStorage.clear();vi.useFakeTimers();
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
async function sidebar(){
 const result=render(<MemoryRouter><Sidebar connected /></MemoryRouter>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(2100);});
 return result;
}
/** A healthy v1 plugin declaring a sidebar widget. */
const widget=(name:string,height=160)=>({name,healthy:true,schema_version:'rh.plugin/1',
 api_base:'/plugins/'+name,sidebar_widget:{path:'/avatar',height}});
const ORB=widget('nim-orb',160);
const USAGE=widget('usage-limits',200);
/** The circular identity host, and the block section below it. */
const host=(c:HTMLElement)=>c.querySelector('.avatar-container') as HTMLElement;
const section=(c:HTMLElement)=>c.querySelector('.sidebar-plugin-widgets') as HTMLElement|null;

test('migrated Orb composes one real widget iframe and no legacy status feed',async()=>{
 state.plugins=[{name:'nim-orb',healthy:true,schema_version:'rh.plugin/1',api_base:'/plugins/nim-orb',sidebar_widget:{path:'/avatar',height:160}}];
 const {container}=await sidebar();
 expect(container.querySelectorAll('iframe')).toHaveLength(1);
 expect(screen.getByTitle('Activity Status')).toHaveAttribute('src','/api/plugins/nim-orb/avatar');
 // The legacy avatar frame is not drawn beside the widget.
 expect(container.querySelector('.sidebar-orb-frame')).toBeNull();
 expect(screen.queryByText('Connection status')).not.toBeInTheDocument();
 expect(state.bridge).toHaveBeenCalledTimes(1);
 expect(state.legacy).not.toHaveBeenCalled();
});
test('legacy Orb still uses one legacy iframe and feed',async()=>{
 state.plugins=[{name:'nim-orb',healthy:true}];
 const {container}=await sidebar();
 expect(container.querySelectorAll('iframe')).toHaveLength(1);
 expect(screen.getByTitle('Activity Status')).toBeInTheDocument();
 expect(state.legacy).toHaveBeenCalledTimes(1);
 expect(state.bridge).not.toHaveBeenCalled();
});
test.each(['absent','unhealthy','no-widget'])('%s Orb uses connection fallback without legacy v1 feed',async(mode)=>{
 if(mode!=='absent') state.plugins=[{name:'nim-orb',healthy:mode!=='unhealthy',schema_version:'rh.plugin/1',api_base:'/plugins/nim-orb',
 ...(mode==='unhealthy'?{sidebar_widget:{path:'/avatar',height:160}}:{})}];
 const {container}=await sidebar();
 expect(container.querySelectorAll('iframe')).toHaveLength(0);
 expect(screen.getByText('Connection status')).toBeInTheDocument();
 expect(state.legacy).not.toHaveBeenCalled();expect(state.bridge).not.toHaveBeenCalled();
});

test('plugin page uses the registry namespace rather than deriving it from its name',()=>{
 state.plugins=[{name:'my-claw-orb',healthy:true,schema_version:'rh.plugin/1',api_base:'/plugins/host-compiled-orb'}];
 render(<PluginFrame surface="route" pluginName="my-claw-orb" proxyPath="/custom-ui" apiBase="/api" />);
 expect(screen.getByTitle('my-claw-orb plugin')).toHaveAttribute('src','/api/plugins/host-compiled-orb/custom-ui');
 expect(state.bridge).toHaveBeenCalledTimes(1);
});

/* ------------------------------------------------------------------ placement */

test('no widget plugin at all leaves the circle to the legacy avatar and renders no widget section',async()=>{
 state.plugins=[{name:'plain',healthy:true,schema_version:'rh.plugin/1',api_base:'/plugins/plain'}];
 const {container}=await sidebar();
 expect(host(container)).not.toHaveClass('avatar-container--widget');
 expect(host(container).querySelectorAll('iframe')).toHaveLength(0);
 expect(screen.getByText('Connection status')).toBeInTheDocument();
 expect(section(container)).toBeNull();
});

test('a lone Orb widget takes the identity host and the host drops its circular mask',async()=>{
 state.plugins=[ORB];
 const {container}=await sidebar();
 expect(host(container)).toHaveClass('avatar-container--widget');
 expect(host(container).querySelectorAll('iframe')).toHaveLength(1);
 expect(within(host(container)).getByTitle('Activity Status')).toBeInTheDocument();
 expect(screen.queryByText('Connection status')).not.toBeInTheDocument();
 expect(section(container)).toBeNull();
 expect(state.bridge).toHaveBeenCalledTimes(1);
 expect(state.legacy).not.toHaveBeenCalled();
});

/**
 * RED PROOF for the reported defect: before the repair BOTH iframes were flex
 * siblings inside `.avatar-container`, so the first assertion read 2.
 */
test('the Orb and a second widget never share the identity host',async()=>{
 state.plugins=[ORB,USAGE];
 const {container}=await sidebar();
 const circle=host(container);
 const below=section(container)!;
 expect(circle.querySelectorAll('iframe')).toHaveLength(1);
 expect(within(circle).getByTitle('Activity Status')).toBeInTheDocument();
 expect(below).not.toBeNull();
 expect(circle.contains(screen.getByTitle('Usage limits'))).toBe(false);
 expect(below.contains(screen.getByTitle('Usage limits'))).toBe(true);
 expect(container.querySelectorAll('iframe')).toHaveLength(2);
 // ONE bridge per rendered widget, and no legacy status forwarder left running.
 expect(state.bridge).toHaveBeenCalledTimes(2);
 expect(state.legacy).not.toHaveBeenCalled();
 // Each block is named, visibly and for assistive technology.
 const region=screen.getByRole('region',{name:'Usage limits'});
 expect(region.querySelector('.sidebar-plugin-widget-label')).toHaveTextContent('Usage limits');
 expect(region.contains(screen.getByTitle('Usage limits'))).toBe(true);
});

test('a widget plugin with no Orb present leaves the legacy circle alone and renders below it',async()=>{
 state.plugins=[USAGE];
 const {container}=await sidebar();
 expect(host(container)).not.toHaveClass('avatar-container--widget');
 expect(host(container).querySelectorAll('iframe')).toHaveLength(0);
 expect(screen.getByText('Connection status')).toBeInTheDocument();
 expect(within(section(container)!).getByTitle('Usage limits')).toBeInTheDocument();
 expect(state.bridge).toHaveBeenCalledTimes(1);
});

test('the widget section keeps registry order',async()=>{
 state.plugins=[USAGE,ORB,widget('zeta',120)];
 const {container}=await sidebar();
 expect([...section(container)!.querySelectorAll('iframe')].map(f=>f.getAttribute('title')))
  .toEqual(['Usage limits','Zeta']);
 expect(host(container).querySelectorAll('iframe')).toHaveLength(1);
 expect(within(host(container)).getByTitle('Activity Status')).toBeInTheDocument();
});

test('unhealthy and non-v1 plugins reach neither host',async()=>{
 state.plugins=[ORB,{...widget('sick'),healthy:false},
  {name:'legacy-widget',healthy:true,api_base:'/plugins/legacy-widget',sidebar_widget:{path:'/w',height:100}}];
 const {container}=await sidebar();
 expect(container.querySelectorAll('iframe')).toHaveLength(1);
 expect(section(container)).toBeNull();
 expect(state.bridge).toHaveBeenCalledTimes(1);
});

test('a declared widget height is clamped to the 48..240 contract bound',async()=>{
 state.plugins=[ORB,widget('too-tall',999),widget('too-short',1),widget('exact',200)];
 await sidebar();
 expect(screen.getByTitle('Activity Status')).toHaveStyle({height:'160px',width:'100%'});
 expect(screen.getByTitle('Too tall')).toHaveStyle({height:'240px'});
 expect(screen.getByTitle('Too short')).toHaveStyle({height:'48px'});
 expect(screen.getByTitle('Exact')).toHaveStyle({height:'200px'});
});

/* ------------------------------------------------------- geometry and behaviour */

test('a resize into the 961-1279 band leaves both hosts and their bridges alone',async()=>{
 state.plugins=[ORB,USAGE];
 const {container}=await sidebar();
 expect(state.bridge).toHaveBeenCalledTimes(2);
 await act(async()=>{vi.stubGlobal('innerWidth',1000);window.dispatchEvent(new Event('resize'));});
 expect(host(container).querySelectorAll('iframe')).toHaveLength(1);
 expect(within(host(container)).getByTitle('Activity Status')).toBeInTheDocument();
 expect(within(section(container)!).getByTitle('Usage limits')).toBeInTheDocument();
 expect(state.bridge).toHaveBeenCalledTimes(2);
});

test('the 961-1279 band still shrinks the LEGACY circle, which is the only circular rendering left',async()=>{
 vi.stubGlobal('innerWidth',1000);
 const {container}=await sidebar();
 expect(screen.getByText('Connection status')).toHaveAttribute('data-size','64');
 await act(async()=>{vi.stubGlobal('innerWidth',1440);window.dispatchEvent(new Event('resize'));});
 expect(screen.getByText('Connection status')).toHaveAttribute('data-size','120');
 expect(host(container)).not.toHaveClass('avatar-container--widget');
});

/**
 * ORDER CHANGED, deliberately, and this pin changed with it.
 *
 * It used to read "ahead of navigation": secondary widgets were placed between
 * the identity block and the rail's navigation. The 2026-09-18 live audit
 * (defect 5) measured the cost of that placement — identity, the Orb and an
 * empty usage block took the rail's first ~315px, so the CURRENT destination
 * sat below the fold on a 1440x900 desktop and inside the 390px drawer. A
 * widget's height belongs to the plugin (48..240, plugin-host-v1), so the
 * repair had to be order rather than size.
 *
 * What the original pin was protecting is unchanged and still asserted here:
 * every widget is IN the live sidebar, none is inside an `inert` or
 * `aria-hidden` subtree, and none was dropped. Only the direction of the
 * ordering assertion is new.
 */
test('every widget stays in the live sidebar, reachable by keyboard, after navigation',async()=>{
 state.plugins=[ORB,USAGE];
 const {container}=await sidebar();
 const aside=container.querySelector('#sidebar-navigation') as HTMLElement;
 expect(aside).not.toHaveAttribute('inert');
 expect(aside).not.toHaveAttribute('aria-hidden');
 const frames=[...container.querySelectorAll('iframe')];
 expect(frames).toHaveLength(2);
 for(const frame of frames){
  expect(aside.contains(frame)).toBe(true);
  expect(frame.closest('[inert]')).toBeNull();
  expect(frame.closest('[aria-hidden="true"]')).toBeNull();
 }
 const nav=container.querySelector('.sidebar-nav-section')!;
 expect(nav.compareDocumentPosition(section(container)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 // The IDENTITY widget stays above navigation: it is the account's own block.
 const identity=container.querySelector('.sidebar-avatar-section')!;
 expect(identity.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('a secondary widget block opens by default and its label discloses it',async()=>{
 // Live audit 2026-09-18 P2: the repair for vertical prominence is DISCLOSURE,
 // so the default must hide nothing and the frame must survive a collapse.
 state.plugins=[ORB,USAGE];
 await sidebar();
 const toggle=screen.getByRole('button',{name:'Usage limits'});
 expect(toggle).toHaveAttribute('aria-expanded','true');
 const body=document.getElementById(toggle.getAttribute('aria-controls')!)!;
 expect(body).not.toHaveAttribute('inert');
 const frame=within(body).getByTitle('Usage limits');
 await act(async()=>{toggle.click();});
 expect(toggle).toHaveAttribute('aria-expanded','false');
 expect(body).toHaveAttribute('inert');
 expect(body).toHaveAttribute('aria-hidden','true');
 // The SAME frame node, never re-created: the bridge and the declared height hold.
 expect(within(body).getByTitle('Usage limits')).toBe(frame);
 expect(state.bridge).toHaveBeenCalledTimes(2);
 await act(async()=>{toggle.click();});
 expect(toggle).toHaveAttribute('aria-expanded','true');
 expect(body).not.toHaveAttribute('inert');
});

test('the IDENTITY widget carries the same disclosure as every other widget',async()=>{
 // Live audit 2026-09-18 defect 6: the Orb was the one widget a person could
 // not put away. It can now, on the same terms — expanded by default, the frame
 // never unmounted — and the legacy fallback, which is chrome rather than a
 // plugin's telemetry, still carries no control.
 state.plugins=[ORB,USAGE];
 const {container}=await sidebar();
 const toggle=screen.getByRole('button',{name:'Activity Status'});
 expect(toggle).toHaveAttribute('aria-expanded','true');
 const body=document.getElementById(toggle.getAttribute('aria-controls')!)!;
 const frame=within(body).getByTitle('Activity Status');
 expect(body).not.toHaveAttribute('inert');
 await act(async()=>{toggle.click();});
 expect(toggle).toHaveAttribute('aria-expanded','false');
 expect(body).toHaveAttribute('inert');
 expect(body).toHaveAttribute('aria-hidden','true');
 expect(within(body).getByTitle('Activity Status')).toBe(frame);
 // The host box itself is untouched: one widget, and the declared height stands.
 expect(container.querySelectorAll('.avatar-container')).toHaveLength(1);
 expect(frame).toHaveStyle({height:'160px'});
 // Its remembered state is keyed to the WIDGET, not to a placeholder read
 // before the registry arrived: the body id carries the resolved plugin name.
 expect(toggle.getAttribute('aria-controls')).toBe('sidebar-widget-body-nim-orb');
});

test('the legacy identity fallback carries no disclosure control',async()=>{
 state.plugins=[{name:'nim-orb',healthy:true}];
 await sidebar();
 expect(screen.queryByRole('button',{name:'Activity Status'})).not.toBeInTheDocument();
});

test('a collapsed widget choice is remembered per widget, under its OWN key prefix',async()=>{
 // Not `sidebar-group-`: a widget is not a navigation group, and the two name
 // spaces would collide for a plugin sharing a group's id.
 state.plugins=[ORB,USAGE];
 localStorage.setItem('sidebar-widget-usage-limits','1');
 await sidebar();
 expect(screen.getByRole('button',{name:'Usage limits'})).toHaveAttribute('aria-expanded','false');
 expect(screen.getByRole('button',{name:'Activity Status'})).toHaveAttribute('aria-expanded','true');
 expect(localStorage.getItem('sidebar-group-widget-usage-limits')).toBeNull();
});

test('signed-in identity stays visible with plugin widgets present',async()=>{
 state.plugins=[{name:'nim-orb',healthy:true,schema_version:'rh.plugin/1',api_base:'/plugins/nim-orb',sidebar_widget:{path:'/avatar',height:160}}];
 // Owner ruling E21: the row is the avatar, the account name and the bell —
 // the `Signed in as` caption is gone, the name itself stays visible.
 await sidebar();expect(screen.getByText('reader-account')).toBeVisible();expect(screen.queryByText('Signed in as')).not.toBeInTheDocument();
});

test('the identity widget block reads Activity Status, and the legacy name renders nowhere',async()=>{
 // Owner rulings E21 + E24: `Nim Orb` was a legacy name. The disclosure now
 // reads `Activity Status`, which is also its accessible name; nothing the
 // sidebar renders — text, aria-label or title — carries `Nim Orb`/`NimOrb`
 // any more. (`nim-orb` as a PLUGIN ID — the frame src, its `<id> status`
 // frame title and the remembered-state key — is an identifier, not the name.)
 state.plugins=[ORB,USAGE];
 const {container}=await sidebar();
 const toggle=screen.getByRole('button',{name:'Activity Status'});
 expect(toggle.textContent).toBe('Activity Status');
 expect(toggle.closest('.sidebar-avatar-section')).not.toBeNull();
 const named=[container.textContent??'',...Array.from(container.querySelectorAll('[aria-label],[title]'))
  .flatMap(el=>[el.getAttribute('aria-label')??'',el.getAttribute('title')??''])];
 const legacy=/nim\s?orb/i;
 expect(named.filter(text=>legacy.test(text))).toEqual([]);
 // Positive controls, so the absence above can fail: the probe matches both
 // legacy renderings it replaced (`widgetLabel('nim-orb')` and the old legacy
 // frame title), and the collection it scans does carry the new label.
 for(const old of ['Nim orb','NimOrb Avatar']) expect(legacy.test(old)).toBe(true);
 expect(named.some(text=>/activity status/i.test(text))).toBe(true);
});

/* ------------------------------------------------------- E64: accessible names */

/**
 * RED PROOF for owner ruling E64: before the repair the identity frame was
 * named from the plugin id ("nim-orb status"), so the first assertion read
 * that instead of the label a person sees on the disclosure.
 */
test('each widget frame is named by the label a person reads, never by the plugin id',async()=>{
 state.plugins=[ORB,USAGE];
 const {container}=await sidebar();
 const identityFrame=host(container).querySelector('iframe')!;
 const disclosure=container.querySelector('.sidebar-avatar-section .sidebar-plugin-widget-label')!;
 expect(identityFrame.getAttribute('title')).toBe('Activity Status');
 expect(disclosure).toHaveTextContent(identityFrame.getAttribute('title')!);
 const usageFrame=section(container)!.querySelector('iframe')!;
 expect(usageFrame.getAttribute('title')).toBe(screen.getByRole('region',{name:'Usage limits'}).getAttribute('aria-label'));
 for (const frame of container.querySelectorAll('iframe')) {
  expect(frame.getAttribute('title')).not.toMatch(/nim-orb|usage-limits| status$/);
 }
});

/* ------------------------------------------------ E458: the section frame opt-in */

/**
 * Owner ruling E458: the Usage Limits widget drops its visible container and
 * reads as one more sidebar section. The core draws that container for every
 * non-identity widget, so the change is a per-widget OPT-IN,
 * `ui.sidebar_widget.frame: "section"` (strictly the string `section`).
 * Absence and every other value keep today's boxed block, byte for byte.
 */
const framed=(name:string,frame:unknown,height=200)=>({...widget(name,height),sidebar_widget:{path:'/avatar',height,frame}});
const blockMarkup=async(plugins:any[])=>{
 state.plugins=plugins;
 const {container}=await sidebar();
 const html=section(container)!.innerHTML;cleanup();
 return html;
};

test('frame=section renders the widget as a sidebar section: no boxed block, a section heading, the frame under it',async()=>{
 state.plugins=[ORB,framed('usage-limits','section')];
 const {container}=await sidebar();
 const region=screen.getByRole('region',{name:'Usage limits'});
 expect(region).toHaveClass('sidebar-plugin-widget','sidebar-plugin-widget--section');
 const heading=within(region).getByRole('button',{name:'Usage limits'});
 expect(heading).toHaveClass('sidebar-plugin-widget-label','sidebar-plugin-widget-label--section');
 expect(heading).toHaveAttribute('aria-expanded','true');
 const body=document.getElementById(heading.getAttribute('aria-controls')!)!;
 expect(body).toHaveAttribute('id','sidebar-widget-body-usage-limits');
 expect(region.contains(body)).toBe(true);
 expect(within(body).getByTitle('Usage limits')).toHaveStyle({width:'100%',height:'200px'});
 // It stays inside the one widget container, so the compact rail hides it with the others.
 expect(section(container)!.contains(region)).toBe(true);
 // The identity widget is not touched by the opt-in.
 expect(host(container)).toHaveClass('avatar-container--widget');
 expect(container.querySelector('.sidebar-avatar-section .sidebar-plugin-widget-label')).not.toHaveClass('sidebar-plugin-widget-label--section');
});

test('frame=section folds and unfolds, remembers the choice under the same key, and never remounts the frame',async()=>{
 state.plugins=[framed('usage-limits','section')];
 const first=await sidebar();
 const toggle=screen.getByRole('button',{name:'Usage limits'});
 const body=document.getElementById(toggle.getAttribute('aria-controls')!)!;
 const frame=within(body).getByTitle('Usage limits');
 await act(async()=>{toggle.click();});
 expect(toggle).toHaveAttribute('aria-expanded','false');
 expect(body).toHaveAttribute('inert');expect(body).toHaveAttribute('aria-hidden','true');
 expect(body).toHaveClass('sidebar-plugin-widget-body--collapsed');
 expect(within(body).getByTitle('Usage limits')).toBe(frame);
 expect(localStorage.getItem('sidebar-widget-usage-limits')).toBe('1');
 expect(localStorage.getItem('sidebar-group-widget-usage-limits')).toBeNull();
 first.unmount();
 // A fresh mount reads the remembered state.
 await sidebar();
 expect(screen.getByRole('button',{name:'Usage limits'})).toHaveAttribute('aria-expanded','false');
 await act(async()=>{screen.getByRole('button',{name:'Usage limits'}).click();});
 expect(screen.getByRole('button',{name:'Usage limits'})).toHaveAttribute('aria-expanded','true');
 expect(localStorage.getItem('sidebar-widget-usage-limits')).toBe('0');
});

/** RED PROOF for the strictness: a widget without the opt-in is the boxed block it always was. */
test.each([['absent',undefined],['"Section"','Section'],['"SECTION"','SECTION'],['"section "','section '],['true',true],['1',1],['null',null],
 ['an object',{}],['a list',['section']],['"box"','box'],['""','']])(
 'frame %s keeps the boxed block, byte for byte',async(_label,frame)=>{
  const boxed=await blockMarkup([USAGE]);
  expect(boxed).toContain('class="sidebar-plugin-widget"');
  expect(boxed).toContain('class="sidebar-plugin-widget-label"');
  expect(boxed).not.toContain('--section');
  const candidate=frame===undefined?USAGE:framed('usage-limits',frame);
  expect(await blockMarkup([candidate])).toBe(boxed);
 });

test('the opt-in changes only the widget that declares it: a neighbour stays boxed',async()=>{
 state.plugins=[ORB,framed('usage-limits','section'),widget('zeta',120)];
 await sidebar();
 expect(screen.getByRole('region',{name:'Usage limits'})).toHaveClass('sidebar-plugin-widget--section');
 const zeta=screen.getByRole('region',{name:'Zeta'});
 expect(zeta.className).toBe('sidebar-plugin-widget');
 expect(within(zeta).getByRole('button',{name:'Zeta'}).className).toBe('sidebar-plugin-widget-label');
});

test('the identity widget ignores the opt-in: its host and disclosure are byte-identical',async()=>{
 state.plugins=[ORB,USAGE];
 const plain=(await sidebar()).container.querySelector('.sidebar-avatar-section')!.outerHTML;cleanup();
 state.plugins=[{...ORB,sidebar_widget:{...ORB.sidebar_widget,frame:'section'},},USAGE];
 const opted=(await sidebar()).container.querySelector('.sidebar-avatar-section')!.outerHTML;
 expect(opted).toBe(plain);
 expect(opted).not.toContain('--section');
});

test('a section widget renders only inside the widget container the compact rail hides',async()=>{
 state.plugins=[framed('usage-limits','section')];
 const {container}=await sidebar();
 const all=[...container.querySelectorAll('.sidebar-plugin-widget--section')];
 expect(all).toHaveLength(1);
 expect(all[0].closest('.sidebar-plugin-widgets')).toBe(section(container));
});

/* ------------------------------------------------ E465: the section frame has no panel of its own */

/**
 * Owner ruling E465: under the Usage Limits heading the rows sat on a darker panel than the sidebar.
 * Chromium paints an opaque backdrop behind an iframe whose document declares a colour scheme the
 * iframe element does not share, so a section widget's frame is transparent and keeps the element's
 * scheme equal to its document's. The wiring is pinned here; the rules are pinned in
 * Sidebar.geometry.test.ts and the frame's own behaviour in PluginSidebarWidget.test.tsx.
 */
test('E465: the body of a section widget carries the section modifier and its frame is transparent',async()=>{
 state.plugins=[framed('usage-limits','section')];
 await sidebar();
 const heading=screen.getByRole('button',{name:'Usage limits'});
 const body=document.getElementById(heading.getAttribute('aria-controls')!)!;
 expect(body).toHaveClass('sidebar-plugin-widget-body','sidebar-plugin-widget-body--section');
 const frame=within(body).getByTitle('Usage limits');
 expect(frame.style.background).toBe('transparent');
 expect(frame.style.colorScheme).toBe('normal');
});

test('E465: a boxed widget and the identity widget keep their body and frame exactly',async()=>{
 state.plugins=[ORB,USAGE,framed('zeta','box',120)];
 const {container}=await sidebar();
 for(const body of Array.from(container.querySelectorAll('.sidebar-plugin-widget-body'))){
  expect(body.className).toBe('sidebar-plugin-widget-body ');
 }
 for(const frame of Array.from(container.querySelectorAll('iframe'))){
  expect(frame.getAttribute('style')).not.toMatch(/background|color-scheme/);
 }
});
